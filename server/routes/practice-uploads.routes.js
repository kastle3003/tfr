'use strict';
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const db       = require('../db');
const requireRole = require('../middleware/role');
const { persistUpload, streamObject } = require('../lib/storage');

// Accept video/* and audio/* (mp3, wav, m4a, aac, mp4, mov, webm, mkv, avi…)
const ALLOWED_MIME = /^(video\/|audio\/)/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only video and audio files are allowed'));
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(user) { return user.role === 'admin'; }

function isEnrolledAny(userId) {
  return db.prepare('SELECT 1 FROM enrollments WHERE student_id = ? LIMIT 1').get(userId);
}

// ── GET /api/practice-uploads — student's own uploads ────────────────────────
router.get('/', (req, res) => {
  try {
    const uploads = db.prepare(`
      SELECT pu.*, c.title AS course_title
      FROM practice_uploads pu
      LEFT JOIN courses c ON pu.course_id = c.id
      WHERE pu.student_id = ?
      ORDER BY pu.created_at DESC
    `).all(req.user.id);
    res.json({ uploads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/practice-uploads/admin — admin sees all users' uploads ───────────
router.get('/admin', requireRole(['admin']), (req, res) => {
  try {
    const uploads = db.prepare(`
      SELECT pu.*,
        u.first_name || ' ' || u.last_name AS student_name,
        u.email AS student_email,
        u.avatar_initials AS student_initials,
        c.title AS course_title
      FROM practice_uploads pu
      JOIN users u ON pu.student_id = u.id
      LEFT JOIN courses c ON pu.course_id = c.id
      ORDER BY pu.created_at DESC
    `).all();
    res.json({ uploads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/practice-uploads — student uploads practice video/audio ─────────
router.post('/', upload.single('file'), async (req, res) => {
  try {
    // Must be enrolled in at least one course
    if (!isAdmin(req.user) && !isEnrolledAny(req.user.id)) {
      return res.status(403).json({ error: 'You must be enrolled in a course to upload practice recordings' });
    }

    const { title, course_id, notes, duration_seconds } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!req.file) return res.status(400).json({ error: 'A video or audio file is required' });

    const stored = await persistUpload(req.file, 'practice-uploads');
    let wasabi_key = null;
    if (stored && stored.startsWith('/api/files/')) {
      wasabi_key = stored.replace('/api/files/', '');
    } else {
      // local fallback — shouldn't happen in production but handle gracefully
      wasabi_key = stored ? stored.replace(/^\//, '') : null;
    }

    const type = req.file.mimetype.startsWith('audio/') ? 'audio' : 'video';

    const result = db.prepare(`
      INSERT INTO practice_uploads
        (student_id, course_id, title, type, wasabi_key, file_size, duration_seconds, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      course_id ? parseInt(course_id, 10) : null,
      title.trim(),
      type,
      wasabi_key,
      req.file.size || null,
      duration_seconds ? parseInt(duration_seconds, 10) : null,
      notes ? notes.trim() : null
    );

    const upload_row = db.prepare('SELECT * FROM practice_uploads WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ upload: upload_row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/practice-uploads/:id/stream — inline stream (student own / admin) ─
router.get('/:id/stream', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM practice_uploads WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Only owner or admin can stream
    if (row.student_id !== req.user.id && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    if (!row.wasabi_key) return res.status(404).json({ error: 'No file associated' });

    await streamObject(row.wasabi_key, res);
  } catch (err) {
    console.error('[practice-uploads] stream error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/practice-uploads/:id — owner or admin ────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM practice_uploads WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (row.student_id !== req.user.id && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    db.prepare('DELETE FROM practice_uploads WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
