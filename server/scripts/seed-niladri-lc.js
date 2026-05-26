// Seed Niladri Kumar as the first Live Class teacher + 5 raags + 2 sample slots
// + 1 sample coupon + email template. Idempotent — re-running is safe.
//
// Run: node server/scripts/seed-niladri-lc.js

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/archive.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// Ensure schema exists (in case the server hasn't started yet).
require('../lib/lc-schema').init();

// ── 1. Teacher ──
const NILADRI_BIO = `One of India's foremost contemporary sitar maestros, Niladri Kumar is a sixth-generation sitar player and the innovator of the "zitar" — a sitar-electric guitar hybrid. Trained by his father Pandit Kartick Kumar and the legendary Pandit Ravi Shankar, his playing fuses classical purity with modern expression.`;

const NILADRI_LANDING = {
  hero_eyebrow: "Sitara™ Live",
  hero_title_line1: "Niladri",
  hero_title_line2: "Kumaar",
  hero_tagline: "India's foremost sitar virtuoso teaches live.<br>Small batches. Real-time feedback. No recordings — presence only.",
  hero_badge: "Live Batch Classes · Online",
  hero_photo_full: "/assets/tfr-play/niladri-live.jpg",
  hero_credit: "Niladri Kumaar — Sitara™",
  accent_color: "#C8362A",
  trust_strip: [
    { num: "8",      label: "Max Seats / Batch" },
    { num: "Live",   label: "Google Meet · No Recording" },
    { num: "5th",    label: "Generation Sitar Lineage" },
    { num: "60 min", label: "Per Session" }
  ],
  about_eyebrow: "About the Programme",
  about_title: "Riyaz with a living legend",
  about_body: "Niladri Kumaar — disciple of Pandit Ravi Shankar and son of the legendary Ustad Kartick Kumar — brings five generations of sitar mastery to a small, intimate live format. Sitara™ is not a recorded course. Every session is live, interactive, and personal.",
  what_you_learn_title: "The complete sitar foundation",
  what_you_learn: [
    { icon: "🎵", title: "Raga & Alankaar", body: "Core ragas, meend, gamak, and the foundational scales of Hindustani music — taught the way lineage demands." },
    { icon: "🥁", title: "Layakari",        body: "Rhythmic phrasing, taal cycles, and the conversation between sitar and tabla." },
    { icon: "🪔", title: "Tradition",       body: "Lineage-based teaching — discipline, posture, and the unspoken language of guru-shishya parampara." }
  ],
  cta_title: "Begin your riyaz.",
  cta_sub:   "Reserve your seat for the next live batch and start training with Niladri Kumaar."
};

