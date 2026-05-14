const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');

// GET /api/quotes/random — public (no auth required, used by student dashboard)
router.get('/random', (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes ORDER BY RANDOM() LIMIT 1').get();
    if (!quote) return res.status(404).json({ error: 'No quotes found' });
    res.json({ quote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quotes — list all (admin/instructor)
router.get('/', auth, (req, res) => {
  try {
    if (!['admin', 'instructor'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const quotes = db.prepare('SELECT * FROM quotes ORDER BY id DESC').all();
    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quotes — add quote (admin only)
router.post('/', auth, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { text, attribution } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });
    const result = db.prepare('INSERT INTO quotes (text, attribution) VALUES (?, ?)').run(text, attribution || null);
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ quote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/quotes/:id — admin only
router.delete('/:id', auth, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const result = db.prepare('DELETE FROM quotes WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json({ message: 'Quote deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
