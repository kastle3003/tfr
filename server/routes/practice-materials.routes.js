'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireRole = require('../middleware/role');
const { persistUpload, streamObject, wasabiEnabled } = require('../lib/storage');
const path = require('path');
const fs = require('fs');

// 500 MB limit — videos can be large (mp4, mov, mkv, avi, webm, etc.)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Accept PDF + all video/* MIME types (mp4, webm, ogg, mov, mkv, avi, wmv, flv, m4v, 3gp…)
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('video/')) return cb(null, true);
    cb(new Error('Only PDF and video files are allowed'));
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEnrolled(userId, courseId) {
  return db.prepare('SELECT 1 FROM enrollments WHERE student_id = ? AND course_id = ?').get(userId, courseId);
}

function isInstructorOrAdmin(user) {
  return ['instructor', 'admin'].includes(user.role);
}

// ── GET /api/practice-materials?course_id= ──────────────────────────────────
// Students (enrolled) and instructors can list materials for a course.
router.get('/', (req, res) => {
  try {
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ error: 'course_id is required' });

    if (!isInstructorOrAdmin(req.user) && !isEnrolled(req.user.id, course_id)) {
      return res.status(403).json({ error: 'Not enrolled in this course' });
    }

    const materials = db.prepare(`
      SELECT id, course_id, title, type, order_index,
        CASE WHEN wasabi_key IS NOT NULL THEN 'upload' ELSE 'url' END AS source,
        CASE WHEN type = 'pdf' THEN '/api/practice-materials/' || id || '/view'
             WHEN wasabi_key IS NOT NULL THEN '/api/practice-materials/' || id || '/view'
             ELSE url END AS view_url,
        created_at
      FROM practice_materials
      WHERE course_id = ?
      ORDER BY order_index ASC, created_at ASC
    `).all(course_id);

    res.json({ materials });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/practice-materials — instructor/admin uploads PDF or adds URL ──
router.post('/', requireRole(['instructor', 'admin']), upload.single('file'), async (req, res) => {
  try {
    const { course_id, title, type, url, order_index } = req.body;
    if (!course_id || !title) return res.status(400).json({ error: 'course_id and title are required' });

    let wasabi_key = null;
    let ext_url = null;

    if (req.file) {
      // Uploaded file
      const stored = await persistUpload(req.file, 'practice-materials');
      // Strip the /api/files/ prefix if Wasabi — store the raw key in wasabi_key
      if (stored && stored.startsWith('/api/files/')) {
        wasabi_key = stored.replace('/api/files/', '');
      } else {
        // local fallback — store URL directly as ext_url
        ext_url = stored;
      }
    } else if (url) {
      ext_url = url.trim();
    } else {
      return res.status(400).json({ error: 'Either a file upload or a URL is required' });
    }

    const materialType = type || (req.file && req.file.mimetype === 'application/pdf' ? 'pdf' : 'video');

    const result = db.prepare(`
      INSERT INTO practice_materials (course_id, title, type, wasabi_key, url, order_index)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      course_id, title, materialType,
      wasabi_key, ext_url,
      parseInt(order_index, 10) || 0
    );

    const material = db.prepare('SELECT * FROM practice_materials WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ material });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/practice-materials/:id — instructor/admin edits title/order ──
router.put('/:id', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const { title, order_index } = req.body;
    const mat = db.prepare('SELECT * FROM practice_materials WHERE id = ?').get(req.params.id);
    if (!mat) return res.status(404).json({ error: 'Material not found' });

    db.prepare(`
      UPDATE practice_materials SET
        title = COALESCE(?, title),
        order_index = COALESCE(?, order_index)
      WHERE id = ?
    `).run(title || null, order_index != null ? parseInt(order_index, 10) : null, req.params.id);

    const updated = db.prepare('SELECT * FROM practice_materials WHERE id = ?').get(req.params.id);
    res.json({ material: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/practice-materials/:id — instructor/admin removes ──
router.delete('/:id', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const mat = db.prepare('SELECT * FROM practice_materials WHERE id = ?').get(req.params.id);
    if (!mat) return res.status(404).json({ error: 'Material not found' });
    db.prepare('DELETE FROM practice_materials WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/practice-materials/:id/view — inline stream (no S3 URL exposed) ──
router.get('/:id/view', async (req, res) => {
  try {
    const mat = db.prepare('SELECT * FROM practice_materials WHERE id = ?').get(req.params.id);
    if (!mat) return res.status(404).json({ error: 'Material not found' });

    // Auth: enrolled student or instructor/admin
    if (!isInstructorOrAdmin(req.user) && !isEnrolled(req.user.id, mat.course_id)) {
      return res.status(403).json({ error: 'Not enrolled in this course' });
    }

    if (mat.wasabi_key) {
      // Stream directly from Wasabi without exposing presigned URL
      await streamObject(mat.wasabi_key, res);
      return;
    }

    if (mat.url) {
      // External URL — for PDF we can iframe it; for video just redirect
      // But to keep the no-download policy, redirect is acceptable for external URLs
      // (we can't proxy arbitrary external sources)
      return res.redirect(302, mat.url);
    }

    res.status(404).json({ error: 'No file associated with this material' });
  } catch (err) {
    console.error('[practice-materials] view error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
