require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Fail-loud check on JWT_SECRET — placeholders or under-32-char secrets allow
// trivial token forgery. Better to refuse to boot than to silently mint
// insecure tokens.
(function assertJwtSecret() {
  const v = process.env.JWT_SECRET || "";
  const hints = ["change-me", "replace_with", "replace-with", "your-secret", "changeme"];
  const placeholder = hints.some(h => v.toLowerCase().includes(h));
  if (v.length < 32 || placeholder) {
    console.error("FATAL: JWT_SECRET missing, placeholder, or under 32 chars.");
    process.exit(1);
  }
})();

// Hard-stop if someone set a live Razorpay key — this build is test-only.
require('./lib/razorpay-guard').assertTestOnly();

const app = express();

// Trust Nginx reverse proxy — required for express-rate-limit to read X-Forwarded-For correctly
app.set('trust proxy', 1);

// Ensure data dirs exist
const uploadDir = process.env.UPLOAD_DIR || './data/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const certDir = path.join(__dirname, '../data/certificates');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

// CORS — reads ALLOWED_ORIGINS (comma-separated) from env.
// Falls back to FRONTEND_URL, then to permissive open mode for local dev.
const _rawOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '').trim();
const _allowedOrigins = _rawOrigins
  ? _rawOrigins.split(',').map(o => o.trim()).filter(Boolean)
  : [];

app.use(cors({
  origin: _allowedOrigins.length === 0
    ? true  // dev: allow all
    : (origin, cb) => {
        // Allow server-to-server requests (no Origin header) and listed origins
        if (!origin || _allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
      },
  credentials: true,
}));

// Security headers on all responses
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // HSTS — site is HTTPS-only via Nginx; tell browsers to never downgrade.
  // 1-year max-age, includeSubDomains. Preload omitted (not registered).
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // CSP in report-only mode so we can observe violations before enforcing.
  // Scope is intentionally lax for now (allow inline scripts/styles since
  // the existing pages use them heavily). Tighten by removing 'unsafe-inline'
  // once we see clean reports for a few days.
  // 'self' + Razorpay (checkout iframe + JS) + Wasabi (presigned URLs) +
  // Google (Meet, fonts) + the ZeptoMail tracker pixels.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://api.razorpay.com https://cdn.jsdelivr.net https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: ",
    "connect-src 'self' https://api.razorpay.com https://*.wasabisys.com https://script.google.com",
    "frame-src 'self' https://api.razorpay.com https://*.razorpay.com https://meet.google.com https://www.youtube.com",
    "media-src 'self' blob: https://*.wasabisys.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://api.razorpay.com",
  ].join('; ');
  res.setHeader('Content-Security-Policy-Report-Only', csp);

  next();
});

// Rate limiters — slow down brute force on credential-bearing endpoints and
// prevent abuse of public lead-capture. Applied before auth route mounts below.
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 10,                    // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a few minutes.' },
});
const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions — try again later.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/notify-interest', leadLimiter);

// ── Razorpay webhook — MUST be mounted BEFORE the global JSON body parser so
//    the raw body is intact for HMAC verification. No-auth by design (Razorpay
//    won't send a JWT); the route does its own signature check. ──
app.use('/api/webhooks', require('./routes/webhooks.routes'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Root & named routes (declared BEFORE express.static) ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/signin.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/signin.html'));
});

// ── SEO-friendly course URLs: /courses/:slug ──
// /courses → courses.html (static file, served by express.static)
// /courses/sitar-the-complete-foundation → course-landing.html (JS reads slug from pathname)
app.get('/courses/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/course-landing.html'));
});

// Practice Room removed — redirect to home
app.get('/practice/:chapterId', (req, res) => {
  res.redirect('/');
});

// Course experience page removed — redirect to home
app.get('/experience/:slug', (req, res) => {
  res.redirect('/');
});

// Legal page aliases (extension-less)
app.get('/privacy',        (req, res) => res.sendFile(path.join(__dirname, '../public/privacy.html')));
app.get('/terms',          (req, res) => res.sendFile(path.join(__dirname, '../public/terms.html')));
app.get('/refund-policy',  (req, res) => res.sendFile(path.join(__dirname, '../public/refund-policy.html')));

// ── Public (no-auth) API for landing pages ──
app.use('/api/public', require('./routes/public.routes'));

// ── Integrations: Google OAuth callback is public (browser redirect from
//    Google), other endpoints in this router enforce auth themselves. ──
// app.use('/api/integrations', — removed: no active UI

