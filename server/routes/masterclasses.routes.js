const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/role');

// GET /api/masterclasses
router.get('/', (req, res) => {
  try {
    const { status, limit } = req.query;
    let query = `
      SELECT m.*, u.first_name || ' ' || u.last_name AS instructor_name,
        (SELECT COUNT(*) FROM masterclass_registrations WHERE masterclass_id = m.id) AS registered_count
      FROM masterclasses m
      LEFT JOIN users u ON m.instructor_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (status) { query += ' AND m.status = ?'; params.push(status); }
    query += ' ORDER BY m.scheduled_at ASC';
    if (limit) { query += ' LIMIT ?'; params.push(parseInt(limit)); }

    const masterclasses = db.prepare(query).all(...params);

    // For each, check if current user is registered
    const registered = db.prepare('SELECT masterclass_id FROM masterclass_registrations WHERE student_id = ?').all(req.user.id);
    const registeredSet = new Set(registered.map(r => r.masterclass_id));

    const result = masterclasses.map(m => ({ ...m, is_registered: registeredSet.has(m.id) }));
    res.json({ masterclasses: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/masterclasses/:id
router.get('/:id', (req, res) => {
  try {
    const masterclass = db.prepare(`
      SELECT m.*, u.first_name || ' ' || u.last_name AS instructor_name, u.bio AS instructor_bio,
        (SELECT COUNT(*) FROM masterclass_registrations WHERE masterclass_id = m.id) AS registered_count
      FROM masterclasses m
      LEFT JOIN users u ON m.instructor_id = u.id
      WHERE m.id = ?
    `).get(req.params.id);
    if (!masterclass) return res.status(404).json({ error: 'Masterclass not found' });

    const isRegistered = db.prepare('SELECT id FROM masterclass_registrations WHERE masterclass_id = ? AND student_id = ?').get(req.params.id, req.user.id);
    res.json({ masterclass: { ...masterclass, is_registered: !!isRegistered } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/masterclasses/:id/register
router.post('/:id/register', (req, res) => {
  try {
    const masterclass = db.prepare('SELECT * FROM masterclasses WHERE id = ?').get(req.params.id);
    if (!masterclass) return res.status(404).json({ error: 'Masterclass not found' });

    const registeredCount = db.prepare('SELECT COUNT(*) as count FROM masterclass_registrations WHERE masterclass_id = ?').get(req.params.id);
    if (masterclass.max_participants && registeredCount.count >= masterclass.max_participants) {
      return res.status(409).json({ error: 'Masterclass is full' });
    }

    try {
      db.prepare('INSERT INTO masterclass_registrations (masterclass_id, student_id) VALUES (?, ?)').run(req.params.id, req.user.id);
      res.status(201).json({ message: 'Registered successfully' });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already registered' });
      throw e;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/masterclasses — instructor only
router.post('/', requireRole('instructor'), (req, res) => {
  try {
    const { title, scheduled_at, duration_minutes, location, meeting_url, max_participants, description } = req.body;
    if (!title || !scheduled_at) return res.status(400).json({ error: 'Title and scheduled_at are required' });

    const result = db.prepare(`
      INSERT INTO masterclasses (title, instructor_id, scheduled_at, duration_minutes, location, meeting_url, max_participants, description, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
    `).run(title, req.user.id, scheduled_at, duration_minutes || 90, location || null, meeting_url || null, max_participants || 20, description || null);

    const masterclass = db.prepare('SELECT * FROM masterclasses WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ masterclass });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
