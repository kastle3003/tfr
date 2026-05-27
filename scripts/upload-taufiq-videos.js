/**
 * upload-taufiq-videos.js
 *
 * 1. Extracts FA/FB/FC/FD zips from ~/Downloads
 * 2. Uploads every .mp4 to Wasabi  (bucket: thefoundationroom1)
 *    → key:  videos/djembe/<fa|fb|fc|fd>/<filename>
 *    → DB url: /api/files/videos/djembe/<fa|fb|fc|fd>/<filename>
 * 3. Replaces existing dummy lessons in chapters 6/7/8/9
 *    with real lessons linked to their Wasabi URLs.
 *    Order for FA: Start Playing (1) → Pledge (2) → FA_1..FA_14 (3..16)
 *
 * Run:  node scripts/upload-taufiq-videos.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const db   = require('../server/db');

// ── Config ──────────────────────────────────────────────────────────────────
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const WORK_DIR  = path.join(os.tmpdir(), 'tfr-djembe-upload');
const BUCKET    = process.env.WASABI_BUCKET    || 'thefoundationroom1';
const REGION    = process.env.WASABI_REGION    || 'ap-southeast-1';
const ENDPOINT  = process.env.WASABI_ENDPOINT  || `https://s3.${REGION}.wasabisys.com`;
const ACCESS_KEY = process.env.WASABI_ACCESS_KEY;
const SECRET_KEY = process.env.WASABI_SECRET_KEY;

const ZIPS = [
  { zip: 'FA-20260424T114106Z-3-001.zip', folder: 'FA', chapter_id: 6, prefix: 'fa' },
  { zip: 'FB-20260424T120018Z-3-001.zip', folder: 'FB', chapter_id: 7, prefix: 'fb' },
  { zip: 'FC-20260424T120019Z-3-001.zip', folder: 'FC', chapter_id: 8, prefix: 'fc' },
  { zip: 'FD-20260424T120020Z-3-001.zip', folder: 'FD', chapter_id: 9, prefix: 'fd' },
];

const COURSE_ID = 2; // Djembe & World Percussions (Taufiq Qureshi)

// ── S3 client ───────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: false,
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) { process.stdout.write(msg + '\n'); }
function progress(msg) { process.stdout.write('\r\x1b[2K' + msg); }

function sortVideos(files) {
  // For FA: put "Start Playing" first, "Pledge" second, then FA_N numerically
  // For FB/FC/FD: sort F*_N numerically
  const startPlaying = files.find(f => /start.playing/i.test(f));
  const pledge       = files.find(f => /pledge/i.test(f));
  const numbered     = files
    .filter(f => !(/start.playing/i.test(f)) && !(/pledge/i.test(f)))
    .sort((a, b) => {
      const numA = parseInt((a.match(/_(\d+)\.mp4$/i) || [,'0'])[1], 10);
      const numB = parseInt((b.match(/_(\d+)\.mp4$/i) || [,'0'])[1], 10);
      return numA - numB;
    });

  const ordered = [];
  if (startPlaying) ordered.push(startPlaying);
  if (pledge)       ordered.push(pledge);
  ordered.push(...numbered);
  return ordered;
}

function lessonTitle(filename, chapter, idx) {
  const base = path.basename(filename, '.mp4');
  if (/start.playing/i.test(base)) return 'Start Playing';
  if (/pledge/i.test(base))        return 'The Pledge';
  // FA_3 → "Lesson 3" etc.
  const m = base.match(/_(\d+)$/);
  if (m) return `${chapter} — Lesson ${m[1]}`;
  return base;
}

async function uploadFile(localPath, key) {
  const stat = fs.statSync(localPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  const name = path.basename(localPath);

  progress(`  Uploading ${name} (${sizeMB} MB)…`);

  const stream = fs.createReadStream(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: stream,
    ContentType: 'video/mp4',
    ContentLength: stat.size,
  }));

  log(`  ✓ ${name} → ${key}`);
  return `/api/files/${key}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!ACCESS_KEY || !SECRET_KEY) {
    log('ERROR: WASABI_ACCESS_KEY / WASABI_SECRET_KEY not set in .env');
    process.exit(1);
  }

  // Prepare work dir
  if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

  for (const { zip, folder, chapter_id, prefix } of ZIPS) {
    const zipPath = path.join(DOWNLOADS, zip);
    if (!fs.existsSync(zipPath)) {
      log(`SKIP: ${zip} not found in Downloads`);
      continue;
    }

    // ── 1. Extract ──────────────────────────────────────────────────────────
    const destDir = path.join(WORK_DIR, folder);
    if (!fs.existsSync(destDir)) {
      log(`\nExtracting ${zip}…`);
      execSync(`unzip -o "${zipPath}" -d "${WORK_DIR}"`, { stdio: 'inherit' });
    } else {
      log(`\nAlready extracted ${folder}, skipping unzip.`);
    }

    const videoDir = path.join(destDir);
    const allFiles = fs.readdirSync(videoDir).filter(f => /\.mp4$/i.test(f));
    const ordered  = sortVideos(allFiles);

    log(`  Found ${ordered.length} videos in ${folder}: ${ordered.join(', ')}`);

    // ── 2. Upload to Wasabi ─────────────────────────────────────────────────
    log(`\nUploading ${folder} to Wasabi…`);
    const lessonData = [];

    for (let i = 0; i < ordered.length; i++) {
      const filename = ordered[i];
      const localPath = path.join(videoDir, filename);
      const safeName = filename.replace(/\s+/g, '_');
      const key = `videos/djembe/${prefix}/${safeName}`;

      const dbUrl = await uploadFile(localPath, key);
      const title = lessonTitle(filename, folder, i);
      lessonData.push({ order_index: i + 1, title, content_url: dbUrl });
    }

    // ── 3. Seed DB ──────────────────────────────────────────────────────────
    log(`\nSeeding DB for ${folder} (chapter_id=${chapter_id})…`);

    // Remove old dummy lessons
    db.prepare('DELETE FROM lessons WHERE chapter_id = ?').run(chapter_id);

    // Insert real lessons
    const insertLesson = db.prepare(`
      INSERT INTO lessons (chapter_id, course_id, title, order_index, type, content_url)
      VALUES (?, ?, ?, ?, 'video', ?)
    `);
    for (const l of lessonData) {
      insertLesson.run(chapter_id, COURSE_ID, l.title, l.order_index, l.content_url);
      log(`  + [${l.order_index}] ${l.title}`);
    }

    // Update lesson_count on the course
    const totalLessons = db.prepare('SELECT COUNT(*) AS c FROM lessons WHERE course_id = ?').get(COURSE_ID).c;
    db.prepare('UPDATE courses SET lesson_count = ? WHERE id = ?').run(totalLessons, COURSE_ID);

    log(`  ✓ ${folder} done — ${lessonData.length} lessons seeded.`);
  }

  // Final summary
  const allLessons = db.prepare(`
    SELECT ch.title AS chapter, l.order_index, l.title, l.content_url
    FROM lessons l JOIN chapters ch ON l.chapter_id = ch.id
    WHERE ch.course_id = 2
    ORDER BY ch.order_index, l.order_index
  `).all();

  log('\n══════════════════════════════════════');
  log(`DONE — ${allLessons.length} total lessons for Taufiq Qureshi's course.`);
  log('══════════════════════════════════════');
  allLessons.forEach(l => log(`  [${l.chapter}] ${l.order_index}. ${l.title}`));
  log('');
})();