// ── Notify-interest (course waitlist signup from landing pages) ──
app.post('/api/notify-interest', async (req, res) => {
  const { email, course, tier, phone, type } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  // Always respond OK to the client — never block on side effects.
  // Side effects (DB write, Sheets push, admin email, auto-response) all run
  // best-effort with try/catch so a single failure doesn't cascade.
  const recordedAt = new Date().toISOString();
  const payload = {
    email,
    phone: phone || null,
    course: course || 'unknown',
    tier: tier || null,
    type: type || 'waitlist',
    at: recordedAt,
  };
  const sourceIp = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500);

  // 1. Persist to DB (primary). Fall back to JSON file if DB write fails.
  let rowId = null;
  try {
    const db = require('./db');
    const r = db.prepare(`
      INSERT INTO notify_interest (email, phone, course, tier, type, source_ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(payload.email, payload.phone, payload.course, payload.tier, payload.type, sourceIp || null, userAgent || null, recordedAt);
    rowId = r.lastInsertRowid;
  } catch (e) {
    console.error('[notify-interest] DB write failed, falling back to JSON file:', e.message);
    try {
      const dataDir = path.join(__dirname, '../data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, 'notify-interest.fallback.json');
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      existing.push(payload);
      fs.writeFileSync(file, JSON.stringify(existing, null, 2));
    } catch (e2) {
      console.error('[notify-interest] fallback JSON also failed:', e2.message);
    }
  }

  // 2. Google Sheets push (legacy mirror — keep for now)
  const SHEET_URL = 'https://script.google.com/macros/s/AKfycbyvYH7s7qsQFSh7qF40XIOkabj0Pz4G4cceZ9zIgfeOLfShwsegwSFFwbzh3ghS7LQd/exec';
  fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, phone: phone || '', course: course || 'unknown', tier: tier || '', type: type || 'waitlist', timestamp: recordedAt })
  }).catch(e => console.warn('[sheet] Google Sheet push failed:', e?.message));

  // 3. Admin notification email — defaults to mail@tfrplay.com per May 5 meeting.
  (async () => {
    try {
      const mailer = require('./lib/mailer');
      const adminEmail = process.env.ADMIN_EMAIL || 'mail@tfrplay.com';
      await mailer.send({
        to: adminEmail,
        subject: `TFR ${type === 'lead' ? 'Lead' : 'Interest'}: ${course || 'unknown'}${tier ? ' — ' + tier : ''}`,
        html: `<p><strong>${email}</strong>${phone ? ` / ${phone}` : ''} — <strong>${type === 'lead' ? 'Lead' : 'Waitlist'}</strong> for <strong>${course || 'a course'}</strong>${tier ? `, tier: <em>${tier}</em>` : ''}.</p><p>Time: ${new Date().toLocaleString()}</p>`
      });
      if (rowId) {
        const db = require('./db');
        db.prepare(`UPDATE notify_interest SET admin_notified_at = datetime('now') WHERE id = ?`).run(rowId);
      }
    } catch (e) {
      console.warn('[notify-interest] admin email failed:', e?.message);
    }
  })();

  // 4. User auto-response — uses the 'waitlist_welcome' template seeded in db.js.
  //    Best-effort; if template missing or mailer down, the user still got the
  //    success response and is in the DB.
  (async () => {
    try {
      const db = require('./db');
      const tmpl = db.prepare(`SELECT subject, html_body FROM email_templates WHERE name = ?`).get('waitlist_welcome');
      if (!tmpl) return; // no template configured yet
      const mailer = require('./lib/mailer');
      const courseLabel = course || 'an upcoming program';
      const html = (tmpl.html_body || '').replace(/\{\{\s*course\s*\}\}/g, courseLabel);
      const subject = (tmpl.subject || 'Welcome to The Foundation Room').replace(/\{\{\s*course\s*\}\}/g, courseLabel);
      await mailer.send({ to: email, subject, html });
      if (rowId) {
        db.prepare(`UPDATE notify_interest SET responded_at = datetime('now') WHERE id = ?`).run(rowId);
      }
    } catch (e) {
      console.warn('[notify-interest] user auto-response failed:', e?.message);
    }
  })();

  res.json({ ok: true });
});

// ── POST /api/lead — authenticated lead capture (pulls email+phone from DB) ──
app.post('/api/lead', require('./middleware/auth'), async (req, res) => {
  try {
    const db = require('./db');
    const user = db.prepare('SELECT u.email, u.first_name, u.last_name, up.phone FROM users u LEFT JOIN user_profile up ON up.user_id = u.id WHERE u.id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { course } = req.body || {};
    const courseLabel = 'Lead';

    // Save locally
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'notify-interest.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    existing.push({ email: user.email, phone: user.phone || null, course: courseLabel, type: 'lead', at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(existing, null, 2));

    // Push to Google Sheet
    const SHEET_URL = 'https://script.google.com/macros/s/AKfycbyvYH7s7qsQFSh7qF40XIOkabj0Pz4G4cceZ9zIgfeOLfShwsegwSFFwbzh3ghS7LQd/exec';
    fetch(SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, phone: user.phone || '', course: courseLabel, type: 'lead', timestamp: new Date().toISOString() })
    }).catch(e => console.warn('[sheet] lead push failed:', e?.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[/api/lead]', err);
    res.status(500).json({ error: err.message });
  }
});

// Static files — never cache HTML, so admin-page changes propagate immediately
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

// Wasabi-backed file redirect (presigned URLs). Legacy rows with /uploads/... still resolve above.
app.use('/api/files', require('./routes/files.routes'));

// Secure video streaming — stream endpoint uses a signed token in the path (no Bearer header);
// the token endpoint itself requires Bearer auth (handled inside the router).
app.use('/api/video', require('./routes/video.routes'));

// Mount routes
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/courses', require('./middleware/auth'), require('./routes/courses.routes'));
app.use('/api/enrollments', require('./middleware/auth'), require('./routes/enrollments.routes'));
app.use('/api/lessons', require('./middleware/auth'), require('./routes/lessons.routes'));
app.use('/api/sheet-music', require('./middleware/auth'), require('./routes/sheetmusic.routes'));
// app.use('/api/recordings', — removed: no active UI
// app.use('/api/masterclasses', — removed: no active UI
app.use('/api/submissions', require('./middleware/auth'), require('./routes/submissions.routes'));
app.use('/api/practice-materials', require('./middleware/auth'), require('./routes/practice-materials.routes'));
// app.use('/api/practice-uploads', — removed: practice-room-upload page removed
// app.use('/api/quotes',   — removed: no active UI
app.use('/api/admin', require('./middleware/auth'), require('./routes/admin.routes'));
app.use('/api/chapters', require('./middleware/auth'), require('./routes/chapters.routes'));
// app.use('/api/assignments', — removed: no active UI
app.use('/api/materials', require('./middleware/auth'), require('./routes/materials.routes'));
app.use('/api/assets',    require('./middleware/auth'), require('./routes/assets.routes'));
app.use('/api/progress',  require('./middleware/auth'), require('./routes/progress.routes'));
app.use('/api/purchases', require('./middleware/auth'), require('./routes/purchases.routes'));
app.use('/api/pricing',   require('./middleware/auth'), require('./routes/pricing.routes'));
app.use('/api/coupons',   require('./middleware/auth'), require('./routes/coupons.routes'));

// Active: Learning core & communication
// app.use('/api/quizzes', — removed: no active UI
app.use('/api/notifications', require('./middleware/auth'), require('./routes/notifications.routes'));
// app.use('/api/messages', — removed: messaging feature not active
app.use('/api/profile', require('./middleware/auth'), require('./routes/profile.routes'));

// Active: Practice & engagement
// app.use('/api/analytics', — removed: no active UI
app.use('/api/practice-log', require('./middleware/auth'), require('./routes/practice-log.routes'));
// app.use('/api/calendar', — removed: Google OAuth not configured

// Active: Monetisation & live classes
app.use('/api/payments', require('./middleware/auth'), require('./routes/payments.routes'));
// app.use('/api/certificates', — removed: no certs issued yet
app.use('/api/live-sessions', require('./middleware/auth'), require('./routes/live-classes.routes'));
// app.use('/api/search', — removed: search page removed
app.use('/api/announcements', require('./middleware/auth'), require('./routes/announcements.routes'));
// app.use('/api/resources', — removed: resources page removed
app.use('/api/support-links', require('./middleware/auth'), require('./routes/support-links.routes'));
// app.use('/api/email', — removed: email automation not active
// app.use('/api/roles', — removed: handled in admin panel directly

// app.use('/api/export', — removed: reports page removed

// Blog (no CMS, blog posts managed via admin panel)
// app.use('/api/cms', — removed: CMS page removed
// Admin blog endpoints need JWT so req.user is populated for adminOnly — public endpoints stay open.
app.use('/api/blog/admin', require('./middleware/auth'));
app.use('/api/blog', require('./routes/blog.routes'));

// SPA fallback — serve home for non-API, non-file routes.
// /api/* requests that fall through get a proper JSON 404 instead of a masked HTML response.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found', path: req.path });
  }
  const file = path.join(__dirname, '../public', req.path);
  if (require('fs').existsSync(file)) {
    res.sendFile(file);
  } else {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`The Archive LMS running on http://localhost:${PORT}`);
  // 30-min pre-class email reminder background job
  try { require('./jobs/class-reminder').start(); } catch (e) { console.warn('[boot] class-reminder job failed to start:', e.message); }
});
