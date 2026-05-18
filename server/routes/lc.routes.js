// Live Class Booking — all endpoints under /api/lc
//
// Public endpoints (no auth):
//   GET  /api/lc/teachers?instrument=sitar
//   GET  /api/lc/teachers/:slug
//   GET  /api/lc/raags/:teacherSlug/:raagSlug
//   GET  /api/lc/slots/:id
//   POST /api/lc/coupon/validate
//   POST /api/lc/create-order
//   POST /api/lc/verify
//   GET  /api/lc/booking/:id   (sanitised, for thank-you page)
//
// Admin endpoints (auth + role=admin) mounted at /api/lc/admin/*
//
// finalizeLcBooking(orderId) is exported for the webhook handler.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const lcSchema = require('../lib/lc-schema');
const rzpGuard = require('../lib/razorpay-guard');
const mailer = require('../lib/mailer');
const auth = require('../middleware/auth');
const role = require('../middleware/role');

lcSchema.init();

const router = express.Router();

let razorpay = null;
if (rzpGuard.canUseSdk()) {
  try {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  } catch (_) {
    console.warn('[lc] Razorpay SDK not installed — orders will be mocked');
  }
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

// ─────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────

function parseLandingJson(row) {
  if (!row) return row;
  if (row.landing_json) {
    try { row.landing = JSON.parse(row.landing_json); } catch (_) { row.landing = null; }
  }
  delete row.landing_json;
  return row;
}

// GET /api/lc/teachers?instrument=sitar
router.get('/teachers', (req, res) => {
  try {
    const { instrument } = req.query;
    const params = [];
    let sql = `SELECT id, name, slug, bio, photo_url, instrument, landing_json FROM lc_teachers WHERE is_active = 1`;
    if (instrument) { sql += ` AND instrument = ?`; params.push(String(instrument).toLowerCase()); }
    sql += ` ORDER BY sort_order, name`;
    const teachers = db.prepare(sql).all(...params).map(parseLandingJson);
    res.json({ teachers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lc/teachers/:slug  — teacher + raags + grouped upcoming slots
router.get('/teachers/:slug', (req, res) => {
  try {
    const t = parseLandingJson(db.prepare(`
      SELECT id, name, slug, bio, photo_url, instrument, landing_json
      FROM lc_teachers WHERE slug = ? AND is_active = 1
    `).get(req.params.slug));
    if (!t) return res.status(404).json({ error: 'Teacher not found' });

    const raags = db.prepare(`
      SELECT id, name, slug, description, image_url
      FROM lc_raags WHERE teacher_id = ? AND is_active = 1
      ORDER BY sort_order, name
    `).all(t.id);

    // Pull all upcoming slots for this teacher, with price_options + raag context
    const slots = db.prepare(`
      SELECT s.id, s.raag_id, s.title, s.slot_date, s.start_time, s.duration_min,
             s.total_seats, s.booked_seats, (s.total_seats - s.booked_seats) AS seats_left,
             s.is_active
      FROM lc_slots s
      WHERE s.teacher_id = ? AND s.is_active = 1 AND s.slot_date >= ?
      ORDER BY s.slot_date, s.start_time
    `).all(t.id, todayIso());

    // Price min per slot
    const minMap = {};
    if (slots.length) {
      const mins = db.prepare(`
        SELECT slot_id, MIN(amount_paise) AS min_paise
        FROM lc_price_options WHERE slot_id IN (${slots.map(() => '?').join(',')})
        GROUP BY slot_id
      `).all(...slots.map(s => s.id));
      mins.forEach(m => { minMap[m.slot_id] = m.min_paise; });
    }
    slots.forEach(s => { s.from_price_paise = minMap[s.id] || 0; });

    // Group slots by raag_id (and a special "no raag" bucket)
    const groupsByRaag = new Map();
    raags.forEach(r => groupsByRaag.set(r.id, { raag: r, slots: [] }));
    const noRaagBucket = { raag: null, slots: [] };
    slots.forEach(s => {
      if (s.raag_id && groupsByRaag.has(s.raag_id)) groupsByRaag.get(s.raag_id).slots.push(s);
      else noRaagBucket.slots.push(s);
    });
    const groups = [...groupsByRaag.values()];
    if (noRaagBucket.slots.length) groups.push(noRaagBucket);

    res.json({ teacher: t, raags, slots, groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lc/raags/:teacherSlug/:raagSlug
router.get('/raags/:teacherSlug/:raagSlug', (req, res) => {
  try {
    const t = db.prepare(`SELECT * FROM lc_teachers WHERE slug = ? AND is_active = 1`).get(req.params.teacherSlug);
    if (!t) return res.status(404).json({ error: 'Teacher not found' });
    const r = db.prepare(`
      SELECT * FROM lc_raags WHERE teacher_id = ? AND slug = ? AND is_active = 1
    `).get(t.id, req.params.raagSlug);
    if (!r) return res.status(404).json({ error: 'Raag not found' });

    const slots = db.prepare(`
      SELECT id, title, slot_date, start_time, duration_min,
             total_seats, booked_seats, (total_seats - booked_seats) AS seats_left
      FROM lc_slots
      WHERE raag_id = ? AND is_active = 1 AND slot_date >= ?
      ORDER BY slot_date, start_time
    `).all(r.id, todayIso());

    // Cheapest price per slot
    const minPrices = db.prepare(`
      SELECT slot_id, MIN(amount_paise) AS min_paise
      FROM lc_price_options
      WHERE slot_id IN (${slots.map(() => '?').join(',') || 'NULL'})
      GROUP BY slot_id
    `).all(...slots.map(s => s.id));
    const minMap = {};
    minPrices.forEach(p => { minMap[p.slot_id] = p.min_paise; });
    slots.forEach(s => { s.from_price_paise = minMap[s.id] || 0; });

    res.json({ teacher: t, raag: r, slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lc/slots/:id  — slot + teacher + raag + price options
router.get('/slots/:id', (req, res) => {
  try {
    const slot = db.prepare(`
      SELECT s.*, (s.total_seats - s.booked_seats) AS seats_left,
             t.name AS teacher_name, t.slug AS teacher_slug, t.photo_url AS teacher_photo,
             r.name AS raag_name, r.slug AS raag_slug
      FROM lc_slots s
      LEFT JOIN lc_teachers t ON t.id = s.teacher_id
      LEFT JOIN lc_raags r ON r.id = s.raag_id
      WHERE s.id = ? AND s.is_active = 1
    `).get(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    // Strip Meet link from public response (only sent in email after payment)
    delete slot.meet_link;
    delete slot.meet_password;

    const prices = db.prepare(`
      SELECT id, label, amount_paise, description
      FROM lc_price_options WHERE slot_id = ? ORDER BY sort_order, amount_paise
    `).all(slot.id);
    res.json({ slot, price_options: prices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/lc/coupon/validate  body: { code, price_option_id }
router.post('/coupon/validate', express.json(), (req, res) => {
  try {
    const { code, price_option_id } = req.body || {};
    if (!code || !price_option_id) return res.status(400).json({ error: 'code and price_option_id required' });

    const po = db.prepare(`SELECT amount_paise FROM lc_price_options WHERE id = ?`).get(price_option_id);
    if (!po) return res.status(404).json({ error: 'Price option not found' });

    const result = lcSchema.applyCoupon(code, po.amount_paise);
    if (!result.ok) return res.json({ valid: false, reason: result.reason });
    res.json({
      valid: true,
      discount_paise: result.discount_paise,
      final_amount_paise: result.final_paise,
      coupon_id: result.coupon_id
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/lc/create-order
// body: { slot_id, price_option_id, coupon_code?, name, email, phone }
router.post('/create-order', express.json(), async (req, res) => {
  try {
    const { slot_id, price_option_id, coupon_code, name, email, phone } = req.body || {};
    if (!slot_id || !price_option_id || !name || !email || !phone) {
      return res.status(400).json({ error: 'slot_id, price_option_id, name, email, phone required' });
    }

    const slot = db.prepare(`SELECT * FROM lc_slots WHERE id = ? AND is_active = 1`).get(slot_id);
    if (!slot) return res.status(404).json({ error: 'Slot not found or inactive' });
    if (slot.booked_seats >= slot.total_seats) return res.status(409).json({ error: 'Slot is sold out' });

    const po = db.prepare(`SELECT * FROM lc_price_options WHERE id = ? AND slot_id = ?`)
      .get(price_option_id, slot_id);
    if (!po) return res.status(404).json({ error: 'Price option not found' });

    let amount = po.amount_paise;
    let discount = 0;
    let couponId = null;
    if (coupon_code) {
      const r = lcSchema.applyCoupon(coupon_code, amount);
      if (r.ok) {
        amount = r.final_paise;
        discount = r.discount_paise;
        couponId = r.coupon_id;
      }
    }

    // Razorpay rejects amount < 100 paise (₹1). Reject explicitly so error is friendly.
    if (amount < 100) return res.status(400).json({ error: 'Final amount must be at least ₹1' });

    let orderId;
    if (razorpay && rzpGuard.canUseSdk()) {
      const order = await razorpay.orders.create({
        amount,
        currency: 'INR',
        receipt: `lc_${slot.id}_${Date.now()}`.slice(0, 40),
        notes: {
          app: 'lc_booking',
          slot_id: String(slot.id),
          teacher_id: String(slot.teacher_id),
          raag_id: String(slot.raag_id || ''),
          email,
        }
      });
      orderId = order.id;
    } else {
      orderId = `order_mock_${Date.now()}`;
    }

    const userId = (req.headers['authorization'] || '').startsWith('Bearer ')
      ? tryGetUserId(req.headers['authorization'].split(' ')[1])
      : null;

    const ins = db.prepare(`
      INSERT INTO lc_bookings
        (slot_id, price_option_id, coupon_id, user_id, name, email, phone,
         amount_paid_paise, discount_paise, razorpay_order_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(slot.id, po.id, couponId, userId, name.trim(), email.trim().toLowerCase(), phone.trim(),
           amount, discount, orderId);

    res.json({
      order_id: orderId,
      amount,
      discount_paise: discount,
      currency: 'INR',
      key_id: rzpGuard.publicKeyId(),
      booking_id: ins.lastInsertRowid,
      slot: { date: slot.slot_date, time: slot.start_time, duration_min: slot.duration_min }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function tryGetUserId(token) {
  try {
    const jwt = require('jsonwebtoken');
    const d = jwt.verify(token, process.env.JWT_SECRET);
    return d && d.id ? d.id : null;
  } catch (_) { return null; }
}

// POST /api/lc/verify
// body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_id }
router.post('/verify', express.json(), (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_id } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !booking_id) {
      return res.status(400).json({ error: 'razorpay_order_id, razorpay_payment_id, booking_id required' });
    }

    const booking = db.prepare(`SELECT * FROM lc_bookings WHERE id = ? AND razorpay_order_id = ?`)
      .get(booking_id, razorpay_order_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // HMAC signature check (same pattern as payments.routes.js)
    const secret = process.env.RAZORPAY_KEY_SECRET || '';
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSig = secret
      ? crypto.createHmac('sha256', secret).update(body).digest('hex')
      : null;
    const isMock = razorpay_order_id.startsWith('order_mock_');
    const valid = isMock || (!!expectedSig && razorpay_signature && expectedSig === razorpay_signature);
    if (!valid) {
      db.prepare(`UPDATE lc_bookings SET status='failed' WHERE id = ?`).run(booking.id);
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    finalizeLcBooking(razorpay_order_id, razorpay_payment_id);
    res.json({ success: true, booking_id: booking.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Idempotent finaliser — called from /verify AND webhook handler.
// Only the writer that flips status to 'paid' fires side effects (email + seat decrement).
function finalizeLcBooking(orderId, paymentId) {
  const booking = db.prepare(`SELECT * FROM lc_bookings WHERE razorpay_order_id = ?`).get(orderId);
  if (!booking) return false;
  if (booking.status === 'paid') return false;

  const tx = db.transaction(() => {
    const upd = db.prepare(`
      UPDATE lc_bookings
         SET status = 'paid',
             razorpay_payment_id = COALESCE(?, razorpay_payment_id)
       WHERE id = ? AND status != 'paid'
    `).run(paymentId || null, booking.id);
    if (upd.changes === 0) return false;

    db.prepare(`UPDATE lc_slots SET booked_seats = booked_seats + 1 WHERE id = ?`).run(booking.slot_id);
    if (booking.coupon_id) {
      db.prepare(`UPDATE lc_coupons SET used_count = used_count + 1 WHERE id = ?`).run(booking.coupon_id);
    }
    return true;
  });

  const sideEffectsRan = tx();
  if (!sideEffectsRan) return false;

  // Fire-and-forget email with Meet link
  sendBookingConfirmationEmail(booking.id).catch(err =>
    console.warn('[lc] email send failed:', err?.message || err)
  );
  return true;
}

async function sendBookingConfirmationEmail(bookingId) {
  const row = db.prepare(`
    SELECT b.*, s.slot_date, s.start_time, s.duration_min, s.meet_link, s.meet_password,
           t.name AS teacher_name, r.name AS raag_name,
           po.label AS price_label
    FROM lc_bookings b
    LEFT JOIN lc_slots s ON s.id = b.slot_id
    LEFT JOIN lc_teachers t ON t.id = s.teacher_id
    LEFT JOIN lc_raags r ON r.id = s.raag_id
    LEFT JOIN lc_price_options po ON po.id = b.price_option_id
    WHERE b.id = ?
  `).get(bookingId);
  if (!row) return;

  const vars = {
    name: row.name,
    teacher_name: row.teacher_name || '',
    raag_name: row.raag_name || '',
    slot_date: row.slot_date,
    start_time: row.start_time,
    duration_min: row.duration_min || 60,
    meet_link: row.meet_link || '(will be sent shortly)',
    meet_password: row.meet_password || '',
    booking_id: row.id,
    amount_rupees: (row.amount_paid_paise / 100).toFixed(2),
    price_label: row.price_label || ''
  };

  // Try DB template first (admin-editable), fall back to inline.
  let tpl = null;
  try { tpl = db.prepare(`SELECT subject, html_body FROM email_templates WHERE name = ?`).get('lc_booking_confirmed'); } catch (_) {}
  const subjectSrc = tpl?.subject || 'Your live class is confirmed — {{slot_date}} at {{start_time}}';
  const bodySrc = tpl?.html_body || FALLBACK_LC_EMAIL_HTML;

  await mailer.sendTemplate('lc_booking_confirmed', row.email, vars).catch(async () => {
    // If template lookup inside mailer also failed, do a direct send.
    const subject = mergeVars(subjectSrc, vars);
    const html = mergeVars(bodySrc, vars);
    return mailer ? mailer.sendTemplate('lc_booking_confirmed', row.email, vars) : null;
  });
}

function mergeVars(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

const FALLBACK_LC_EMAIL_HTML = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Live class confirmed</title></head>
<body style="margin:0;padding:0;background:#F4EBD0;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:580px;background:#FAF7EE;border-radius:8px;border:1px solid #D1A14E;" cellpadding="0" cellspacing="0">
<tr><td style="background:#1A1208;padding:24px 32px;">
  <p style="margin:0;font-style:italic;font-size:22px;color:#C8A84B;">The Foundation Room</p>
  <p style="margin:4px 0 0;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(200,168,75,0.5);">Live Class Booking</p>
</td></tr>
<tr><td style="padding:32px;color:#4A3C28;line-height:1.7;font-size:15px;">
  <h2 style="font-style:italic;color:#8B2E26;margin:0 0 12px;">Namaste, {{name}}.</h2>
  <p>Your live class has been confirmed. The session details:</p>
  <table cellpadding="6" style="margin:14px 0;border-collapse:collapse;font-size:14px;">
    <tr><td style="color:#9A8A72;">Teacher</td><td><strong>{{teacher_name}}</strong></td></tr>
    <tr><td style="color:#9A8A72;">Raag / Topic</td><td><strong>{{raag_name}}</strong></td></tr>
    <tr><td style="color:#9A8A72;">Date</td><td><strong>{{slot_date}}</strong></td></tr>
    <tr><td style="color:#9A8A72;">Time</td><td><strong>{{start_time}} IST</strong> ({{duration_min}} min)</td></tr>
    <tr><td style="color:#9A8A72;">Plan</td><td>{{price_label}}</td></tr>
    <tr><td style="color:#9A8A72;">Amount paid</td><td>₹{{amount_rupees}}</td></tr>
    <tr><td style="color:#9A8A72;">Booking ID</td><td>#{{booking_id}}</td></tr>
  </table>
  <p style="margin:18px 0 8px;"><strong>Join link (Google Meet):</strong></p>
  <p><a href="{{meet_link}}" style="color:#8B2E26;word-break:break-all;">{{meet_link}}</a></p>
  <p style="font-size:13px;color:#9A8A72;margin-top:20px;">Please join 5 minutes before the start time. If you have trouble accessing the link, reply to this email and we'll help.</p>
</td></tr>
</table></td></tr></table></body></html>`;

// GET /api/lc/booking/:id  — sanitised for thank-you page
router.get('/booking/:id', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT b.id, b.name, b.email, b.amount_paid_paise, b.status, b.created_at,
             s.slot_date, s.start_time, s.duration_min,
             t.name AS teacher_name,
             r.name AS raag_name,
             po.label AS price_label
      FROM lc_bookings b
      LEFT JOIN lc_slots s ON s.id = b.slot_id
      LEFT JOIN lc_teachers t ON t.id = s.teacher_id
      LEFT JOIN lc_raags r ON r.id = s.raag_id
      LEFT JOIN lc_price_options po ON po.id = b.price_option_id
      WHERE b.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES — /api/lc/admin/*  (auth + role=admin)
// ─────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(express.json());
adminRouter.use(auth, role(['admin']));

// ── Teachers ──
adminRouter.get('/teachers', (req, res) => {
  const rows = db.prepare(`SELECT * FROM lc_teachers ORDER BY sort_order, name`).all().map(parseLandingJson);
  res.json({ teachers: rows });
});
adminRouter.post('/teachers', (req, res) => {
  const { name, slug, bio, photo_url, instrument, sort_order = 0, is_active = 1, landing } = req.body || {};
  if (!name || !slug || !instrument) return res.status(400).json({ error: 'name, slug, instrument required' });
  let landingStr = null;
  if (landing) { try { landingStr = JSON.stringify(landing); } catch (_) { return res.status(400).json({ error: 'invalid landing json' }); } }
  try {
    const r = db.prepare(`
      INSERT INTO lc_teachers (name, slug, bio, photo_url, instrument, sort_order, is_active, landing_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), String(slug).trim().toLowerCase(), bio || null, photo_url || null,
           String(instrument).trim().toLowerCase(), Number(sort_order) || 0, is_active ? 1 : 0, landingStr);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.put('/teachers/:id', (req, res) => {
  const { name, slug, bio, photo_url, instrument, sort_order, is_active, landing } = req.body || {};
  let landingStr;
  if (landing !== undefined) {
    if (landing === null) landingStr = null;
    else { try { landingStr = JSON.stringify(landing); } catch (_) { return res.status(400).json({ error: 'invalid landing json' }); } }
  }
  try {
    db.prepare(`
      UPDATE lc_teachers SET name = COALESCE(?, name), slug = COALESCE(?, slug),
        bio = COALESCE(?, bio), photo_url = COALESCE(?, photo_url),
        instrument = COALESCE(?, instrument), sort_order = COALESCE(?, sort_order),
        is_active = COALESCE(?, is_active),
        landing_json = CASE WHEN ? THEN ? ELSE landing_json END
      WHERE id = ?
    `).run(name || null, slug ? slug.toLowerCase() : null, bio || null, photo_url || null,
           instrument ? instrument.toLowerCase() : null,
           sort_order != null ? Number(sort_order) : null,
           is_active != null ? (is_active ? 1 : 0) : null,
           landing !== undefined ? 1 : 0, landingStr !== undefined ? landingStr : null,
           req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.delete('/teachers/:id', (req, res) => {
  db.prepare(`DELETE FROM lc_teachers WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Raags ──
adminRouter.get('/raags', (req, res) => {
  const teacherId = req.query.teacher_id;
  const rows = teacherId
    ? db.prepare(`SELECT * FROM lc_raags WHERE teacher_id = ? ORDER BY sort_order, name`).all(teacherId)
    : db.prepare(`SELECT r.*, t.name AS teacher_name FROM lc_raags r LEFT JOIN lc_teachers t ON t.id = r.teacher_id ORDER BY t.name, r.sort_order, r.name`).all();
  res.json({ raags: rows });
});
adminRouter.post('/raags', (req, res) => {
  const { teacher_id, name, slug, description, image_url, sort_order = 0, is_active = 1 } = req.body || {};
  if (!teacher_id || !name || !slug) return res.status(400).json({ error: 'teacher_id, name, slug required' });
  try {
    const r = db.prepare(`
      INSERT INTO lc_raags (teacher_id, name, slug, description, image_url, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(teacher_id, name.trim(), String(slug).trim().toLowerCase(), description || null,
           image_url || null, Number(sort_order) || 0, is_active ? 1 : 0);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.put('/raags/:id', (req, res) => {
  const { name, slug, description, image_url, sort_order, is_active } = req.body || {};
  db.prepare(`
    UPDATE lc_raags SET name = COALESCE(?, name), slug = COALESCE(?, slug),
      description = COALESCE(?, description), image_url = COALESCE(?, image_url),
      sort_order = COALESCE(?, sort_order),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(name || null, slug ? slug.toLowerCase() : null, description || null, image_url || null,
         sort_order != null ? Number(sort_order) : null,
         is_active != null ? (is_active ? 1 : 0) : null,
         req.params.id);
  res.json({ ok: true });
});
adminRouter.delete('/raags/:id', (req, res) => {
  db.prepare(`DELETE FROM lc_raags WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Slots ──
adminRouter.get('/slots', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, t.name AS teacher_name, r.name AS raag_name,
           (s.total_seats - s.booked_seats) AS seats_left
    FROM lc_slots s
    LEFT JOIN lc_teachers t ON t.id = s.teacher_id
    LEFT JOIN lc_raags r ON r.id = s.raag_id
    ORDER BY s.slot_date DESC, s.start_time DESC
  `).all();
  // Attach price options
  const ids = rows.map(s => s.id);
  let priceMap = {};
  if (ids.length) {
    const prices = db.prepare(`
      SELECT * FROM lc_price_options WHERE slot_id IN (${ids.map(() => '?').join(',')})
      ORDER BY sort_order, amount_paise
    `).all(...ids);
    prices.forEach(p => { (priceMap[p.slot_id] ||= []).push(p); });
  }
  rows.forEach(s => { s.price_options = priceMap[s.id] || []; });
  res.json({ slots: rows });
});
adminRouter.get('/slots/:id', (req, res) => {
  const slot = db.prepare(`SELECT * FROM lc_slots WHERE id = ?`).get(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Not found' });
  const prices = db.prepare(`SELECT * FROM lc_price_options WHERE slot_id = ? ORDER BY sort_order, amount_paise`).all(slot.id);
  res.json({ slot, price_options: prices });
});
adminRouter.post('/slots', (req, res) => {
  const { teacher_id, raag_id, title, slot_date, start_time, duration_min = 60,
          total_seats, meet_link, meet_password, is_active = 1, price_options = [] } = req.body || {};
  if (!teacher_id || !slot_date || !start_time || !total_seats) {
    return res.status(400).json({ error: 'teacher_id, slot_date, start_time, total_seats required' });
  }
  try {
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO lc_slots (teacher_id, raag_id, title, slot_date, start_time, duration_min,
          total_seats, meet_link, meet_password, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(teacher_id, raag_id || null, title || null, slot_date, start_time,
             Number(duration_min) || 60, Number(total_seats), meet_link || null,
             meet_password || null, is_active ? 1 : 0);
      const slotId = r.lastInsertRowid;
      const insPrice = db.prepare(`
        INSERT INTO lc_price_options (slot_id, label, amount_paise, description, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `);
      (price_options || []).forEach((p, i) => {
        if (!p.label || p.amount_paise == null) return;
        insPrice.run(slotId, p.label, Number(p.amount_paise), p.description || null, p.sort_order != null ? Number(p.sort_order) : i);
      });
      return slotId;
    });
    res.json({ id: tx() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.put('/slots/:id', (req, res) => {
  const { teacher_id, raag_id, title, slot_date, start_time, duration_min, total_seats,
          meet_link, meet_password, is_active, price_options } = req.body || {};
  try {
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE lc_slots SET
          teacher_id = COALESCE(?, teacher_id),
          raag_id = COALESCE(?, raag_id),
          title = COALESCE(?, title),
          slot_date = COALESCE(?, slot_date),
          start_time = COALESCE(?, start_time),
          duration_min = COALESCE(?, duration_min),
          total_seats = COALESCE(?, total_seats),
          meet_link = COALESCE(?, meet_link),
          meet_password = COALESCE(?, meet_password),
          is_active = COALESCE(?, is_active)
        WHERE id = ?
      `).run(teacher_id || null, raag_id !== undefined ? raag_id : null, title !== undefined ? title : null,
             slot_date || null, start_time || null,
             duration_min != null ? Number(duration_min) : null,
             total_seats != null ? Number(total_seats) : null,
             meet_link !== undefined ? meet_link : null,
             meet_password !== undefined ? meet_password : null,
             is_active != null ? (is_active ? 1 : 0) : null,
             req.params.id);

      if (Array.isArray(price_options)) {
        db.prepare(`DELETE FROM lc_price_options WHERE slot_id = ?`).run(req.params.id);
        const ins = db.prepare(`
          INSERT INTO lc_price_options (slot_id, label, amount_paise, description, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `);
        price_options.forEach((p, i) => {
          if (!p.label || p.amount_paise == null) return;
          ins.run(req.params.id, p.label, Number(p.amount_paise), p.description || null, p.sort_order != null ? Number(p.sort_order) : i);
        });
      }
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.delete('/slots/:id', (req, res) => {
  db.prepare(`DELETE FROM lc_slots WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Bookings ──
adminRouter.get('/bookings', (req, res) => {
  const { slot_id, status, date_from, date_to } = req.query;
  const where = [];
  const params = [];
  if (slot_id)   { where.push('b.slot_id = ?'); params.push(slot_id); }
  if (status)    { where.push('b.status = ?');  params.push(status); }
  if (date_from) { where.push('s.slot_date >= ?'); params.push(date_from); }
  if (date_to)   { where.push('s.slot_date <= ?'); params.push(date_to); }
  const sql = `
    SELECT b.*, s.slot_date, s.start_time,
           t.name AS teacher_name, r.name AS raag_name,
           po.label AS price_label, co.code AS coupon_code
    FROM lc_bookings b
    LEFT JOIN lc_slots s ON s.id = b.slot_id
    LEFT JOIN lc_teachers t ON t.id = s.teacher_id
    LEFT JOIN lc_raags r ON r.id = s.raag_id
    LEFT JOIN lc_price_options po ON po.id = b.price_option_id
    LEFT JOIN lc_coupons co ON co.id = b.coupon_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.created_at DESC
  `;
  const rows = db.prepare(sql).all(...params);
  res.json({ bookings: rows });
});
adminRouter.get('/bookings/export.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.created_at, b.name, b.email, b.phone, b.amount_paid_paise, b.discount_paise,
           b.status, b.razorpay_payment_id,
           t.name AS teacher_name, r.name AS raag_name,
           s.slot_date, s.start_time, po.label AS price_label, co.code AS coupon_code
    FROM lc_bookings b
    LEFT JOIN lc_slots s ON s.id = b.slot_id
    LEFT JOIN lc_teachers t ON t.id = s.teacher_id
    LEFT JOIN lc_raags r ON r.id = s.raag_id
    LEFT JOIN lc_price_options po ON po.id = b.price_option_id
    LEFT JOIN lc_coupons co ON co.id = b.coupon_id
    ORDER BY b.created_at DESC
  `).all();
  const header = ['id','created_at','name','email','phone','amount_rupees','discount_rupees','status',
                  'payment_id','teacher','raag','date','time','plan','coupon'];
  const csv = [header.join(',')].concat(rows.map(r => [
    r.id, r.created_at, csvCell(r.name), csvCell(r.email), csvCell(r.phone),
    ((r.amount_paid_paise || 0) / 100).toFixed(2),
    ((r.discount_paise || 0) / 100).toFixed(2),
    r.status, csvCell(r.razorpay_payment_id),
    csvCell(r.teacher_name), csvCell(r.raag_name),
    r.slot_date, r.start_time, csvCell(r.price_label), csvCell(r.coupon_code)
  ].join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="lc-bookings.csv"');
  res.send(csv);
});
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Coupons ──
adminRouter.get('/coupons', (req, res) => {
  res.json({ coupons: db.prepare(`SELECT * FROM lc_coupons ORDER BY created_at DESC`).all() });
});
adminRouter.post('/coupons', (req, res) => {
  const { code, discount_type, discount_value, max_uses, expires_at, is_active = 1 } = req.body || {};
  if (!code || !discount_type || discount_value == null) {
    return res.status(400).json({ error: 'code, discount_type, discount_value required' });
  }
  if (!['pct', 'flat'].includes(discount_type)) return res.status(400).json({ error: 'discount_type must be pct or flat' });
  try {
    const r = db.prepare(`
      INSERT INTO lc_coupons (code, discount_type, discount_value, max_uses, expires_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(code).trim().toUpperCase(), discount_type, Number(discount_value),
           max_uses ? Number(max_uses) : null, expires_at || null, is_active ? 1 : 0);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.put('/coupons/:id', (req, res) => {
  const { discount_value, max_uses, expires_at, is_active } = req.body || {};
  db.prepare(`
    UPDATE lc_coupons SET
      discount_value = COALESCE(?, discount_value),
      max_uses = COALESCE(?, max_uses),
      expires_at = COALESCE(?, expires_at),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(discount_value != null ? Number(discount_value) : null,
         max_uses != null ? Number(max_uses) : null,
         expires_at != null ? expires_at : null,
         is_active != null ? (is_active ? 1 : 0) : null,
         req.params.id);
  res.json({ ok: true });
});
adminRouter.delete('/coupons/:id', (req, res) => {
  db.prepare(`DELETE FROM lc_coupons WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── Stats for admin dashboard widget ──
adminRouter.get('/stats', (req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_bookings,
      COUNT(CASE WHEN status='paid' THEN 1 END) AS paid_bookings,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount_paid_paise ELSE 0 END), 0) AS revenue_paise
    FROM lc_bookings
  `).get();
  const today = todayIso();
  const todayStats = db.prepare(`
    SELECT COUNT(*) AS bookings,
           COALESCE(SUM(amount_paid_paise), 0) AS revenue_paise
    FROM lc_bookings
    WHERE status = 'paid' AND DATE(created_at) = ?
  `).get(today);
  const monthStats = db.prepare(`
    SELECT COUNT(*) AS bookings,
           COALESCE(SUM(amount_paid_paise), 0) AS revenue_paise
    FROM lc_bookings
    WHERE status = 'paid' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get();
  res.json({ totals, today: todayStats, month: monthStats });
});

router.use('/admin', adminRouter);

module.exports = router;
module.exports.finalizeLcBooking = finalizeLcBooking;
