const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/quotes/random
router.get('/random', (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes ORDER BY RANDOM() LIMIT 1').get();
    if (!quote) return res.status(404).json({ error: 'No quotes found' });
    res.json({ quote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
