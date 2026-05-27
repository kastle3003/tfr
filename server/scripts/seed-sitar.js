// One-off seed: insert "Sitar — The Complete Foundation" course + Niladri Kumar
// instructor + 5 Foundation chapters. Idempotent — skips silently if the slug
// is already taken.
//
// Run: node server/scripts/seed-sitar.js

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/archive.db');
const SLUG = 'sitar-the-complete-foundation';
const INSTRUCTOR_EMAIL = 'niladri@thefoundationroom.in';
// Password is rotated in production; this is the seed default. Niladri can use
// /forgot-password to set their own.
const SEED_PASSWORD = process.env.SITAR_SEED_PASSWORD || 'tfr-niladri-' + Date.now();

const FOUNDATIONS = [
  { title: 'Foundation A', desc: "Orientation, instrument anatomy and Niladri's teaching philosophy" },
  { title: 'Foundation B', desc: 'Correct sitting position, mizrab technique and Da-Ra strokes' },
  { title: 'Foundation C', desc: 'Finger placement, fret navigation and the meend glide technique' },
  { title: 'Foundation D', desc: 'Introduction to Kalyan thaat and your first complete raga' },
  { title: 'Foundation E', desc: 'Morning raga Bhairav and advanced layakari techniques' },
];

function main() {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const existing = db.prepare('SELECT id FROM courses WHERE slug = ?').get(SLUG);
  if (existing) {
    console.log(`Sitar course already exists (id=${existing.id}); nothing to do.`);
    return;
  }

  const tx = db.transaction(() => {
    // 1. Niladri user (instructor) — create only if not present
    let instructorId;
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(INSTRUCTOR_EMAIL);
    if (existingUser) {
      instructorId = existingUser.id;
      console.log(`Reusing existing instructor user id=${instructorId}`);
    } else {
      const hash = bcrypt.hashSync(SEED_PASSWORD, 10);
      const result = db.prepare(`
        INSERT INTO users (email, password_hash, first_name, last_name, role, instrument, avatar_initials, bio, verified)
        VALUES (?, ?, ?, ?, 'instructor', ?, ?, ?, 1)
      `).run(
        INSTRUCTOR_EMAIL, hash, 'Niladri', 'Kumar', 'Sitar', 'NK',
        "Niladri Kumar is one of India's foremost sitar virtuosos, son of the legendary Pandit Kartick Kumar. A recipient of the National Film Award and countless accolades, he has redefined the sitar for a global audience while remaining deeply rooted in the Imdadkhani gharana tradition."
      );
      instructorId = result.lastInsertRowid;
      console.log(`Created instructor user id=${instructorId}; seed password: ${SEED_PASSWORD}`);
      console.log('  IMPORTANT: rotate via /forgot-password before use.');
    }

    // 2. Course row
    const courseRow = db.prepare(`
      INSERT INTO courses (
        title, slug, subtitle, description,
        instructor_id, instrument, level, category, tags,
        cover_color, cover_accent, duration_weeks, lesson_count, status,
        batch_mode, is_paid, price_paise, bundle_price_paise
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, ?, ?)
    `).run(
      'Sitar — The Complete Foundation',
      SLUG,
      'From first notes to raga mastery',
      "An immersive journey into the world of the sitar under Niladri Kumar's direct mentorship. Beginning with instrument anatomy, correct posture, and meend (glide) technique, students progress through foundational ragas in the Imdadkhani gharana tradition. Live sessions include real-time corrections, dedicated riyaz modules, and performance recordings reviewed by Niladri himself.",
      instructorId, 'Sitar', 'Beginner', 'Sitar',
      '["Hindustani Classical","Raga","Imdadkhani Gharana","Beginner Friendly"]',
      '#1A0D00', '#C8A84B', 16, 0,
      29900,    // ₹299 individual foundation price
      99900     // ₹999 bundle price
    );
    const courseId = courseRow.lastInsertRowid;
    console.log(`Created Sitar course id=${courseId}`);

    // 3. 5 Foundation chapters (no lessons — using support_links + live sessions)
    const insertCh = db.prepare(`
      INSERT INTO chapters (course_id, title, order_index, description, price_individual_paise)
      VALUES (?, ?, ?, ?, 29900)
    `);
    FOUNDATIONS.forEach((f, i) => {
      insertCh.run(courseId, f.title, i + 1, f.desc);
    });
    console.log(`Created ${FOUNDATIONS.length} chapters`);

    return courseId;
  });

  const id = tx();
  console.log(`\nSeed complete. Sitar course id=${id}, slug=${SLUG}.`);
  console.log(`Public URL: https://tfrplay.com/courses/${SLUG}`);
}

main();
