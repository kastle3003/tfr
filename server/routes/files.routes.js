const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const storage = require('../lib/storage');

const TTL = 900; // 15 minutes for all presigned URLs

// Course/lesson content requires a valid JWT — these are the sensitive media files.
// Avatars, thumbnails and other public assets are not under these prefixes.
const PROTECTED_PREFIXES = /^(courses|lessons|recordings|sheet-music|submissions)\//;

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// GET /api/files/<any/key/with/slashes>
// Returns a 302 redirect to a short-lived Wasabi presigned URL.
// Course/lesson keys require a valid auth token.
router.get(/^\/(.+)$/, async (req, res) => {
  try {
    if (!storage.wasabiEnabled()) {
      return res.status(503).json({ error: 'Object storage not configured' });
    }
    const key = req.params[0];
    if (!key) return res.status(400).json({ error: 'Missing key' });

    if (PROTECTED_PREFIXES.test(key)) {
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ error: 'Authentication required' });
      try {
        jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }

    const url = await storage.presignedUrl(key, TTL);
    res.setHeader('Cache-Control', `private, max-age=${TTL}`);
    res.redirect(302, url);
  } catch (err) {
    console.error('[files] presign error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
