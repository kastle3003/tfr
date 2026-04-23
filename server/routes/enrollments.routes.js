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
        c.lesson_count, u.first_name || ' ' || u.last_name AS instructor_name
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

// GET /api/enrollments/instructor
router.get('/instructor', requireRole('instructor'), (req, res) => {
  try {
    const students = db.prepare(`
      SELECT e.*, c.title AS course_title, c.level,
        u.first_name, u.last_name, u.email, u.avatar_initials, u.instrument,
        CASE
          WHEN e.progress_pct >= 80 THEN 'Excellent'
          WHEN e.progress_pct >= 50 THEN 'On Track'
          ELSE 'At Risk'
        END AS status_label
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      JOIN users u ON e.student_id = u.id
      WHERE c.instructor_id = ?
      ORDER BY e.last_accessed_at DESC
    `).all(req.user.id);
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
