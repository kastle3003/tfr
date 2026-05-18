// Live Classes (LC) schema — isolated `lc_*` tables for the new booking module.
// Imported once from lc.routes.js; calls init() at require-time so the tables
// exist before any request hits the router. Idempotent (CREATE IF NOT EXISTS).
//
// Strict isolation rule: nothing here references or mutates existing tables.
// The optional `user_id` FK on lc_bookings only *references* users(id).

const db = require('../db');

let initialised = false;

function init() {
  if (initialised) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS lc_teachers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      bio TEXT,
      photo_url TEXT,
      instrument TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lc_raags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL REFERENCES lc_teachers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      UNIQUE(teacher_id, slug)
    );

    CREATE TABLE IF NOT EXISTS lc_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL REFERENCES lc_teachers(id),
      raag_id INTEGER REFERENCES lc_raags(id),
      title TEXT,
      slot_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      duration_min INTEGER DEFAULT 60,
      total_seats INTEGER NOT NULL,
      booked_seats INTEGER DEFAULT 0,
      meet_link TEXT,
      meet_password TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lc_price_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL REFERENCES lc_slots(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,
      description TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS lc_coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL,
      discount_value INTEGER NOT NULL,
      max_uses INTEGER,
      used_count INTEGER DEFAULT 0,
      expires_at TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lc_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL REFERENCES lc_slots(id),
      price_option_id INTEGER NOT NULL REFERENCES lc_price_options(id),
      coupon_id INTEGER REFERENCES lc_coupons(id),
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      amount_paid_paise INTEGER NOT NULL,
      discount_paise INTEGER DEFAULT 0,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS lc_bookings_order_idx ON lc_bookings(razorpay_order_id);
    CREATE INDEX IF NOT EXISTS lc_bookings_slot_idx  ON lc_bookings(slot_id);
    CREATE INDEX IF NOT EXISTS lc_bookings_status_idx ON lc_bookings(status);
    CREATE INDEX IF NOT EXISTS lc_slots_active_idx ON lc_slots(is_active, slot_date);
  `);

  // Migrations — add columns to existing tables on older DBs (idempotent).
  try { db.exec('ALTER TABLE lc_teachers ADD COLUMN landing_json TEXT'); } catch (_) {}

  initialised = true;
}

// Apply a coupon to a base amount. Returns { ok, discount_paise, final_paise, coupon_id, reason }.
// Pure function — no DB writes (caller increments used_count on payment success).
function applyCoupon(code, baseAmountPaise) {
  if (!code) return { ok: false, reason: 'no_code' };
  const row = db.prepare(`SELECT * FROM lc_coupons WHERE code = ?`).get(String(code).trim().toUpperCase());
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.is_active) return { ok: false, reason: 'inactive' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (row.max_uses != null && row.used_count >= row.max_uses) return { ok: false, reason: 'exhausted' };

  let discount = 0;
  if (row.discount_type === 'pct') {
    discount = Math.floor((baseAmountPaise * Number(row.discount_value)) / 100);
  } else if (row.discount_type === 'flat') {
    discount = Math.min(baseAmountPaise, Number(row.discount_value) * 100);
  }
  const finalAmount = Math.max(0, baseAmountPaise - discount);
  return { ok: true, discount_paise: discount, final_paise: finalAmount, coupon_id: row.id };
}

module.exports = { init, applyCoupon };
