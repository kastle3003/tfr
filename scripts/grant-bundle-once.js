/**
 * One-shot script: grant full bundle access to a specific user.
 * Run on VPS: node scripts/grant-bundle-once.js
 * Safe to re-run — skips if purchase already exists.
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '../data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'archive.db');
const db = new Database(dbPath);

const TARGET_EMAIL  = 'hemant@gfxbandits.com';
const COURSE_SLUG   = 'djembe-world-percussions';

// ── Lookup ────────────────────────────────────────────────────────────────
const user = db.prepare('SELECT * FROM users WHERE email = ?').get(TARGET_EMAIL);
if (!user) { console.error(`❌  User not found: ${TARGET_EMAIL}`); process.exit(1); }

const course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(COURSE_SLUG);
if (!course) { console.error(`❌  Course not found: ${COURSE_SLUG}`); process.exit(1); }

// ── Already granted? ──────────────────────────────────────────────────────
const existing = db.prepare(`
  SELECT id FROM purchases
  WHERE user_id = ? AND course_id = ? AND type = 'bundle' AND status = 'completed'
`).get(user.id, course.id);

if (existing) {
  console.log(`✅  Already granted — purchase #${existing.id} exists. Nothing to do.`);
  process.exit(0);
}

// ── Insert completed purchase ─────────────────────────────────────────────
const ins = db.prepare(`
  INSERT INTO purchases
    (user_id, course_id, foundation_id, type, status,
     amount_paise, currency, razorpay_order_id,
     coupon_id, discount_paise, is_upgrade)
  VALUES (?, ?, NULL, 'bundle', 'completed', 0, 'INR', ?, NULL, 0, 0)
`).run(user.id, course.id, `order_admin_grant_${Date.now()}`);

const purchaseId = ins.lastInsertRowid;

// ── Enroll the student ────────────────────────────────────────────────────
db.prepare(`
  INSERT OR IGNORE INTO enrollments (student_id, course_id, last_accessed_at)
  VALUES (?, ?, datetime('now'))
`).run(user.id, course.id);

// ── Coupon redemption tracking (none here, but log anyway) ────────────────
console.log(`✅  Bundle granted!`);
console.log(`    User    : ${user.email} (id=${user.id})`);
console.log(`    Course  : ${course.title} (id=${course.id})`);
console.log(`    Purchase: #${purchaseId}`);

db.close();