const tInsert = db.prepare(`
  INSERT OR IGNORE INTO lc_teachers (name, slug, bio, photo_url, instrument, sort_order, is_active, landing_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
tInsert.run('Niladri Kumar', 'niladri-kumar', NILADRI_BIO,
            '/assets/tfr-play/niladri-portrait.jpg', 'sitar', 1, 1,
            JSON.stringify(NILADRI_LANDING));
// Backfill landing_json if teacher already existed without it
db.prepare(`UPDATE lc_teachers SET landing_json = ? WHERE slug = ? AND (landing_json IS NULL OR landing_json = '')`)
  .run(JSON.stringify(NILADRI_LANDING), 'niladri-kumar');
const teacher = db.prepare(`SELECT * FROM lc_teachers WHERE slug = ?`).get('niladri-kumar');
console.log('teacher:', teacher.id, teacher.name);

// ── 2. Raags ──
const RAAGS = [
  { name: 'Basics',       slug: 'basics',       desc: 'The grammar of sitar — sitting position, mizrab technique, sa-re-ga-ma and your first phrases. Mandatory before raag study.' },
  { name: 'Jhinjoti',     slug: 'jhinjoti',     desc: 'A late-evening raag from the Khamaj family. Romantic, lyrical, accessible — an ideal first raag for serious students.' },
  { name: 'Hamsadhwani',  slug: 'hamsadhwani',  desc: 'A Carnatic raag adopted into Hindustani repertoire. Bright, fast-moving, evening raag — Niladri\'s signature concert opener.' },
  { name: 'Raag Desh',    slug: 'raag-desh',    desc: 'Monsoon raag. Late evening. The romance of impending rain — a deep emotional palette for advanced students.' },
  { name: 'Kafi',         slug: 'kafi',         desc: 'A Holi raag. Spring, longing, semi-classical. The bridge between pure classical and thumri / dadra forms.' },
];
const rInsert = db.prepare(`
  INSERT OR IGNORE INTO lc_raags (teacher_id, name, slug, description, sort_order, is_active)
  VALUES (?, ?, ?, ?, ?, 1)
`);
RAAGS.forEach((r, i) => rInsert.run(teacher.id, r.name, r.slug, r.desc, i + 1));
const allRaags = db.prepare(`SELECT * FROM lc_raags WHERE teacher_id = ?`).all(teacher.id);
console.log('raags seeded:', allRaags.length);

// ── 3. Two sample slots on Jhinjoti ──
const jhinjoti = allRaags.find(r => r.slug === 'jhinjoti');
const sInsert = db.prepare(`
  INSERT INTO lc_slots (teacher_id, raag_id, title, slot_date, start_time, duration_min,
    total_seats, meet_link, is_active)
  VALUES (?, ?, ?, ?, ?, 60, 15, 'https://meet.google.com/sample-link-replace', 1)
`);
const poInsert = db.prepare(`
  INSERT INTO lc_price_options (slot_id, label, amount_paise, description, sort_order)
  VALUES (?, ?, ?, ?, ?)
`);
// Insert only if the slot date+time combo doesn't already exist for Jhinjoti
function makeSlotIfMissing(date, time, title) {
  const exists = db.prepare(`
    SELECT id FROM lc_slots WHERE teacher_id = ? AND raag_id = ? AND slot_date = ? AND start_time = ?
  `).get(teacher.id, jhinjoti.id, date, time);
  if (exists) return exists.id;
  const r = sInsert.run(teacher.id, jhinjoti.id, title, date, time);
  const id = r.lastInsertRowid;
  poInsert.run(id, 'Basic',   99900,  'Live class + Q&A', 1);
  poInsert.run(id, 'Premium', 149900, 'Includes session recording + practice notes', 2);
  return id;
}
// Two sample dates 7 and 14 days from today
function dayOffset(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
makeSlotIfMissing(dayOffset(7),  '19:00', 'Jhinjoti — Aaroh / Avaroh and pakar');
makeSlotIfMissing(dayOffset(14), '19:00', 'Jhinjoti — Vistar and laykari');
console.log('sample slots ensured for Jhinjoti');

// ── 4. Sample coupon ──
db.prepare(`
  INSERT OR IGNORE INTO lc_coupons (code, discount_type, discount_value, max_uses, is_active)
  VALUES ('WELCOME10', 'pct', 10, 100, 1)
`).run();
console.log('coupon WELCOME10 ensured');

// ── 5. Email template ──
const TEMPLATE_SUBJECT = 'Your live class is confirmed — {{slot_date}} at {{start_time}}';
const TEMPLATE_HTML = `
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
  <p>Your live class with <strong>{{teacher_name}}</strong> has been confirmed.</p>
  <table cellpadding="6" style="margin:14px 0;border-collapse:collapse;font-size:14px;">
    <tr><td style="color:#9A8A72;">Raag / Topic</td><td><strong>{{raag_name}}</strong></td></tr>
    <tr><td style="color:#9A8A72;">Date</td><td><strong>{{slot_date}}</strong></td></tr>
    <tr><td style="color:#9A8A72;">Time</td><td><strong>{{start_time}} IST</strong> ({{duration_min}} min)</td></tr>
    <tr><td style="color:#9A8A72;">Plan</td><td>{{price_label}}</td></tr>
    <tr><td style="color:#9A8A72;">Amount paid</td><td>&#8377;{{amount_rupees}}</td></tr>
    <tr><td style="color:#9A8A72;">Booking ID</td><td>#{{booking_id}}</td></tr>
  </table>
  <p style="margin:18px 0 8px;"><strong>Join link (Google Meet):</strong></p>
  <p><a href="{{meet_link}}" style="color:#8B2E26;word-break:break-all;">{{meet_link}}</a></p>
  <p style="font-size:13px;color:#9A8A72;margin-top:20px;">Please join 5 minutes before the start time. If you have trouble accessing the link, reply to this email and we'll help.</p>
</td></tr>
</table></td></tr></table></body></html>`;

try {
  // Only insert if email_templates table exists (it may not on a fresh DB).
  db.prepare(`
    INSERT OR IGNORE INTO email_templates (name, subject, html_body, updated_at)
    VALUES ('lc_booking_confirmed', ?, ?, datetime('now'))
  `).run(TEMPLATE_SUBJECT, TEMPLATE_HTML);
  console.log('email template lc_booking_confirmed ensured');
} catch (e) {
  console.warn('email_templates table not present — fallback in lc.routes.js will be used:', e.message);
}

console.log('\nSeed complete. Visit /live-classes to verify.');
db.close();
