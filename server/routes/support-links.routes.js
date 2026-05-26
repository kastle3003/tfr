// Support links — external URLs attached to a course (e.g. raag content hosted
// on thefoundationroom.in). Visible to enrolled students + staff; managed by
// the course's instructor or any admin.

const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/role');
const access = require('../lib/access');

function isStaff(user) {
  return user && (user.role === 'admin' || user.role === 'instructor');
}

// Mirror the chapters.routes.js pattern: only the owning instructor or any admin
// can mutate support_links for a given course.
function canEditCourse(req, courseId) {
  if (req.user.role === 'admin') return true;
  if (req.user.role !== 'instructor') return false;
  const row = db.prepare('SELECT instructor_id FROM courses WHERE id = ?').get(courseId);
  return row && row.instructor_id === req.user.id;
}

// Validate URL is http(s) only — no javascript:, data:, file:, etc.
function isSafeHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// GET /api/support-links?course_id=X
// Visible to: enrolled students, owners of the bundle, anyone with at least one
// foundation purchase in the course, instructor/admin.
router.get('/', (req, res) => {
  try {
    const courseId = parseInt(req.query.course_id, 10);
    if (!courseId) return res.status(400).json({ error: 'course_id is required' });

    const userId = req.user && req.user.id;
    const staff = isStaff(req.user);
    let allowed = staff;
    if (!allowed && userId) {
      if (access.isEnrolled(userId, courseId)) allowed = true;
      else if (access.ownsBundle(userId, courseId)) allowed = true;
      else {
        const ownsAnyFoundation = db.prepare(`
          SELECT 1 FROM purchases
          WHERE user_id = ? AND course_id = ? AND status = 'completed'
          LIMIT 1
        `).get(userId, courseId);
        if (ownsAnyFoundation) allowed = true;
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Enroll in the course to view support links' });

    const links = db.prepare(`
      SELECT id, course_id, title, url, category, order_index, created_at
      FROM support_links
      WHERE course_id = ?
      ORDER BY order_index, id
    `).all(courseId);

    res.json({ links });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support-links — instructor (own course) or admin
router.post('/', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const { course_id, title, url, category, order_index } = req.body || {};
    if (!course_id || !title || !url) {
      return res.status(400).json({ error: 'course_id, title and url are required' });
    }
    if (!isSafeHttpUrl(url)) {
      return res.status(400).json({ error: 'url must be http(s)' });
    }
    if (!canEditCourse(req, course_id)) {
      return res.status(403).json({ error: 'Not authorized to edit this course' });
    }

    const nextOrder = order_index != null
      ? parseInt(order_index, 10) || 0
      : (db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM support_links WHERE course_id = ?').get(course_id).n);

    const result = db.prepare(`
      INSERT INTO support_links (course_id, title, url, category, order_index)
      VALUES (?, ?, ?, ?, ?)
    `).run(course_id, title, url, category || null, nextOrder);

    const link = db.prepare('SELECT * FROM support_links WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/support-links/:id
router.put('/:id', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM support_links WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Support link not found' });
    if (!canEditCourse(req, existing.course_id)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { title, url, category, order_index } = req.body || {};
    if (url != null && !isSafeHttpUrl(url)) {
      return res.status(400).json({ error: 'url must be http(s)' });
    }

    db.prepare(`
      UPDATE support_links
         SET title = ?, url = ?, category = ?, order_index = ?
       WHERE id = ?
    `).run(
      title != null ? title : existing.title,
      url != null ? url : existing.url,
      category !== undefined ? category : existing.category,
      order_index != null ? parseInt(order_index, 10) : existing.order_index,
      existing.id
    );

    const link = db.prepare('SELECT * FROM support_links WHERE id = ?').get(existing.id);
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/support-links/:id
router.delete('/:id', requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM support_links WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Support link not found' });
    if (!canEditCourse(req, existing.course_id)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    db.prepare('DELETE FROM support_links WHERE id = ?').run(existing.id);
    res.json({ message: 'Support link deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
