// Seed the homepage_content table with the CURRENT hardcoded values from
// public/index.html. Idempotent: re-running won't overwrite admin-edited rows
// (uses INSERT OR IGNORE).
//
// Run: node server/scripts/seed-homepage-cms.js [--force]
//   --force overwrites existing values with seed defaults

const path = require('path');
const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/archive.db');
const db = new Database(DB_PATH);

// Ensure table exists
require('../routes/homepage-cms.routes'); // imports + inits schema

const FORCE = process.argv.includes('--force');

const SEED = [
  // ─────────── HERO ───────────
  ['hero.title_line1',  'Training is a Science.',                     'text', 'hero', 'Hero — Title line 1', 1],
  ['hero.title_line2',  'Performing is an Art.',                      'text', 'hero', 'Hero — Title line 2', 2],
  ['hero.subtitle',     'A new home for India\'s artistic disciplines. Where masters and learners meet to keep tradition alive.', 'html', 'hero', 'Hero — Subtitle', 3],
  ['hero.cta_text',     'Explore Disciplines',                        'text', 'hero', 'Hero — CTA button text', 4],
  ['hero.cta_link',     '#disciplines',                               'url',  'hero', 'Hero — CTA link', 5],

  // ─────────── DISC: MELODY (Niladri Kumar) ───────────
  ['disc.melody.pill',         'Melody',                              'text', 'disc_melody', 'Melody — Pill text', 1],
  ['disc.melody.title',        'Sitara™ — Niladri Kumaar\'s Signature Sitar Program', 'text', 'disc_melody', 'Melody — Title', 2],
  ['disc.melody.instructor',   'NILADRI KUMAAR',                      'text', 'disc_melody', 'Melody — Instructor', 3],
  ['disc.melody.description',  'Sitara is a one of a kind experience. If you always wanted to play this beautiful instrument Sitar, this is a training program curated directly by the Maestro Niladri Kumaar. 5 generations of Sitar Music, now shared with you.', 'html', 'disc_melody', 'Melody — Description', 4],
  ['disc.melody.cta_text',     'Explore the Live Classes',            'text', 'disc_melody', 'Melody — CTA text', 5],
  ['disc.melody.cta_link',     '/live-classes/niladri-kumar',         'url',  'disc_melody', 'Melody — CTA link', 6],
  ['disc.melody.image_url',    '/assets/tfr-play/niladri-sitar-hero.png', 'image', 'disc_melody', 'Melody — Hero image', 7],

  // ─────────── DISC: RHYTHM (Taufiq Qureshi) ───────────
  ['disc.rhythm.pill',         'Rhythm',                              'text', 'disc_rhythm', 'Rhythm — Pill text', 1],
  ['disc.rhythm.title',        'Djembe and Indian Percussion',        'text', 'disc_rhythm', 'Rhythm — Title', 2],
  ['disc.rhythm.instructor',   'TAUFIQ QURESHI',                      'text', 'disc_rhythm', 'Rhythm — Instructor', 3],
  ['disc.rhythm.description',  'From absolute basics to advanced performance. This program is one of the most comprehensive Indian rhythm, grooves and percussion courses devised by the decades of training developed by the master himself.', 'html', 'disc_rhythm', 'Rhythm — Description', 4],
  ['disc.rhythm.cta_text',     'Explore Course',                      'text', 'disc_rhythm', 'Rhythm — CTA text', 5],
  ['disc.rhythm.cta_link',     '/experience/djembe-world-percussions','url',  'disc_rhythm', 'Rhythm — CTA link', 6],
  ['disc.rhythm.image_url',    '/assets/tfr-play/taufiq-djembe-hero.png', 'image', 'disc_rhythm', 'Rhythm — Hero image', 7],

  // ─────────── DISC: VOICE (placeholder) ───────────
  ['disc.voice.pill',          'Voice',                               'text', 'disc_voice', 'Voice — Pill text', 1],
  ['disc.voice.title',         'Vocal Mastery — Coming Soon',         'text', 'disc_voice', 'Voice — Title', 2],
  ['disc.voice.instructor',    'TO BE ANNOUNCED',                     'text', 'disc_voice', 'Voice — Instructor', 3],
  ['disc.voice.description',   'A comprehensive vocal training program covering Hindustani classical, semi-classical and contemporary styles. Curated by a renowned vocalist.', 'html', 'disc_voice', 'Voice — Description', 4],
  ['disc.voice.cta_text',      'Notify Me',                           'text', 'disc_voice', 'Voice — CTA text', 5],
  ['disc.voice.cta_link',      '#notify-voice',                       'url',  'disc_voice', 'Voice — CTA link', 6],
  ['disc.voice.image_url',     '',                                     'image', 'disc_voice', 'Voice — Hero image', 7],

  // ─────────── DISC: DANCE (placeholder) ───────────
  ['disc.dance.pill',          'Dance',                               'text', 'disc_dance', 'Dance — Pill text', 1],
  ['disc.dance.title',         'Classical & Contemporary Dance',      'text', 'disc_dance', 'Dance — Title', 2],
  ['disc.dance.instructor',    'TO BE ANNOUNCED',                     'text', 'disc_dance', 'Dance — Instructor', 3],
  ['disc.dance.description',   'From Bharatanatyam to contemporary fusion. A movement-first approach to Indian dance, taught by masters of multiple traditions.', 'html', 'disc_dance', 'Dance — Description', 4],
  ['disc.dance.cta_text',      'Notify Me',                           'text', 'disc_dance', 'Dance — CTA text', 5],
  ['disc.dance.cta_link',      '#notify-dance',                       'url',  'disc_dance', 'Dance — CTA link', 6],
  ['disc.dance.image_url',     '',                                     'image', 'disc_dance', 'Dance — Hero image', 7],

  // ─────────── DISC: PRACTICE ROOM ───────────
  ['disc.practice.pill',       'Practice Room',                       'text', 'disc_practice', 'Practice — Pill text', 1],
  ['disc.practice.title',      'The Practice Room — Your Riyaz Companion', 'text', 'disc_practice', 'Practice — Title', 2],
  ['disc.practice.instructor', 'FOR EVERY STUDENT',                   'text', 'disc_practice', 'Practice — Instructor', 3],
  ['disc.practice.description','A dedicated space where students upload their daily practice for personalised feedback from their instructor. Riyaz, reviewed, refined.', 'html', 'disc_practice', 'Practice — Description', 4],
  ['disc.practice.cta_text',   'Learn More',                          'text', 'disc_practice', 'Practice — CTA text', 5],
  ['disc.practice.cta_link',   '/student-practice-room-upload.html',  'url',  'disc_practice', 'Practice — CTA link', 6],
  ['disc.practice.image_url',  '',                                    'image', 'disc_practice', 'Practice — Hero image', 7],

  // ─────────── COMMUNITY (How It Works) ───────────
  ['community.title',          'A community of artists, in the making.', 'text', 'community', 'Community — Title', 1],
  ['community.subtitle',       'Built around live mentorship, structured riyaz, and the quiet discipline of returning every day.', 'html', 'community', 'Community — Subtitle', 2],

  // ─────────── CTA BANNER (bottom) ───────────
  ['cta_banner.title',         'Begin your journey.',                 'text', 'cta_banner', 'CTA Banner — Title', 1],
  ['cta_banner.subtitle',      'Choose your discipline. Choose your master. Train every day.', 'html', 'cta_banner', 'CTA Banner — Subtitle', 2],
  ['cta_banner.cta_text',      'Get Started',                         'text', 'cta_banner', 'CTA Banner — Button text', 3],
  ['cta_banner.cta_link',      '/signin.html',                        'url',  'cta_banner', 'CTA Banner — Button link', 4],

  // ─────────── FOOTER ───────────
  ['footer.tagline',           'Training is a Science. Performing is an Art.', 'text', 'footer', 'Footer — Tagline', 1],
  ['footer.contact_email',     'hello@thefoundationroom.in',          'text', 'footer', 'Footer — Contact email', 2],
  ['footer.contact_phone',     '',                                    'text', 'footer', 'Footer — Phone (optional)', 3],
  ['footer.address',           'Mumbai, India',                       'text', 'footer', 'Footer — Address', 4],
  ['footer.social_instagram',  '',                                    'url',  'footer', 'Footer — Instagram URL', 5],
  ['footer.social_youtube',    '',                                    'url',  'footer', 'Footer — YouTube URL', 6],
  ['footer.social_facebook',   '',                                    'url',  'footer', 'Footer — Facebook URL', 7],
];

const insIgnore = db.prepare(`
  INSERT OR IGNORE INTO homepage_content (key, value, value_type, section, label, sort_order, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`);
const upsert = db.prepare(`
  INSERT INTO homepage_content (key, value, value_type, section, label, sort_order, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    value_type = excluded.value_type,
    section = excluded.section,
    label = excluded.label,
    sort_order = excluded.sort_order,
    updated_at = datetime('now')
`);

let inserted = 0;
let kept = 0;
SEED.forEach(row => {
  const [key, value, value_type, section, label, sort_order] = row;
  if (FORCE) {
    upsert.run(key, value, value_type, section, label, sort_order);
    inserted++;
  } else {
    const r = insIgnore.run(key, value, value_type, section, label, sort_order);
    if (r.changes > 0) inserted++;
    else kept++;
  }
});

console.log('Seed complete.');
console.log('  inserted/overwrote: ' + inserted);
console.log('  kept (admin-edited): ' + kept);
console.log('  total keys in DB:   ' + db.prepare('SELECT COUNT(*) AS c FROM homepage_content').get().c);
db.close();
