const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
const access = require('../lib/access');
const auth = require('../middleware/auth');
const storage = require('../lib/storage');

const TOKEN_TTL = 900; // 15 minutes — covers most lesson videos

// GET /api/video/:material_id/token  — requires Bearer auth
// Returns a short-lived signed stream URL tied to this user + material.
router.get('/:material_id/token', auth, async (req, res) => {
  try {
    const m = db.prepare('SELECT * FROM lesson_materials WHERE id = ?').get(req.params.material_id);
    if (!m) return res.status(404).json({ error: 'Material not found' });
    if (m.type !== 'video') return res.status(400).json({ error: 'Not a video material' });

    const lesson = access.getLesson(m.lesson_id);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    const acc = access.canAccessLecture(req.user, lesson.id);
    if (!acc.allowed) {
      return res.status(403).json({ error: 'Access denied', reason: acc.reason, blocked_by: acc.blocked_by });
    }

    // External video (YouTube etc.) — no token needed, return flag only
    if (!m.url || !m.url.startsWith('/api/files/')) {
      return res.json({ stream_url: null, external_url: m.url });
    }

    const wasabiKey = m.url.replace(/^\/api\/files\//, '');

    // Sign a token embedding the key so stream endpoint never touches the DB
    const token = jwt.sign(
      { sub: 'vstream', mid: Number(m.id), uid: Number(req.user.id), key: wasabiKey },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    res.json({ stream_url: `/api/video/stream/${token}`, expires_in: TOKEN_TTL });
  } catch (err) {
    console.error('[video/token]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/video/stream/:token  — no Bearer header needed; auth is the token itself
// Validates the signed token and issues a short-lived Wasabi presigned redirect.
router.get('/stream/:token', async (req, res) => {
  try {
    let payload;
    try {
      payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).send('Video token expired. Please refresh the page and try again.');
    }

    if (payload.sub !== 'vstream' || !payload.key) {
      return res.status(400).json({ error: 'Invalid video token' });
    }

    if (!storage.wasabiEnabled()) {
      return res.status(503).json({ error: 'Object storage not available' });
    }

    const presigned = await storage.presignedUrl(payload.key, TOKEN_TTL);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.redirect(302, presigned);
  } catch (err) {
    console.error('[video/stream]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
