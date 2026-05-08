// One-shot migration: copy /data/notify-interest.json rows into the
// notify_interest table. Idempotent — skips rows whose (email, created_at)
// already exists. Renames the JSON file to .bak after a successful first run
// to avoid double-migration on re-run; subsequent runs are safe no-ops.
//
// Run: node server/scripts/migrate-notify-interest.js

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/archive.db');
const JSON_PATH = process.env.NOTIFY_JSON_PATH || path.join(__dirname, '../../data/notify-interest.json');

function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.log(`No source file at ${JSON_PATH}; nothing to migrate.`);
    return;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse ${JSON_PATH}:`, e.message);
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error('JSON file is not an array; aborting.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const insert = db.prepare(`
    INSERT INTO notify_interest (email, phone, course, tier, type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const exists = db.prepare(`
    SELECT id FROM notify_interest WHERE email = ? AND created_at = ?
  `);

  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const email = (r.email || '').trim();
      if (!email) { skipped++; continue; }
      const createdAt = r.at || r.created_at || new Date().toISOString();
      if (exists.get(email, createdAt)) { skipped++; continue; }
      insert.run(
        email,
        r.phone || null,
        r.course || null,
        r.tier || null,
        r.type || 'waitlist',
        createdAt
      );
      inserted++;
    }
  });

  tx(raw);

  console.log(`Migrated: ${inserted} inserted, ${skipped} skipped.`);
  console.log(`Total now in DB: ${db.prepare('SELECT COUNT(*) AS n FROM notify_interest').get().n}`);

  // Rename source file so we don't repeat. Safe no-op on subsequent runs.
  const bak = JSON_PATH + '.bak-' + Date.now();
  try {
    fs.renameSync(JSON_PATH, bak);
    console.log(`Source renamed to: ${bak}`);
  } catch (e) {
    console.warn('Could not rename source file:', e.message);
  }
}

main();
