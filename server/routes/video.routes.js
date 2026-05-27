const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const https = require('https');
const http = require('http');
const db = require('../db');
const access = require('../lib/access');
const auth = require('../middleware/auth');
const storage = require('../lib/storage');

const TOKEN_TTL = 900; // 15 minutes

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || '').trim();
}

// GET /api/video/:material_id/token  — requires Bearer auth
// Returns a short-lived signed stream URL tied to this user + material + IP.
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

    // External video (YouTube etc.) — no token needed
    if (!m.url || !m.url.startsWith('/api/files/')) {
      return res.json({ stream_url: null, external_url: m.url });
    }

    const wasabiKey = m.url.replace(/^\/api\/files\//, '');

    // Bind token to: user, material, Wasabi key, and client IP
    const token = jwt.sign(
      { sub: 'vstream', mid: Number(m.id), uid: Number(req.user.id), key: wasabiKey, ip: clientIp(req) },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    res.json({ stream_url: `/api/video/stream/${token}`, expires_in: TOKEN_TTL });
  } catch (err) {
    console.error('[video/token]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/video/stream/:token
// Validates token (including IP match), then PROXIES the video bytes — the
// Wasabi presigned URL is never exposed to the client.
router.get('/stream/:token', async (req, res) => {
  try {
    let payload;
    try {
      payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).send('Video token expired. Please refresh the page and try again.');
    }

    if (payload.sub !== 'vstream' || !payload.key) {
      return res.status(400).send('Invalid video token');
    }

    // Reject if the request comes from a different IP than when the token was issued
    if (payload.ip && payload.ip !== clientIp(req)) {
      return res.status(403).send('Token IP mismatch');
    }

    if (!storage.wasabiEnabled()) {
      return res.status(503).send('Object storage not available');
    }

    const presigned = await storage.presignedUrl(payload.key, 60); // short TTL — only used once to proxy
    const parsedUrl = new URL(presigned);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    // Forward Range header so seek / partial content works
    const proxyHeaders = { 'User-Agent': 'TFR-Proxy/1.0' };
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;

    const proxyReq = lib.get(presigned, { headers: proxyHeaders }, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store, no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      // Block embedding this stream URL in other origins
      res.setHeader('Content-Security-Policy', "default-src 'none'");

      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      if (proxyRes.headers['content-range']) {
        res.setHeader('Content-Range', proxyRes.headers['content-range']);
      }

      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[video/stream proxy]', err.message);
      if (!res.headersSent) res.status(502).send('Stream error');
    });

    req.on('close', () => proxyReq.destroy());
  } catch (err) {
    console.error('[video/stream]', err.message);
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

module.exports = router;
