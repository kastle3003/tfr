'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireRole = require('../middleware/role');
const { persistUpload } = require('../lib/storage');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB for exercise videos
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isInstructorOrAdmin(user) {
  return ['instructor', 'admin'].includes(user.role);
}

function getSubmission(id) {
  return db.prepare(`
    SELECT s.*,
      l.title AS lesson_title,
      c.title AS course_title,
      c.instructor_id AS course_instructor_id,
      u.first_name || ' ' || u.last_name AS student_name,
      u.avatar_initials AS student_initials,
      u.email AS student_email,
      g.first_name || ' ' || g.last_name AS grader_name
    FROM submissions s
    LEFT JOIN lessons l ON s.lesson_id = l.id
    LEFT JOIN courses c ON s.course_id = c.id
    LEFT JOIN users u ON s.student_id = u.id
    LEFT JOIN users g ON s.graded_by = g.id
    WHERE s.id = ?
  `).get(id);
}

// ── GET /api/submissions — student's own, optionally filtered by lesson/course ──
router.get('/', (req, res) => {
  try {
    const { lesson_id, course_id } = req.query;

    if (isInstructorOrAdmin(req.user)) {
      // Instructors see all submissions for their courses
      let query = `
        SELECT s.*,
          l.title AS lesson_title,
          c.title AS course_title,
          u.first_name || ' ' || u.last_name AS student_name,
          u.avatar_initials AS student_initials,
          u.email AS student_email
        FROM submissions s
        LEFT JOIN lessons l ON s.lesson_id = l.id
        LEFT JOIN courses c ON s.course_id = c.id
        LEFT JOIN users u ON s.student_id = u.id
        WHERE 1=1
      `;
      const params = [];
      if (req.user.role === 'instructor') {
        query += ' AND c.instructor_id = ?'; params.push(req.user.id);
      }
      if (course_id) { query += ' AND s.course_id = ?'; params.push(course_id); }
      if (lesson_id) { query += ' AND s.lesson_id = ?'; params.push(lesson_id); }
      query += ' ORDER BY s.submitted_at DESC';
      return res.json({ submissions: db.prepare(query).all(...params) });
    }

    // Students see only their own
    let query = `
      SELECT s.*,
        l.title AS lesson_title,
        c.title AS course_title,
        g.first_name || ' ' || g.last_name AS grader_name
      FROM submissions s
      LEFT JOIN lessons l ON s.lesson_id = l.id
      LEFT JOIN courses c ON s.course_id = c.id
      LEFT JOIN users g ON s.graded_by = g.id
      WHERE s.student_id = ?
    `;
    const params = [req.user.id];
    if (course_id) { query += ' AND s.course_id = ?'; params.push(course_id); }
    if (lesson_id) { query += ' AND s.lesson_id = ?'; params.push(lesson_id); }
    query += ' ORDER BY s.submitted_at DESC';
    res.json({ submissions: db.prepare(query).all(...params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Alias: GET /api/submissions/me — own submissions ──
router.get('/me', (req, res) => {
  try {
    const submissions = db.prepare(`
      SELECT s.*, l.title AS lesson_title, c.title AS course_title,
        g.first_name || ' ' || g.last_name AS grader_name
      FROM submissions s
      LEFT JOIN lessons l ON s.lesson_id = l.id
      LEFT JOIN courses c ON s.course_id = c.id
      LEFT JOIN users g ON s.graded_by = g.id
      WHERE s.student_id = ?
      ORDER BY s.submitted_at DESC
    `).all(req.user.id);
    res.json({ submissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/submissions/review?course_id= — instructor review queue ──
router.get('/review', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const { course_id, status } = req.query;
    let query = `
      SELECT s.*,
        l.title AS lesson_title,
        c.title AS course_title,
        u.first_name || ' ' || u.last_name AS student_name,
        u.avatar_initials AS student_initials,
        u.email AS student_email
      FROM submissions s
      LEFT JOIN lessons l ON s.lesson_id = l.id
      LEFT JOIN courses c ON s.course_id = c.id
      LEFT JOIN users u ON s.student_id = u.id
      WHERE (c.instructor_id = ? OR s.instructor_id = ?)
    `;
    const params = [req.user.id, req.user.id];
    if (course_id) { query += ' AND s.course_id = ?'; params.push(course_id); }
    if (status) { query += ' AND s.status = ?'; params.push(status); }
    else { query += " AND s.status IN ('pending', 'reviewed')"; }
    query += ' ORDER BY s.submitted_at DESC';
    res.json({ submissions: db.prepare(query).all(...params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Alias: GET /api/submissions/instructor — review queue (compat) ──
router.get('/instructor', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const submissions = db.prepare(`
      SELECT s.*, l.title AS lesson_title, c.title AS course_title,
        u.first_name AS student_first, u.last_name AS student_last,
        u.avatar_initials, u.email AS student_email
      FROM submissions s
      LEFT JOIN lessons l ON s.lesson_id = l.id
      LEFT JOIN courses c ON s.course_id = c.id
      LEFT JOIN users u ON s.student_id = u.id
      WHERE c.instructor_id = ?
      ORDER BY s.submitted_at DESC
    `).all(req.user.id);
    res.json({ submissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/submissions — student submits video (file upload OR URL) ──
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { lesson_id, course_id, recording_id, notes, title, video_url, duration_seconds } = req.body;

    let stored_path = null;
    let wasabi_key = null;
    let ext_video_url = video_url ? video_url.trim() : null;

    if (req.file) {
      stored_path = await persistUpload(req.file, 'submissions');
      if (stored_path && stored_path.startsWith('/api/files/')) {
        wasabi_key = stored_path.replace('/api/files/', '');
      }
    }

    // Determine which columns we're setting
    const result = db.prepare(`
      INSERT INTO submissions (
        student_id, lesson_id, course_id, recording_id,
        file_path, notes, status,
        title, video_key, video_url, duration_seconds, submitted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, datetime('now'))
    `).run(
      req.user.id,
      lesson_id || null,
      course_id || null,
      recording_id || null,
      stored_path || null,
      notes || null,
      title || null,
      wasabi_key || null,
      ext_video_url || null,
      duration_seconds ? parseInt(duration_seconds, 10) : null
    );

    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ submission });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/submissions/:id/feedback — instructor gives text feedback ──
router.put('/:id/feedback', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const { feedback_text, feedback } = req.body;
    const text = feedback_text || feedback || '';
    if (!text.trim()) return res.status(400).json({ error: 'feedback_text is required' });

    const submission = db.prepare(`
      SELECT s.*, c.instructor_id AS course_instructor_id
      FROM submissions s
      LEFT JOIN courses c ON s.course_id = c.id
      WHERE s.id = ?
    `).get(req.params.id);

    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.course_instructor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized for this submission' });
    }

    db.prepare(`
      UPDATE submissions
      SET feedback_text = ?, feedback = ?, feedback_at = datetime('now'),
          graded_by = ?, graded_at = datetime('now'), status = 'reviewed', instructor_id = ?
      WHERE id = ?
    `).run(text, text, req.user.id, req.user.id, req.params.id);

    const updated = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);

    // Notify student by email (best-effort)
    (async () => {
      try {
        const studentRow = db.prepare('SELECT email, first_name FROM users WHERE id = ?').get(updated.student_id);
        const mailer = require('../lib/mailer');
        const tmpl = db.prepare(`SELECT subject, html_body FROM email_templates WHERE name = 'submission_feedback'`).get();
        if (tmpl && studentRow) {
          const courseTitle = updated.course_title || 'your course';
          const html = (tmpl.html_body || '').replace(/\{\{first_name\}\}/g, studentRow.first_name || 'Student')
            .replace(/\{\{course\}\}/g, courseTitle)
            .replace(/\{\{feedback\}\}/g, text.replace(/\n/g, '<br>'));
          await mailer.send({ to: studentRow.email, subject: tmpl.subject || 'Instructor feedback on your submission', html });
        }
      } catch (_) {}
    })();

    res.json({ submission: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/submissions/:id/grade — legacy grading endpoint (compat) ──
router.put('/:id/grade', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const { grade, feedback } = req.body;
    if (!grade) return res.status(400).json({ error: 'Grade is required' });

    const submission = db.prepare(`
      SELECT s.* FROM submissions s
      JOIN courses c ON s.course_id = c.id
      WHERE s.id = ? AND (c.instructor_id = ? OR ? = 'admin')
    `).get(req.params.id, req.user.id, req.user.role);

    if (!submission) return res.status(404).json({ error: 'Submission not found or not authorized' });

    db.prepare(`
      UPDATE submissions
      SET grade = ?, feedback = ?, feedback_text = ?, graded_by = ?,
          graded_at = datetime('now'), feedback_at = datetime('now'), status = 'graded'
      WHERE id = ?
    `).run(grade, feedback || null, feedback || null, req.user.id, req.params.id);

    const updated = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
    res.json({ submission: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/submissions/:id — student can delete own pending submission ──
router.delete('/:id', (req, res) => {
  try {
    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    if (submission.student_id !== req.user.id && !isInstructorOrAdmin(req.user)) {
      return res.status(403).json({ error: 'Not your submission' });
    }
    if (submission.student_id === req.user.id && submission.status !== 'pending') {
      return res.status(400).json({ error: 'Can only delete pending submissions' });
    }

    db.prepare('DELETE FROM submissions WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
