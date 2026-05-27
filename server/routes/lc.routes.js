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

// SECURE_ROOM_V1 — random unguessable token for each Jitsi room
function generateRoomToken() { return crypto.randomBytes(10).toString('hex'); }
function jitsiUrlForSlot(slotId) {
  // Pull existing token if any, else create + persist
  const row = db.prepare('SELECT room_token FROM lc_slots WHERE id = ?').get(slotId);
  let tok = row && row.room_token;
  if (!tok) {
    tok = generateRoomToken();
    try { db.prepare('UPDATE lc_slots SET room_token = ? WHERE id = ?').run(tok, slotId); } catch (_) {}
  }
  return 'https://meet.tfrplay.com/tfr-' + tok;
}

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

    // LEGACY_SESSIONS_MERGE_V1 — also pull live_sessions created by this teacher (OLD instructor portal)
    // so anything Niladri creates via the legacy "Schedule Session" button also appears on his public page.
    if (t.user_id || true) {
      // Look up legacy sessions either by linked user_id, or fallback to instructor email match
      const tUser = db.prepare('SELECT user_id FROM lc_teachers WHERE id = ?').get(t.id);
      const legacyOwnerId = tUser && tUser.user_id;
      if (legacyOwnerId) {
        const todayDate = todayIso();
        const legacy = db.prepare(`
          SELECT id, title, scheduled_at, duration_minutes, max_participants,
                 (SELECT COUNT(*) FROM live_session_attendees WHERE session_id = live_sessions.id) AS attendees
          FROM live_sessions
          WHERE instructor_id = ? AND status != 'completed' AND substr(scheduled_at,1,10) >= ?
          ORDER BY scheduled_at
        `).all(legacyOwnerId, todayDate);
        legacy.forEach(ls => {
          const d = new Date(ls.scheduled_at);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth()+1).padStart(2,'0');
          const dd = String(d.getDate()).padStart(2,'0');
          const hh = String(d.getHours()).padStart(2,'0');
          const mi = String(d.getMinutes()).padStart(2,'0');
          slots.push({
            id: 'ls-' + ls.id,        // virtual id (prefix to avoid clash with lc_slots)
            source: 'live_session',
            raag_id: null,
            title: ls.title,
            slot_date: `${yyyy}-${mm}-${dd}`,
            start_time: `${hh}:${mi}`,
            duration_min: ls.duration_minutes || 60,
            total_seats: ls.max_participants || 50,
            booked_seats: ls.attendees || 0,
            seats_left: (ls.max_participants || 50) - (ls.attendees || 0),
            is_active: 1,
            from_price_paise: 0       // legacy = free session
          });
        });
      }
    }

    // Re-sort slots chronologically after merge
    slots.sort((a,b) => (a.slot_date + ' ' + a.start_time).localeCompare(b.slot_date + ' ' + b.start_time));

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
    // amount can be 0 (e.g. 100% coupon) - skip Razorpay below

    let orderId;
    let isFreeOrder = amount === 0;
    if (isFreeOrder) {
      orderId = `order_free_${Date.now()}`;
    } else if (razorpay && rzpGuard.canUseSdk()) {
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

    // FREE_BOOKING_AUTOFINALIZE_V1 — ₹0 orders skip Razorpay → auto-finalize immediately
    if (isFreeOrder) {
      try { finalizeLcBooking(orderId, 'free_' + Date.now()); }
      catch (e) { console.warn('[lc] auto-finalize free booking failed:', e.message); }
    }

    res.json({
      order_id: orderId,
      is_free: isFreeOrder,
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
    const isMock = razorpay_order_id.startsWith('order_mock_') || razorpay_order_id.startsWith('order_free_');
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

  // EMAIL_WRAP_LINK_V1 — give the user a TFR-domain wrapper that opens the in-dashboard classroom,
  // not the raw Jitsi URL. The classroom page time-gates the join.
  const publicBase = process.env.PUBLIC_BASE_URL || 'https://tfrplay.com';
  const joinUrl = publicBase + '/live-class-room.html?b=' + row.id;

  const vars = {
    name: row.name,
    teacher_name: row.teacher_name || '',
    raag_name: row.raag_name || '',
    slot_date: row.slot_date,
    start_time: row.start_time,
    duration_min: row.duration_min || 60,
    meet_link: joinUrl,                     // wrapped link — actual Jitsi URL never exposed in email
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
    <tr><td style="color:#9A8A72;">Date</td><td><strong>{{slot_date}}</strong></td></tr>
    <tr><td style="color:#9A8A72;">Time</td><td><strong>{{start_time}} IST</strong> ({{duration_min}} min)</td></tr>
    <tr><td style="color:#9A8A72;">Plan</td><td>{{price_label}}</td></tr>
    <tr><td style="color:#9A8A72;">Amount paid</td><td>₹{{amount_rupees}}</td></tr>
    <tr><td style="color:#9A8A72;">Booking ID</td><td>#{{booking_id}}</td></tr>
  </table>
  <p style="margin:18px 0 8px;text-align:center;">
    <a href="{{meet_link}}" style="display:inline-block;padding:14px 28px;background:#8B2E26;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;font-size:13px;">Open Live Class Room &rarr;</a>
  </p>
  <p style="font-size:13px;color:#9A8A72;margin-top:18px;text-align:center;">
    The Join button unlocks <strong>10 minutes before</strong> your scheduled time. The class opens inside your dashboard — no external app required.
  </p>
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
  const rows = db.prepare(`
    SELECT t.*, u.email AS linked_email, u.first_name AS linked_first_name, u.last_name AS linked_last_name
    FROM lc_teachers t LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.sort_order, t.name
  `).all().map(parseLandingJson);
  res.json({ teachers: rows });
});

// GET /api/lc/admin/instructors — list instructor users for the "Link Login" dropdown
adminRouter.get('/instructors', (req, res) => {
  const rows = db.prepare(`SELECT id, email, first_name, last_name FROM users WHERE role = 'instructor' ORDER BY first_name, last_name`).all();
  res.json({ instructors: rows });
});

// POST /api/lc/admin/teachers/:id/link-user — TEACHER_LOGIN_V1
// body: { email, password?, first_name?, last_name?, create_if_missing? }
// Finds existing instructor user by email, or creates one (role=instructor) when create_if_missing.
adminRouter.post('/teachers/:id/link-user', (req, res) => {
  try {
    const tId = Number(req.params.id);
    const { email, password, first_name, last_name, create_if_missing } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const cleanEmail = String(email).trim().toLowerCase();
    let user = db.prepare('SELECT id, email, role FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (!user) {
      if (!create_if_missing) return res.status(404).json({ error: 'User not found. Tick create_if_missing or pre-create from admin users panel.' });
      if (!password || password.length < 6) return res.status(400).json({ error: 'password (min 6 chars) required to create user' });
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(password, 10);
      const fn = (first_name && first_name.trim()) || cleanEmail.split('@')[0];
      const ln = (last_name && last_name.trim()) || 'Teacher';
      const r = db.prepare(`
        INSERT INTO users (email, password_hash, first_name, last_name, role, verified)
        VALUES (?, ?, ?, ?, 'instructor', 1)
      `).run(cleanEmail, hash, fn, ln);
      user = { id: r.lastInsertRowid, email: cleanEmail, role: 'instructor' };
    } else if (user.role !== 'instructor') {
      // Promote to instructor (kept idempotent and reversible by admin)
      db.prepare(`UPDATE users SET role = 'instructor' WHERE id = ?`).run(user.id);
    }
    // Unlink any other teacher row first (one-to-one)
    db.prepare(`UPDATE lc_teachers SET user_id = NULL WHERE user_id = ?`).run(user.id);
    db.prepare(`UPDATE lc_teachers SET user_id = ? WHERE id = ?`).run(user.id, tId);
    res.json({ ok: true, user_id: user.id, email: user.email });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/lc/admin/teachers/:id/unlink-user
adminRouter.post('/teachers/:id/unlink-user', (req, res) => {
  try {
    db.prepare(`UPDATE lc_teachers SET user_id = NULL WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// STAFF_REGISTER_V2 — admin-only staff account creation
// body: { first_name, last_name, email, password, role,
//         instrument?, link_to_teacher_id?, create_teacher_profile?,    // teacher fields
//         assigned_teacher_id?                                          // coordinator field (REQUIRED for coordinator)
//       }
// role: instructor | teacher | admin | coordinator
//   - 'teacher' is shorthand for role=instructor with an lc_teachers link
//   - 'coordinator' creates role=coordinator; MUST be assigned to a specific lc_teachers row (users.assigned_teacher_id)
adminRouter.post('/staff-register', (req, res) => {
  try {
    const { first_name, last_name, email, password, role, instrument,
            link_to_teacher_id, create_teacher_profile, assigned_teacher_id } = req.body || {};
    if (!email || !password || !first_name || !last_name || !role) {
      return res.status(400).json({ error: 'first_name, last_name, email, password, role required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'password min 6 chars' });
    const cleanEmail = String(email).trim().toLowerCase();
    const validRoles = ['instructor', 'teacher', 'coordinator', 'admin']; // STAFF_REGISTER_V4 — admin re-enabled (admin creates admin)
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (role === 'coordinator' && !assigned_teacher_id) {
      return res.status(400).json({ error: 'A coordinator must be assigned to a specific teacher (assigned_teacher_id required).' });
    }
    if (role === 'coordinator') {
      const t = db.prepare('SELECT id FROM lc_teachers WHERE id = ? AND is_active = 1').get(assigned_teacher_id);
      if (!t) return res.status(400).json({ error: 'assigned_teacher_id does not match any active teacher' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // 'teacher' maps to instructor role with lc_teachers link
    const dbRole = (role === 'teacher') ? 'instructor' : role;
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(password, 10);
    const avatar = (first_name[0] + last_name[0]).toUpperCase();

    const result = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO users (email, password_hash, first_name, last_name, role, avatar_initials, verified, assigned_teacher_id)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(cleanEmail, hash, first_name.trim(), last_name.trim(), dbRole, avatar,
             role === 'coordinator' ? Number(assigned_teacher_id) : null);
      const userId = r.lastInsertRowid;

      let teacherId = null;
      if (role === 'teacher') {
        if (link_to_teacher_id) {
          db.prepare(`UPDATE lc_teachers SET user_id = NULL WHERE user_id = ?`).run(userId);
          db.prepare(`UPDATE lc_teachers SET user_id = ? WHERE id = ?`).run(userId, link_to_teacher_id);
          teacherId = link_to_teacher_id;
        } else if (create_teacher_profile) {
          const slugBase = (first_name + '-' + last_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          let slug = slugBase, n = 1;
          while (db.prepare('SELECT id FROM lc_teachers WHERE slug = ?').get(slug)) { slug = slugBase + '-' + (++n); }
          const tr = db.prepare(`
            INSERT INTO lc_teachers (name, slug, instrument, is_active, user_id)
            VALUES (?, ?, ?, 1, ?)
          `).run(first_name + ' ' + last_name, slug, String(instrument || 'sitar').toLowerCase(), userId);
          teacherId = tr.lastInsertRowid;
        }
      }
      return { userId, teacherId };
    })();

    // STAFF_CREDENTIALS_EMAIL_V1 — send login credentials to the new staff member
    try {
      const publicBase = process.env.PUBLIC_BASE_URL || 'https://tfrplay.com';
      const roleLabel = role === 'teacher' ? 'Live Class Teacher'
                      : role === 'coordinator' ? 'Coordinator'
                      : role === 'admin' ? 'Admin' : 'Course Instructor';
      const dashLink = role === 'teacher' ? '/teacher-live-dashboard.html'
                     : role === 'coordinator' ? '/coordinator-dashboard.html'
                     : role === 'admin' ? '/admin-panel.html' : '/instructor-dashboard.html';
      const html = `<!DOCTYPE html><html><body style="margin:0;font-family:'DM Sans',Arial,sans-serif;background:#F5EFE0;padding:32px;">
        <table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #D8CCAE;">
          <tr><td style="background:#080706;padding:24px;color:#F0E6D3;text-align:center;">
            <h1 style="margin:0;font-family:'Libre Baskerville',serif;font-size:22px;color:#C8A84B;">The Foundation Room</h1>
            <p style="margin:6px 0 0;font-size:11px;letter-spacing:.2em;color:rgba(200,168,75,.6);text-transform:uppercase;">Welcome aboard</p>
          </td></tr>
          <tr><td style="padding:32px;color:#4A3C28;line-height:1.7;font-size:15px;">
            <h2 style="font-style:italic;color:#8B2E26;margin:0 0 12px;">Namaste, ${first_name.trim()}.</h2>
            <p>An admin has created your <strong>${roleLabel}</strong> account at TFR. Below are your login credentials — please save them safely.</p>
            <table cellpadding="6" style="margin:18px 0;border-collapse:collapse;font-size:14px;background:#FCF8F0;border:1px solid #D8CCAE;border-radius:6px;width:100%;">
              <tr><td style="color:#9A8A72;width:140px;">Login URL</td><td><a href="${publicBase}/signin.html" style="color:#8B2E26;">${publicBase}/signin.html</a></td></tr>
              <tr><td style="color:#9A8A72;">Email</td><td><strong>${cleanEmail}</strong></td></tr>
              <tr><td style="color:#9A8A72;">Password</td><td><strong>${password}</strong></td></tr>
              <tr><td style="color:#9A8A72;">Role</td><td>${roleLabel}</td></tr>
            </table>
            <p style="margin:18px 0 8px;text-align:center;">
              <a href="${publicBase}/signin.html" style="display:inline-block;padding:14px 28px;background:#8B2E26;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;font-size:13px;">Sign In Now &rarr;</a>
            </p>
            <p style="font-size:12px;color:#9A8A72;margin-top:24px;">After your first login you can change the password from your profile. If you didn't expect this account, reply to this email.</p>
          </td></tr>
        </table></body></html>`;
      mailer.send({
        to: cleanEmail,
        subject: 'Your ' + roleLabel + ' account at The Foundation Room',
        html
      }).catch(e => console.warn('[lc] staff credentials email failed:', e?.message || e));
    } catch (e) { console.warn('[lc] credentials email build failed:', e.message); }

    res.status(201).json({ ok: true, user_id: result.userId, teacher_id: result.teacherId, role: dbRole });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
adminRouter.delete('/teachers/:id', (req, res) => { // CASCADE_DELETE_V2 — also frees up the linked user email
  try {
    const id = req.params.id;
    const tx = db.transaction(() => {
      // Capture linked user_id BEFORE delete (to free up email)
      const teacherRow = db.prepare('SELECT user_id FROM lc_teachers WHERE id = ?').get(id);
      const linkedUserId = teacherRow ? teacherRow.user_id : null;

      // 1. Cascade-delete slots + bookings + price_options + assignments for those bookings
      const slots = db.prepare('SELECT id FROM lc_slots WHERE teacher_id = ?').all(id);
      const slotIds = slots.map(s => s.id);
      if (slotIds.length) {
        const sph = slotIds.map(() => '?').join(',');
        const bookingIds = db.prepare(`SELECT id FROM lc_bookings WHERE slot_id IN (${sph})`).all(...slotIds).map(b => b.id);
        if (bookingIds.length) {
          const bph = bookingIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM lc_assignments WHERE booking_id IN (${bph})`).run(...bookingIds);
        }
        db.prepare(`DELETE FROM lc_bookings WHERE slot_id IN (${sph})`).run(...slotIds);
        db.prepare(`DELETE FROM lc_price_options WHERE slot_id IN (${sph})`).run(...slotIds);
        db.prepare(`DELETE FROM lc_slots WHERE id IN (${sph})`).run(...slotIds);
      }
      db.prepare('DELETE FROM lc_raags WHERE teacher_id = ?').run(id);

      // 2. Any coordinators assigned to this teacher → also free up their emails (hard delete)
      const coordIds = db.prepare(`SELECT id FROM users WHERE role = 'coordinator' AND assigned_teacher_id = ?`).all(id).map(u => u.id);
      coordIds.forEach(cuid => {
        // Null any orphan refs first, then delete the user
        db.prepare(`UPDATE lc_bookings SET user_id = NULL WHERE user_id = ?`).run(cuid);
        db.prepare(`UPDATE lc_assignments SET assigned_by_user_id = NULL WHERE assigned_by_user_id = ?`).run(cuid);
        db.prepare(`DELETE FROM users WHERE id = ?`).run(cuid);
      });

      // 3. Delete the lc_teachers row
      db.prepare('DELETE FROM lc_teachers WHERE id = ?').run(id);

      // 4. Free up the teacher's login email by deleting the user row
      if (linkedUserId) {
        db.prepare(`UPDATE lc_bookings SET user_id = NULL WHERE user_id = ?`).run(linkedUserId);
        db.prepare(`UPDATE lc_assignments SET assigned_by_user_id = NULL WHERE assigned_by_user_id = ?`).run(linkedUserId);
        db.prepare(`DELETE FROM users WHERE id = ?`).run(linkedUserId);
      }
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
  try {
    const id = req.params.id;
    const tx = db.transaction(() => {
      const slots = db.prepare('SELECT id FROM lc_slots WHERE raag_id = ?').all(id);
      const slotIds = slots.map(s => s.id);
      if (slotIds.length) {
        const ph = slotIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM lc_bookings WHERE slot_id IN (${ph})`).run(...slotIds);
        db.prepare(`DELETE FROM lc_price_options WHERE slot_id IN (${ph})`).run(...slotIds);
        db.prepare(`DELETE FROM lc_slots WHERE id IN (${ph})`).run(...slotIds);
      }
      db.prepare('DELETE FROM lc_raags WHERE id = ?').run(id);
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
      // JITSI_AUTO_LINK_V2 — if no link provided, auto-assign SECURE random-token Jitsi room
      if (!meet_link) {
        const tok = generateRoomToken();
        const jitsi = 'https://meet.tfrplay.com/tfr-' + tok;
        db.prepare('UPDATE lc_slots SET meet_link = ?, room_token = ? WHERE id = ?').run(jitsi, tok, slotId);
      }
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
          meet_password, is_active, price_options } = req.body || {};
  let { meet_link } = req.body || {};
  // SECURE_ROOM_V1 — sentinel "__JITSI_AUTO__" means "keep existing token URL or generate a new one"
  if (meet_link === '__JITSI_AUTO__') {
    meet_link = jitsiUrlForSlot(Number(req.params.id));
  }
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
        // PRICE_OPT_SAFE_UPDATE_V1: match-by-label + update-in-place to avoid FK violation on lc_bookings.price_option_id
        const existing = db.prepare('SELECT id, label FROM lc_price_options WHERE slot_id = ?').all(req.params.id);
        const labelToId = {};
        existing.forEach(p => { labelToId[p.label] = p.id; });
        const usedIds = new Set();
        const insStmt = db.prepare(`INSERT INTO lc_price_options (slot_id, label, amount_paise, description, sort_order) VALUES (?, ?, ?, ?, ?)`);
        const updStmt = db.prepare(`UPDATE lc_price_options SET amount_paise = ?, description = ?, sort_order = ? WHERE id = ?`);
        price_options.forEach((p, i) => {
          if (!p.label || p.amount_paise == null) return;
          const so = p.sort_order != null ? Number(p.sort_order) : i;
          if (labelToId[p.label]) {
            const id = labelToId[p.label];
            updStmt.run(Number(p.amount_paise), p.description || null, so, id);
            usedIds.add(id);
          } else {
            const r = insStmt.run(req.params.id, p.label, Number(p.amount_paise), p.description || null, so);
            usedIds.add(r.lastInsertRowid);
          }
        });
        // Remove old options not in new list - only if no bookings reference them
        existing.forEach(p => {
          if (!usedIds.has(p.id)) {
            const refCount = db.prepare('SELECT COUNT(*) AS c FROM lc_bookings WHERE price_option_id = ?').get(p.id).c;
            if (refCount === 0) {
              db.prepare('DELETE FROM lc_price_options WHERE id = ?').run(p.id);
            }
          }
        });
      }
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.delete('/slots/:id', (req, res) => {
  try {
    const id = req.params.id;
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM lc_bookings WHERE slot_id = ?').run(id);
      db.prepare('DELETE FROM lc_price_options WHERE slot_id = ?').run(id);
      db.prepare('DELETE FROM lc_slots WHERE id = ?').run(id);
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
adminRouter.delete('/coupons/:id', (req, res) => { // COUPON_SOFT_DELETE_V1
  try {
    const id = req.params.id;
    const refCount = db.prepare('SELECT COUNT(*) AS c FROM lc_bookings WHERE coupon_id = ?').get(id).c;
    if (refCount > 0) {
      db.prepare(`UPDATE lc_coupons SET is_active = 0 WHERE id = ?`).run(id);
      return res.json({ ok: true, deactivated: true, bookings_referenced: refCount, note: 'Coupon deactivated (used in ' + refCount + ' booking' + (refCount===1?'':'s') + ') - historical bookings preserve their reference.' });
    }
    db.prepare(`DELETE FROM lc_coupons WHERE id = ?`).run(id);
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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

// ACTIVITY_FEED_V1 — unified activity timeline
function buildActivityFeed(scope) {
  const tid = scope && scope.teacherId;
  const tFilter = tid ? ' AND s.teacher_id = ' + Number(tid) : '';
  const items = [];

  const bookings = db.prepare(`
    SELECT b.id, b.name, b.email, b.amount_paid_paise, b.created_at, b.joined_at, b.status,
           s.slot_date, s.start_time, t.name AS teacher_name, t.id AS teacher_id
    FROM lc_bookings b
    JOIN lc_slots s ON s.id = b.slot_id
    LEFT JOIN lc_teachers t ON t.id = s.teacher_id
    WHERE b.status = 'paid' ${tFilter}
    ORDER BY b.created_at DESC LIMIT 50
  `).all();
  bookings.forEach(b => {
    items.push({
      type: 'booking', ts: b.created_at, icon: '🎟',
      title: (b.name || 'Student') + ' booked a class with ' + (b.teacher_name || 'teacher'),
      detail: b.slot_date + ' · ' + b.start_time + ' IST · ₹' + (b.amount_paid_paise/100).toFixed(0),
      meta: { booking_id: b.id, teacher_id: b.teacher_id, email: b.email }
    });
    if (b.joined_at) {
      items.push({
        type: 'join', ts: b.joined_at, icon: '🎥',
        title: (b.name || 'Student') + ' joined ' + (b.teacher_name || 'teacher') + "'s live class",
        detail: 'Session: ' + b.slot_date + ' ' + b.start_time,
        meta: { booking_id: b.id, teacher_id: b.teacher_id }
      });
    }
  });

  const assignments = db.prepare(`
    SELECT a.id, a.type, a.title, a.created_at, a.assigned_by_user_id,
           b.name AS student_name, b.email AS student_email,
           t.name AS teacher_name, t.id AS teacher_id,
           u.first_name AS assigner_first, u.last_name AS assigner_last, u.role AS assigner_role
    FROM lc_assignments a
    JOIN lc_bookings b ON b.id = a.booking_id
    JOIN lc_slots s ON s.id = b.slot_id
    LEFT JOIN lc_teachers t ON t.id = s.teacher_id
    LEFT JOIN users u ON u.id = a.assigned_by_user_id
    WHERE 1=1 ${tFilter}
    ORDER BY a.created_at DESC LIMIT 50
  `).all();
  assignments.forEach(a => {
    const who = [a.assigner_first, a.assigner_last].filter(Boolean).join(' ') || 'Someone';
    items.push({
      type: 'assignment', ts: a.created_at,
      icon: a.type === 'pdf' ? '📄' : a.type === 'video' ? '▶' : a.type === 'link' ? '🔗' : '📝',
      title: who + ' (' + (a.assigner_role||'?') + ') assigned ' + a.type.toUpperCase() + ' to ' + a.student_name,
      detail: '"' + a.title + '"',
      meta: { assignment_id: a.id, teacher_id: a.teacher_id, student_email: a.student_email }
    });
  });

  if (!tid) {
    const newStaff = db.prepare(`
      SELECT id, email, first_name, last_name, role, created_at, assigned_teacher_id
      FROM users WHERE role IN ('instructor','coordinator','admin')
      ORDER BY created_at DESC LIMIT 30
    `).all();
    newStaff.forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
      items.push({
        type: 'staff', ts: u.created_at,
        icon: u.role === 'coordinator' ? '🤝' : u.role === 'admin' ? '👑' : '🎓',
        title: 'New ' + u.role + ' account: ' + name,
        detail: u.email + (u.assigned_teacher_id ? ' · assigned to teacher #' + u.assigned_teacher_id : ''),
        meta: { user_id: u.id, role: u.role }
      });
    });
    const newT = db.prepare(`SELECT id, name, instrument, created_at FROM lc_teachers ORDER BY created_at DESC LIMIT 20`).all();
    newT.forEach(t => {
      items.push({
        type: 'teacher_profile', ts: t.created_at, icon: '🎵',
        title: 'Teacher profile created: ' + t.name,
        detail: 'Instrument: ' + t.instrument,
        meta: { teacher_id: t.id }
      });
    });
  } else {
    const coords = db.prepare(`
      SELECT id, email, first_name, last_name, created_at
      FROM users WHERE role = 'coordinator' AND assigned_teacher_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(tid);
    coords.forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
      items.push({
        type: 'coordinator', ts: u.created_at, icon: '🤝',
        title: 'Coordinator assigned: ' + name,
        detail: u.email,
        meta: { user_id: u.id }
      });
    });
  }

  items.sort((a,b) => (b.ts || '').localeCompare(a.ts || ''));
  return items.slice(0, 100);
}

adminRouter.get('/activity', (req, res) => {
  try { res.json({ activity: buildActivityFeed({}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ADMIN_OVERSIGHT_V1 — admin can see/edit/delete EVERYTHING teachers/coordinators do
adminRouter.get('/assignments', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, b.name AS student_name, b.email AS student_email,
             s.slot_date, s.start_time,
             t.name AS teacher_name, t.id AS teacher_id,
             u.first_name AS assigner_first, u.last_name AS assigner_last, u.role AS assigner_role
      FROM lc_assignments a
      JOIN lc_bookings b ON b.id = a.booking_id
      JOIN lc_slots s ON s.id = b.slot_id
      LEFT JOIN lc_teachers t ON t.id = s.teacher_id
      LEFT JOIN users u ON u.id = a.assigned_by_user_id
      ORDER BY a.created_at DESC
    `).all();
    res.json({ assignments: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
adminRouter.put('/assignments/:id', (req, res) => {
  try {
    const { title, body_text, file_url, type } = req.body || {};
    db.prepare(`UPDATE lc_assignments SET
      title = COALESCE(?, title),
      body_text = COALESCE(?, body_text),
      file_url = COALESCE(?, file_url),
      type = COALESCE(?, type)
      WHERE id = ?`).run(title || null, body_text != null ? body_text : null, file_url != null ? file_url : null, type || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adminRouter.delete('/assignments/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM lc_assignments WHERE id = ?').run(req.params.id);
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Admin: list ALL coordinators with assigned teachers
adminRouter.get('/coordinators', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.created_at,
             u.assigned_teacher_id, t.name AS assigned_teacher_name, t.instrument
      FROM users u
      LEFT JOIN lc_teachers t ON t.id = u.assigned_teacher_id
      WHERE u.role = 'coordinator'
      ORDER BY u.created_at DESC
    `).all();
    res.json({ coordinators: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Admin: reassign coordinator to different teacher
adminRouter.put('/coordinators/:userId/reassign', (req, res) => {
  try {
    const { teacher_id } = req.body || {};
    if (!teacher_id) return res.status(400).json({ error: 'teacher_id required' });
    const t = db.prepare('SELECT id FROM lc_teachers WHERE id = ?').get(teacher_id);
    if (!t) return res.status(400).json({ error: 'Invalid teacher_id' });
    const u = db.prepare(`SELECT id, role FROM users WHERE id = ?`).get(req.params.userId);
    if (!u || u.role !== 'coordinator') return res.status(404).json({ error: 'Coordinator not found' });
    db.prepare('UPDATE users SET assigned_teacher_id = ? WHERE id = ?').run(teacher_id, req.params.userId);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.use('/admin', adminRouter);

// ─────────────────────────────────────────────────────────────
// TEACHER ROUTES — /api/lc/teacher/*  (auth + role=instructor, scoped by lc_teachers.user_id)
// TEACHER_LOGIN_V1
// ─────────────────────────────────────────────────────────────
const teacherRouter = express.Router();
teacherRouter.use(express.json());
teacherRouter.use(auth, role(['instructor']));
// Resolve and attach the linked lc_teachers row; 403 if not linked.
teacherRouter.use((req, res, next) => {
  const t = db.prepare(`SELECT * FROM lc_teachers WHERE user_id = ? AND is_active = 1`).get(req.user.id);
  if (!t) return res.status(403).json({ error: 'No live-class teacher profile linked to this account.' });
  req.lcTeacher = parseLandingJson(t);
  next();
});

// STRICT_JWT_V1 — teacher gets JWT for their own slot (moderator)
teacherRouter.get('/class-room/:slotId', (req, res) => {
  try {
    const slot = db.prepare(`SELECT * FROM lc_slots WHERE id = ? AND teacher_id = ?`).get(req.params.slotId, req.lcTeacher.id);
    if (!slot) return res.status(404).json({ error: 'Slot not found or not yours' });

    // Strict time gate — same as student endpoint
    const [Y,M,D] = (slot.slot_date||'').split('-').map(Number);
    const [hh,mm] = (slot.start_time||'').split(':').map(Number);
    const slotStart = new Date(Y, M-1, D, hh, mm);
    const slotEnd = new Date(slotStart.getTime() + (Number(slot.duration_min||60) + 30) * 60 * 1000);
    if (Date.now() >= slotEnd.getTime()) {
      return res.status(410).json({ error: 'Class has ended.', ended_at: slotEnd.toISOString() });
    }

    const out = {
      slot_id: slot.id,
      slot_date: slot.slot_date,
      start_time: slot.start_time,
      duration_min: slot.duration_min,
      meet_link: slot.meet_link,
      title: slot.title,
      teacher_name: req.lcTeacher.name,
      instrument: req.lcTeacher.instrument
    };

    // Sign Jitsi JWT (teacher = moderator)
    try {
      if (slot.meet_link && slot.meet_link.indexOf('meet.tfrplay.com') !== -1 && process.env.JITSI_APP_SECRET) {
        const jwt = require('jsonwebtoken');
        const room = new URL(slot.meet_link).pathname.replace(/^\//, '');
        const now = Math.floor(Date.now()/1000);
        const exp = Math.min(now + 60*60*4, Math.floor(slotEnd.getTime()/1000));
        out.jitsi_jwt = jwt.sign({
          aud: process.env.JITSI_APP_ID || 'tfr',
          iss: process.env.JITSI_APP_ID || 'tfr',
          sub: 'meet.tfrplay.com',
          room, exp, iat: now, nbf: now - 30,
          context: {
            user: { name: req.user.first_name + ' ' + (req.user.last_name||''), email: req.user.email, id: String(req.user.id) },
            features: { moderator: true }
          }
        }, process.env.JITSI_APP_SECRET, { algorithm: 'HS256' });
        out.is_moderator = true;
      }
    } catch (e) { console.warn('[lc] teacher JWT signing failed:', e.message); }

    res.json({ booking: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

teacherRouter.get('/me', (req, res) => {
  res.json({ teacher: req.lcTeacher });
});

teacherRouter.get('/slots', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*, (s.total_seats - s.booked_seats) AS seats_left
      FROM lc_slots s
      WHERE s.teacher_id = ?
      ORDER BY s.slot_date DESC, s.start_time DESC
    `).all(req.lcTeacher.id);
    rows.forEach(r => {
      delete r.meet_password;
      r.price_options = db.prepare(`SELECT id, label, amount_paise, sort_order FROM lc_price_options WHERE slot_id = ? ORDER BY sort_order, amount_paise`).all(r.id);
    });
    res.json({ slots: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

teacherRouter.get('/bookings', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT b.id, b.name, b.email, b.phone, b.amount_paid_paise, b.discount_paise,
             b.status, b.created_at, b.user_id, b.joined_at,
             s.slot_date, s.start_time, s.duration_min,
             po.label AS price_label
      FROM lc_bookings b
      LEFT JOIN lc_slots s ON s.id = b.slot_id
      LEFT JOIN lc_price_options po ON po.id = b.price_option_id
      WHERE s.teacher_id = ?
      ORDER BY b.created_at DESC
    `).all(req.lcTeacher.id);
    res.json({ bookings: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

teacherRouter.get('/stats', (req, res) => {
  try {
    const today = todayIso();
    const upcoming = db.prepare(`SELECT COUNT(*) AS c FROM lc_slots WHERE teacher_id = ? AND is_active = 1 AND slot_date >= ?`).get(req.lcTeacher.id, today).c;
    const totalBookings = db.prepare(`SELECT COUNT(*) AS c FROM lc_bookings b JOIN lc_slots s ON s.id = b.slot_id WHERE s.teacher_id = ? AND b.status = 'paid'`).get(req.lcTeacher.id).c;
    const totalRevenue = db.prepare(`SELECT COALESCE(SUM(b.amount_paid_paise),0) AS s FROM lc_bookings b JOIN lc_slots s ON s.id = b.slot_id WHERE s.teacher_id = ? AND b.status = 'paid'`).get(req.lcTeacher.id).s;
    res.json({ upcoming_slots: upcoming, total_bookings: totalBookings, total_revenue_paise: totalRevenue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// MEET_LINK_EDIT_V1 — teacher can change meet link on own slots
// body: { meet_link: "https://..." | null }  null => regenerate auto-Jitsi
teacherRouter.put('/slots/:id/meet-link', (req, res) => {
  try {
    const slot = db.prepare(`SELECT id, teacher_id FROM lc_slots WHERE id = ?`).get(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.teacher_id !== req.lcTeacher.id) return res.status(403).json({ error: 'Slot not yours' });
    let link = req.body && req.body.meet_link;
    if (link === null || link === '' || link === undefined) {
      link = jitsiUrlForSlot(slot.id);
    }
    db.prepare('UPDATE lc_slots SET meet_link = ? WHERE id = ?').run(link, slot.id);
    res.json({ ok: true, meet_link: link });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// TEACHER_CREATE_COORDINATOR_V1 — let a teacher manage their own coordinators
teacherRouter.get('/coordinators', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, email, first_name, last_name, created_at
      FROM users WHERE role = 'coordinator' AND assigned_teacher_id = ?
      ORDER BY created_at DESC
    `).all(req.lcTeacher.id);
    res.json({ coordinators: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

teacherRouter.post('/coordinators', (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body || {};
    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: 'first_name, last_name, email, password required' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'password min 6 chars' });
    const cleanEmail = String(email).trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(password, 10);
    const avatar = (first_name[0] + last_name[0]).toUpperCase();
    const r = db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, role, avatar_initials, verified, assigned_teacher_id)
      VALUES (?, ?, ?, ?, 'coordinator', ?, 1, ?)
    `).run(cleanEmail, hash, first_name.trim(), last_name.trim(), avatar, req.lcTeacher.id);
    res.status(201).json({ ok: true, user_id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ASSIGNMENTS_V1 — teacher assigns post-class content (pdf/video/link/text) to a specific booking
function _validateAssignmentBody(body) {
  const { booking_id, type, title, file_url, body_text } = body || {};
  if (!booking_id) return 'booking_id required';
  if (!['pdf','video','link','text'].includes(type)) return 'type must be one of pdf|video|link|text';
  if (!title || !title.trim()) return 'title required';
  if (type === 'text' && (!body_text || !body_text.trim())) return 'body_text required for text type';
  if (type !== 'text' && (!file_url || !file_url.trim())) return 'file_url required for ' + type + ' type';
  return null;
}
function _verifyBookingBelongsToTeacher(bookingId, teacherId) {
  return db.prepare(`
    SELECT b.id FROM lc_bookings b JOIN lc_slots s ON s.id = b.slot_id
    WHERE b.id = ? AND s.teacher_id = ?
  `).get(bookingId, teacherId);
}

teacherRouter.get('/assignments', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, b.name AS student_name, b.email AS student_email,
             s.slot_date, s.start_time
      FROM lc_assignments a
      JOIN lc_bookings b ON b.id = a.booking_id
      JOIN lc_slots s ON s.id = b.slot_id
      WHERE s.teacher_id = ?
      ORDER BY a.created_at DESC
    `).all(req.lcTeacher.id);
    res.json({ assignments: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

teacherRouter.post('/assignments', (req, res) => {
  try {
    const err = _validateAssignmentBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { booking_id, type, title, file_url, body_text } = req.body;
    if (!_verifyBookingBelongsToTeacher(booking_id, req.lcTeacher.id)) {
      return res.status(403).json({ error: 'Booking does not belong to your teacher profile.' });
    }
    const r = db.prepare(`
      INSERT INTO lc_assignments (booking_id, type, title, body_text, file_url, assigned_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(booking_id, type, title.trim(), body_text || null, file_url || null, req.user.id);
    res.status(201).json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

teacherRouter.delete('/assignments/:id', (req, res) => {
  try {
    const a = db.prepare(`
      SELECT a.id FROM lc_assignments a
      JOIN lc_bookings b ON b.id = a.booking_id
      JOIN lc_slots s ON s.id = b.slot_id
      WHERE a.id = ? AND s.teacher_id = ?
    `).get(req.params.id, req.lcTeacher.id);
    if (!a) return res.status(403).json({ error: 'Assignment not yours.' });
    db.prepare('DELETE FROM lc_assignments WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Teacher removes their coordinator — HARD DELETE so the email is freed up for re-registration (CASCADE_DELETE_V2)
teacherRouter.delete('/coordinators/:id', (req, res) => {
  try {
    const u = db.prepare(`SELECT id, role, assigned_teacher_id FROM users WHERE id = ?`).get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Coordinator not found' });
    if (u.role !== 'coordinator' || u.assigned_teacher_id !== req.lcTeacher.id) {
      return res.status(403).json({ error: 'This coordinator is not assigned to you.' });
    }
    const tx = db.transaction(() => {
      // Null any FK refs first so the user delete doesn't fail
      db.prepare(`UPDATE lc_bookings SET user_id = NULL WHERE user_id = ?`).run(u.id);
      db.prepare(`UPDATE lc_assignments SET assigned_by_user_id = NULL WHERE assigned_by_user_id = ?`).run(u.id);
      db.prepare(`DELETE FROM users WHERE id = ?`).run(u.id);
    });
    tx();
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// TEACHER_SLOT_CRUD_V1 — teacher can create/edit/delete their OWN slots
teacherRouter.post('/slots', (req, res) => {
  try {
    const { title, description, slot_date, start_time, duration_min = 60, total_seats,
            meet_password, is_active = 1, price_options = [] } = req.body || {};
    if (!slot_date || !start_time || !total_seats) {
      return res.status(400).json({ error: 'slot_date, start_time, total_seats required' });
    }
    const result = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO lc_slots (teacher_id, title, description, slot_date, start_time, duration_min,
          total_seats, meet_password, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.lcTeacher.id, title || null, description || null, slot_date, start_time,
             Number(duration_min) || 60, Number(total_seats),
             meet_password || null, is_active ? 1 : 0);
      const slotId = r.lastInsertRowid;
      const tok = generateRoomToken();
      db.prepare('UPDATE lc_slots SET meet_link = ?, room_token = ? WHERE id = ?').run('https://meet.tfrplay.com/tfr-' + tok, tok, slotId);
      const ins = db.prepare(`INSERT INTO lc_price_options (slot_id, label, amount_paise, sort_order) VALUES (?,?,?,?)`);
      (price_options || []).forEach((p, i) => {
        if (!p.label || p.amount_paise == null) return;
        ins.run(slotId, p.label, Number(p.amount_paise), p.sort_order != null ? Number(p.sort_order) : i);
      });
      return slotId;
    })();
    res.status(201).json({ id: result, ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

teacherRouter.put('/slots/:id', (req, res) => {
  try {
    const slot = db.prepare('SELECT teacher_id FROM lc_slots WHERE id = ?').get(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.teacher_id !== req.lcTeacher.id) return res.status(403).json({ error: 'Not your slot' });
    const { title, description, slot_date, start_time, duration_min, total_seats, is_active, price_options } = req.body || {};
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE lc_slots SET
          title = COALESCE(?, title),
          description = COALESCE(?, description),
          slot_date = COALESCE(?, slot_date),
          start_time = COALESCE(?, start_time),
          duration_min = COALESCE(?, duration_min),
          total_seats = COALESCE(?, total_seats),
          is_active = COALESCE(?, is_active)
        WHERE id = ?
      `).run(title !== undefined ? title : null, description !== undefined ? description : null,
             slot_date || null, start_time || null,
             duration_min != null ? Number(duration_min) : null,
             total_seats != null ? Number(total_seats) : null,
             is_active != null ? (is_active ? 1 : 0) : null,
             req.params.id);
      if (Array.isArray(price_options)) {
        const existing = db.prepare('SELECT id, label FROM lc_price_options WHERE slot_id = ?').all(req.params.id);
        const used = new Set();
        const upd = db.prepare(`UPDATE lc_price_options SET amount_paise=?, sort_order=? WHERE id=?`);
        const ins = db.prepare(`INSERT INTO lc_price_options (slot_id,label,amount_paise,sort_order) VALUES (?,?,?,?)`);
        price_options.forEach((p, i) => {
          if (!p.label || p.amount_paise == null) return;
          const match = existing.find(e => e.label === p.label && !used.has(e.id));
          if (match) { upd.run(Number(p.amount_paise), i, match.id); used.add(match.id); }
          else { ins.run(req.params.id, p.label, Number(p.amount_paise), i); }
        });
      }
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

teacherRouter.delete('/slots/:id', (req, res) => {
  try {
    const slot = db.prepare('SELECT teacher_id, booked_seats FROM lc_slots WHERE id = ?').get(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.teacher_id !== req.lcTeacher.id) return res.status(403).json({ error: 'Not your slot' });
    if (slot.booked_seats > 0) {
      db.prepare('UPDATE lc_slots SET is_active = 0 WHERE id = ?').run(req.params.id);
      return res.json({ ok: true, deactivated: true, note: 'Slot has bookings — deactivated instead of hard delete.' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM lc_price_options WHERE slot_id = ?').run(req.params.id);
      db.prepare('DELETE FROM lc_slots WHERE id = ?').run(req.params.id);
    })();
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// STUDENT_DELETE_V1 — teacher can delete a student (full cascade)
function fullDeleteUser(userId) {
  const tryRun = (sql, p) => { try { db.prepare(sql).run(p); } catch (_) {} };
  tryRun(`UPDATE courses SET instructor_id = NULL WHERE instructor_id = ?`, userId);
  tryRun(`UPDATE masterclasses SET instructor_id = NULL WHERE instructor_id = ?`, userId);
  tryRun(`UPDATE live_sessions SET instructor_id = NULL WHERE instructor_id = ?`, userId);
  tryRun(`UPDATE announcements SET instructor_id = NULL WHERE instructor_id = ?`, userId);
  tryRun(`UPDATE blogs SET author_id = NULL WHERE author_id = ?`, userId);
  tryRun(`UPDATE sheet_music SET uploaded_by = NULL WHERE uploaded_by = ?`, userId);
  tryRun(`UPDATE coupons SET created_by = NULL WHERE created_by = ?`, userId);
  tryRun(`UPDATE submissions SET graded_by = NULL WHERE graded_by = ?`, userId);
  tryRun(`UPDATE content_flags SET resolved_by = NULL WHERE resolved_by = ?`, userId);
  tryRun(`UPDATE content_flags SET reported_by = NULL WHERE reported_by = ?`, userId);
  tryRun(`DELETE FROM enrollments WHERE student_id = ?`, userId);
  tryRun(`DELETE FROM notifications WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM user_subscriptions WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM purchases WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM practice_sessions WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM lesson_progress WHERE student_id = ?`, userId);
  tryRun(`DELETE FROM recordings WHERE student_id = ?`, userId);
  tryRun(`DELETE FROM masterclass_registrations WHERE student_id = ?`, userId);
  tryRun(`DELETE FROM submissions WHERE student_id = ?`, userId);
  tryRun(`DELETE FROM quiz_attempts WHERE student_id = ?`, userId);
  tryRun(`DELETE FROM live_session_attendees WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM thread_participants WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM calendar_events WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM payments WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM certificates WHERE student_id = ?`, userId);
  tryRun(`DELETE FROM coupon_redemptions WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM user_profile WHERE user_id = ?`, userId);
  tryRun(`DELETE FROM instructor_google_tokens WHERE user_id = ?`, userId);
  try {
    const bookingIds = db.prepare('SELECT id FROM lc_bookings WHERE user_id = ?').all(userId).map(b => b.id);
    if (bookingIds.length) {
      const ph = bookingIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM lc_assignments WHERE booking_id IN (${ph})`).run(...bookingIds);
    }
  } catch (_) {}
  tryRun(`DELETE FROM lc_bookings WHERE user_id = ?`, userId);
  tryRun(`UPDATE lc_assignments SET assigned_by_user_id = NULL WHERE assigned_by_user_id = ?`, userId);
  tryRun(`DELETE FROM users WHERE id = ?`, userId);
}

teacherRouter.delete('/students/:userId', (req, res) => {
  try {
    const uid = Number(req.params.userId);
    const target = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(uid);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin users' });
    if (target.role === 'instructor' || target.role === 'coordinator') return res.status(403).json({ error: 'Cannot delete staff accounts from teacher dashboard. Ask admin.' });
    // Verify this student has at least one booking with this teacher
    const hasBooking = db.prepare(`
      SELECT b.id FROM lc_bookings b JOIN lc_slots s ON s.id = b.slot_id
      WHERE s.teacher_id = ? AND (b.user_id = ? OR LOWER(b.email) = LOWER(?))
      LIMIT 1
    `).get(req.lcTeacher.id, uid, target.email);
    if (!hasBooking) return res.status(403).json({ error: 'This user has no booking with your class — cannot delete.' });
    db.transaction(() => fullDeleteUser(uid))();
    res.json({ ok: true, deleted: true, email: target.email });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ACTIVITY_FEED_V1 — teacher scoped activity
teacherRouter.get('/activity', (req, res) => {
  try { res.json({ activity: buildActivityFeed({ teacherId: req.lcTeacher.id }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.use('/teacher', teacherRouter);

// ─────────────────────────────────────────────────────────────
// COORDINATOR ROUTES — /api/lc/coordinator/*
// COORDINATOR_V1 — scoped to ONE teacher (users.assigned_teacher_id)
// ─────────────────────────────────────────────────────────────
const coordinatorRouter = express.Router();
coordinatorRouter.use(express.json());
coordinatorRouter.use(auth, role(['coordinator']));
// Load the assigned teacher onto req.lcTeacher
coordinatorRouter.use((req, res, next) => {
  const userRow = db.prepare(`SELECT assigned_teacher_id FROM users WHERE id = ?`).get(req.user.id);
  if (!userRow || !userRow.assigned_teacher_id) {
    return res.status(403).json({ error: 'Coordinator account is not assigned to any teacher. Ask admin to set assignment.' });
  }
  const t = db.prepare(`SELECT * FROM lc_teachers WHERE id = ? AND is_active = 1`).get(userRow.assigned_teacher_id);
  if (!t) return res.status(403).json({ error: 'Assigned teacher profile not found or inactive.' });
  req.lcTeacher = parseLandingJson(t);
  next();
});

coordinatorRouter.get('/me', (req, res) => {
  res.json({ teacher: req.lcTeacher, coordinator_user_id: req.user.id });
});

coordinatorRouter.get('/slots', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*, (s.total_seats - s.booked_seats) AS seats_left
      FROM lc_slots s WHERE s.teacher_id = ? ORDER BY s.slot_date DESC, s.start_time DESC
    `).all(req.lcTeacher.id);
    rows.forEach(r => { delete r.meet_password; });
    // Attach price options for each slot
    rows.forEach(s => {
      s.price_options = db.prepare(`SELECT id, label, amount_paise, sort_order FROM lc_price_options WHERE slot_id = ? ORDER BY sort_order, amount_paise`).all(s.id);
    });
    res.json({ slots: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

coordinatorRouter.get('/bookings', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT b.id, b.name, b.email, b.phone, b.amount_paid_paise, b.discount_paise,
             b.status, b.created_at,
             s.slot_date, s.start_time, s.duration_min,
             po.label AS price_label
      FROM lc_bookings b
      LEFT JOIN lc_slots s ON s.id = b.slot_id
      LEFT JOIN lc_price_options po ON po.id = b.price_option_id
      WHERE s.teacher_id = ? ORDER BY b.created_at DESC
    `).all(req.lcTeacher.id);
    res.json({ bookings: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

coordinatorRouter.get('/stats', (req, res) => {
  try {
    const today = todayIso();
    const upcoming = db.prepare(`SELECT COUNT(*) AS c FROM lc_slots WHERE teacher_id = ? AND is_active = 1 AND slot_date >= ?`).get(req.lcTeacher.id, today).c;
    const totalBookings = db.prepare(`SELECT COUNT(*) AS c FROM lc_bookings b JOIN lc_slots s ON s.id = b.slot_id WHERE s.teacher_id = ? AND b.status = 'paid'`).get(req.lcTeacher.id).c;
    const totalRevenue = db.prepare(`SELECT COALESCE(SUM(b.amount_paid_paise),0) AS s FROM lc_bookings b JOIN lc_slots s ON s.id = b.slot_id WHERE s.teacher_id = ? AND b.status = 'paid'`).get(req.lcTeacher.id).s;
    res.json({ upcoming_slots: upcoming, total_bookings: totalBookings, total_revenue_paise: totalRevenue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// COORDINATOR_V1 — write access: change a price option's amount (only for assigned teacher's slots)
// MEET_LINK_EDIT_V1 — coordinator can change meet link on assigned teacher's slots
coordinatorRouter.put('/slots/:id/meet-link', (req, res) => {
  try {
    const slot = db.prepare(`SELECT id, teacher_id FROM lc_slots WHERE id = ?`).get(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.teacher_id !== req.lcTeacher.id) return res.status(403).json({ error: 'Slot not in your scope' });
    let link = req.body && req.body.meet_link;
    if (link === null || link === '' || link === undefined) {
      link = jitsiUrlForSlot(slot.id);
    }
    db.prepare('UPDATE lc_slots SET meet_link = ? WHERE id = ?').run(link, slot.id);
    res.json({ ok: true, meet_link: link });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

coordinatorRouter.put('/price-options/:id', (req, res) => {
  try {
    const { amount_paise, label } = req.body || {};
    // Verify the price option belongs to a slot of the assigned teacher
    const owner = db.prepare(`
      SELECT po.id FROM lc_price_options po
      JOIN lc_slots s ON s.id = po.slot_id
      WHERE po.id = ? AND s.teacher_id = ?
    `).get(req.params.id, req.lcTeacher.id);
    if (!owner) return res.status(403).json({ error: 'Price option does not belong to your assigned teacher.' });
    db.prepare(`
      UPDATE lc_price_options SET
        amount_paise = COALESCE(?, amount_paise),
        label = COALESCE(?, label)
      WHERE id = ?
    `).run(amount_paise != null ? Number(amount_paise) : null, label != null ? String(label) : null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ASSIGNMENTS_V1 — coordinator can also assign content (scoped to assigned teacher)
coordinatorRouter.get('/assignments', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, b.name AS student_name, b.email AS student_email,
             s.slot_date, s.start_time
      FROM lc_assignments a
      JOIN lc_bookings b ON b.id = a.booking_id
      JOIN lc_slots s ON s.id = b.slot_id
      WHERE s.teacher_id = ?
      ORDER BY a.created_at DESC
    `).all(req.lcTeacher.id);
    res.json({ assignments: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

coordinatorRouter.post('/assignments', (req, res) => {
  try {
    const err = _validateAssignmentBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { booking_id, type, title, file_url, body_text } = req.body;
    if (!_verifyBookingBelongsToTeacher(booking_id, req.lcTeacher.id)) {
      return res.status(403).json({ error: 'Booking does not belong to your assigned teacher.' });
    }
    const r = db.prepare(`
      INSERT INTO lc_assignments (booking_id, type, title, body_text, file_url, assigned_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(booking_id, type, title.trim(), body_text || null, file_url || null, req.user.id);
    res.status(201).json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

coordinatorRouter.delete('/assignments/:id', (req, res) => {
  try {
    const a = db.prepare(`
      SELECT a.id FROM lc_assignments a
      JOIN lc_bookings b ON b.id = a.booking_id
      JOIN lc_slots s ON s.id = b.slot_id
      WHERE a.id = ? AND s.teacher_id = ?
    `).get(req.params.id, req.lcTeacher.id);
    if (!a) return res.status(403).json({ error: 'Assignment not in your scope.' });
    db.prepare('DELETE FROM lc_assignments WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.use('/coordinator', coordinatorRouter);

// JOIN_CLASS_V1 — Student-facing: upcoming live classes booked by this user
router.get('/me/upcoming-classes', auth, (req, res) => {
  try {
    const todayDate = new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT b.id AS booking_id, b.name AS student_name, b.email AS student_email,
             b.status, b.joined_at,
             s.id AS slot_id, s.slot_date, s.start_time, s.duration_min, s.meet_link,
             t.id AS teacher_id, t.name AS teacher_name, t.photo_url AS teacher_photo, t.instrument
      FROM lc_bookings b
      JOIN lc_slots s ON s.id = b.slot_id
      LEFT JOIN lc_teachers t ON t.id = s.teacher_id
      WHERE b.status = 'paid'
        AND (b.user_id = ? OR LOWER(b.email) = LOWER(?))
        AND s.slot_date >= ?
      ORDER BY s.slot_date, s.start_time
    `).all(req.user.id, req.user.email, todayDate);
    res.json({ classes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lc/me/class-room/:bookingId — sanitized class info + meet_link + JITSI JWT
router.get('/me/class-room/:bookingId', auth, (req, res) => {
  try {
    const r = db.prepare(`
      SELECT b.id AS booking_id, b.user_id, b.email, b.name, b.status,
             s.id AS slot_id, s.slot_date, s.start_time, s.duration_min, s.meet_link, s.meet_password,
             t.name AS teacher_name, t.photo_url AS teacher_photo, t.instrument, t.user_id AS teacher_user_id
      FROM lc_bookings b
      JOIN lc_slots s ON s.id = b.slot_id
      LEFT JOIN lc_teachers t ON t.id = s.teacher_id
      WHERE b.id = ? AND b.status = 'paid'
    `).get(req.params.bookingId);
    if (!r) return res.status(404).json({ error: 'Booking not found or not paid' });
    if (r.user_id !== req.user.id && String(r.email||'').toLowerCase() !== String(req.user.email||'').toLowerCase()) {
      return res.status(403).json({ error: 'This booking is not yours' });
    }

    // STRICT_TIME_GATE_V1 — block class-room API entirely once class has ended (+30 min grace)
    const [Y,M,D] = (r.slot_date||'').split('-').map(Number);
    const [hh,mm] = (r.start_time||'').split(':').map(Number);
    const slotStart = new Date(Y, M-1, D, hh, mm);
    const slotEnd   = new Date(slotStart.getTime() + (Number(r.duration_min||60) + 30) * 60 * 1000);
    const nowMs = Date.now();
    if (nowMs >= slotEnd.getTime()) {
      return res.status(410).json({ error: 'Class has ended — meeting room is closed.', ended_at: slotEnd.toISOString() });
    }

    // JITSI_JWT_V1 — sign a token only the logged-in booking owner gets.
    // JWT exp is capped at slot end + 30min (or 4hr, whichever earlier).
    try {
      if (r.meet_link && r.meet_link.indexOf('meet.tfrplay.com') !== -1 && process.env.JITSI_APP_SECRET) {
        const jwt = require('jsonwebtoken');
        const room = new URL(r.meet_link).pathname.replace(/^\//, '');
        const isTeacher = (r.teacher_user_id && req.user.id === r.teacher_user_id);
        const now = Math.floor(Date.now()/1000);
        const slotEndSec = Math.floor(slotEnd.getTime()/1000);
        const exp = Math.min(now + 60 * 60 * 4, slotEndSec); // expire at slot end (no late-night replay)
        const payload = {
          aud: process.env.JITSI_APP_ID || 'tfr',
          iss: process.env.JITSI_APP_ID || 'tfr',
          sub: 'meet.tfrplay.com',
          room,
          exp, iat: now, nbf: now - 30,
          context: {
            user: { name: req.user.first_name + ' ' + (req.user.last_name||''), email: req.user.email, id: String(req.user.id) },
            features: { moderator: isTeacher }
          }
        };
        r.jitsi_jwt = jwt.sign(payload, process.env.JITSI_APP_SECRET, { algorithm: 'HS256' });
        r.is_moderator = !!isTeacher;
      }
    } catch (e) { console.warn('[lc] JWT signing failed:', e.message); }

    res.json({ booking: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/lc/me/joined/:bookingId — record join timestamp (idempotent: first join wins)
router.post('/me/joined/:bookingId', auth, (req, res) => {
  try {
    const r = db.prepare(`SELECT id, user_id, email, joined_at FROM lc_bookings WHERE id = ?`).get(req.params.bookingId);
    if (!r) return res.status(404).json({ error: 'Booking not found' });
    if (r.user_id !== req.user.id && String(r.email||'').toLowerCase() !== String(req.user.email||'').toLowerCase()) {
      return res.status(403).json({ error: 'Not your booking' });
    }
    if (!r.joined_at) {
      db.prepare(`UPDATE lc_bookings SET joined_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.bookingId);
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ASSIGNMENTS_V1 — student-facing: fetch assignments tied to bookings made by this user
// Matches either lc_bookings.user_id = req.user.id OR lc_bookings.email = req.user.email (guest checkout)
router.get('/me/assignments', auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.id, a.type, a.title, a.body_text, a.file_url, a.created_at,
             b.id AS booking_id, b.name AS student_name,
             s.slot_date, s.start_time, s.duration_min,
             t.name AS teacher_name, t.photo_url AS teacher_photo, t.instrument
      FROM lc_assignments a
      JOIN lc_bookings b ON b.id = a.booking_id
      JOIN lc_slots s ON s.id = b.slot_id
      LEFT JOIN lc_teachers t ON t.id = s.teacher_id
      WHERE b.status = 'paid' AND (b.user_id = ? OR LOWER(b.email) = LOWER(?))
      ORDER BY a.created_at DESC
    `).all(req.user.id, req.user.email);
    res.json({ assignments: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AUTO_CLEANUP_V1 — every hour, hard-delete slots (+ their bookings/assignments) whose class date is > 2 days old
function autoCleanupExpiredSlots() {
  try {
    const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const stale = db.prepare(`SELECT id FROM lc_slots WHERE slot_date < ?`).all(cutoff).map(s => s.id);
    if (!stale.length) return;
    const tx = db.transaction(() => {
      const ph = stale.map(() => '?').join(',');
      const bookingIds = db.prepare(`SELECT id FROM lc_bookings WHERE slot_id IN (${ph})`).all(...stale).map(b => b.id);
      if (bookingIds.length) {
        const bph = bookingIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM lc_assignments WHERE booking_id IN (${bph})`).run(...bookingIds);
      }
      db.prepare(`DELETE FROM lc_bookings WHERE slot_id IN (${ph})`).run(...stale);
      db.prepare(`DELETE FROM lc_price_options WHERE slot_id IN (${ph})`).run(...stale);
      db.prepare(`DELETE FROM lc_slots WHERE id IN (${ph})`).run(...stale);
    });
    tx();
    console.log('[lc-cleanup] Removed', stale.length, 'expired slots (>' + 2 + ' days old) and all their bookings/assignments. Slot IDs:', stale.join(','));
  } catch (e) { console.warn('[lc-cleanup] failed:', e.message); }
}
// Run at boot, then every 1 hour
setTimeout(autoCleanupExpiredSlots, 30 * 1000);            // 30s after boot
setInterval(autoCleanupExpiredSlots, 60 * 60 * 1000);      // hourly

module.exports = router;
module.exports.finalizeLcBooking = finalizeLcBooking;
module.exports.autoCleanupExpiredSlots = autoCleanupExpiredSlots;
