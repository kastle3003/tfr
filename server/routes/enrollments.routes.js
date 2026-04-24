const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/role');

// GET /api/enrollments/me
router.get('/me', (req, res) => {
  try {
    const enrollments = db.prepare(`
      SELECT e.*, c.title AS course_title, c.subtitle AS course_subtitle,
        c.cover_color, c.cover_accent, c.level, c.instrument, c.category,
        c.slug AS course_slug, c.lesson_count,
        u.first_name || ' ' || u.last_name AS instructor_name
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      LEFT JOIN users u ON c.instructor_id = u.id
      WHERE e.student_id = ?
      ORDER BY e.last_accessed_at DESC
    `).all(req.user.id);
    res.json({ enrollments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/enrollments/instructor  — accessible by instructor (own courses) and admin (all)
router.get('/instructor', (req, res) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const whereClause = req.user.role === 'admin' ? '' : 'WHERE c.instructor_id = ?';
    const params = req.user.role === 'admin' ? [] : [req.user.id];
    const students = db.prepare(`
      SELECT e.*, c.title AS course_title, c.level,
        u.first_name, u.last_name, u.email, u.avatar_initials, u.instrument,
        CASE
          WHEN e.progress_pct >= 80 THEN 'Excellent'
          WHEN e.progress_pct >= 50 THEN 'On Track'
          ELSE 'At Risk'
        END AS status_label,
        COALESCE(pur.status, pay.status, 'free') AS payment_status,
        COALESCE(pur.amount_paise, pay.amount_paise, 0) AS amount_paid_paise
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      JOIN users u ON e.student_id = u.id
      LEFT JOIN purchases pur ON pur.user_id = e.student_id AND pur.course_id = e.course_id AND pur.status = 'completed'
      LEFT JOIN payments pay ON pay.user_id = e.student_id AND pay.course_id = e.course_id AND pay.status = 'paid'
      ${whereClause}
      ORDER BY e.last_accessed_at DESC
    `).all(...params);
    res.json({ students });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/enrollments
router.post('/', (req, res) => {
  try {
    const { course_id } = req.body;
    if (!course_id) return res.status(400).json({ error: 'course_id is required' });

    const course = db.prepare('SELECT id FROM courses WHERE id = ?').get(course_id);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const existing = db.prepare('SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?').get(req.user.id, course_id);
    if (existing) return res.status(409).json({ error: 'Already enrolled in this course' });

    const result = db.prepare(`
      INSERT INTO enrollments (student_id, course_id, last_accessed_at)
      VALUES (?, ?, datetime('now'))
    `).run(req.user.id, course_id);

    const enrollment = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ enrollment, message: 'Enrolled successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/enrollments/:course_id
router.delete('/:course_id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM enrollments WHERE student_id = ? AND course_id = ?').run(req.user.id, req.params.course_id);
    if (result.changes === 0) return res.status(404).json({ error: 'Enrollment not found' });
    res.json({ message: 'Unenrolled successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
