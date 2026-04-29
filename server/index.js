require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Hard-stop if someone set a live Razorpay key — this build is test-only.
require('./lib/razorpay-guard').assertTestOnly();

const app = express();

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
  next();
});

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

// Practice Room per chapter: /practice/:chapterId
app.get('/practice/:chapterId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/practice-room.html'));
});

// Course experience / marketing page: /experience/:slug
app.get('/experience/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/course-experience.html'));
});

// Legal page aliases (extension-less)
app.get('/privacy',        (req, res) => res.sendFile(path.join(__dirname, '../public/privacy.html')));
app.get('/terms',          (req, res) => res.sendFile(path.join(__dirname, '../public/terms.html')));
app.get('/refund-policy',  (req, res) => res.sendFile(path.join(__dirname, '../public/refund-policy.html')));

// ── Public (no-auth) API for landing pages ──
app.use('/api/public', require('./routes/public.routes'));

// ── Notify-interest (course waitlist signup from landing pages) ──
app.post('/api/notify-interest', async (req, res) => {
  const { email, course, tier, phone, type } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  try {
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'notify-interest.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    existing.push({ email, phone: phone || null, course: course || 'unknown', tier: tier || null, type: type || 'waitlist', at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(existing, null, 2));
    // Push to Google Sheet
    const SHEET_URL = 'https://script.google.com/macros/s/AKfycbyvYH7s7qsQFSh7qF40XIOkabj0Pz4G4cceZ9zIgfeOLfShwsegwSFFwbzh3ghS7LQd/exec';
    fetch(SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone: phone || '', course: course || 'unknown', tier: tier || '', type: type || 'waitlist', timestamp: new Date().toISOString() })
    }).catch(e => console.warn('[sheet] Google Sheet push failed:', e?.message));

    // Try to send admin notification email
    try {
      const mailer = require('./lib/mailer');
      const adminEmail = process.env.ADMIN_EMAIL || 'developers@techinfinity.io';
      await mailer.send({
        to: adminEmail,
        subject: `TFR ${type === 'lead' ? 'Lead' : 'Interest'}: ${course || 'unknown'}${tier ? ' — ' + tier : ''}`,
        html: `<p><strong>${email}</strong>${phone ? ` / ${phone}` : ''} — <strong>${type === 'lead' ? 'Lead' : 'Waitlist'}</strong> for <strong>${course || 'a course'}</strong>${tier ? `, tier: <em>${tier}</em>` : ''}.</p><p>Time: ${new Date().toLocaleString()}</p>`
      });
    } catch (_) { /* mailer optional */ }
    res.json({ ok: true });
  } catch (err) {
    console.error('notify-interest error:', err);
    res.json({ ok: true }); // Always return success to user
  }
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
app.use('/api/recordings', require('./middleware/auth'), require('./routes/recordings.routes'));
app.use('/api/masterclasses', require('./middleware/auth'), require('./routes/masterclasses.routes'));
app.use('/api/submissions', require('./middleware/auth'), require('./routes/submissions.routes'));
app.use('/api/quotes', require('./middleware/auth'), require('./routes/quotes.routes'));
app.use('/api/admin', require('./middleware/auth'), require('./routes/admin.routes'));
app.use('/api/chapters', require('./middleware/auth'), require('./routes/chapters.routes'));
app.use('/api/assignments', require('./middleware/auth'), require('./routes/assignments.routes'));
app.use('/api/materials', require('./middleware/auth'), require('./routes/materials.routes'));
app.use('/api/assets',    require('./middleware/auth'), require('./routes/assets.routes'));
app.use('/api/progress',  require('./middleware/auth'), require('./routes/progress.routes'));
app.use('/api/purchases', require('./middleware/auth'), require('./routes/purchases.routes'));
app.use('/api/pricing',   require('./middleware/auth'), require('./routes/pricing.routes'));
app.use('/api/coupons',   require('./middleware/auth'), require('./routes/coupons.routes'));

// Sprint 1+2: Learning core & communication
app.use('/api/quizzes', require('./middleware/auth'), require('./routes/quiz.routes'));
app.use('/api/notifications', require('./middleware/auth'), require('./routes/notifications.routes'));
app.use('/api/messages', require('./middleware/auth'), require('./routes/messages.routes'));
app.use('/api/profile', require('./middleware/auth'), require('./routes/profile.routes'));

// Sprint 3: Analytics & engagement
app.use('/api/analytics', require('./middleware/auth'), require('./routes/analytics.routes'));
app.use('/api/practice-log', require('./middleware/auth'), require('./routes/practice-log.routes'));
app.use('/api/calendar', require('./middleware/auth'), require('./routes/calendar.routes'));

// Sprint 4+5+6: Monetisation, growth, scale
app.use('/api/payments', require('./middleware/auth'), require('./routes/payments.routes'));
app.use('/api/certificates', require('./middleware/auth'), require('./routes/certificates.routes'));
app.use('/api/live-sessions', require('./middleware/auth'), require('./routes/live-classes.routes'));
app.use('/api/search', require('./middleware/auth'), require('./routes/search.routes'));
app.use('/api/announcements', require('./middleware/auth'), require('./routes/announcements.routes'));
app.use('/api/resources', require('./middleware/auth'), require('./routes/resources.routes'));
app.use('/api/email', require('./middleware/auth'), require('./routes/email.routes'));
app.use('/api/roles', require('./middleware/auth'), require('./routes/roles.routes'));

// Export / Reports (instructor + admin)
app.use('/api/export', require('./middleware/auth'), require('./routes/export.routes'));

// CMS & Blog
app.use('/api/cms', require('./middleware/auth'), require('./routes/cms.routes'));
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
app.listen(PORT, () => console.log(`The Archive LMS running on http://localhost:${PORT}`));
