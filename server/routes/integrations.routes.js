// Per-instructor Google OAuth connection management. The flow:
//   1. Instructor (or admin) hits GET /auth-url → returns Google consent URL
//      with state = signed-JWT carrying user id and return-to path.
//   2. User consents on Google, browser is redirected to /callback?code=...&state=...
//      The callback verifies state, exchanges code → tokens, stores them, then
//      302s the user back to the return path.
//   3. Status endpoint reports connected/disconnected for the UI badge.
//   4. DELETE clears tokens.

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const requireRole = require('../middleware/role');
const authMiddleware = require('../middleware/auth');
const calendarLib = require('../lib/google-calendar');

const STATE_TTL_SECONDS = 600; // 10 minutes — plenty for the round trip

// GET /api/integrations/google/auth-url?return_to=/admin-panel.html#integrations
router.get('/google/auth-url', authMiddleware, requireRole(['instructor', 'admin']), (req, res) => {
  try {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
      return res.status(503).json({ error: 'Google OAuth is not configured on the server' });
    }
    const returnTo = (req.query.return_to && typeof req.query.return_to === 'string')
      ? req.query.return_to
      : '/admin-panel.html';
    // State carries: userId + returnTo, signed with JWT_SECRET so attackers
    // can't craft callbacks that finalize as another user.
    const state = jwt.sign({ uid: req.user.id, rt: returnTo }, process.env.JWT_SECRET, { expiresIn: STATE_TTL_SECONDS });
    const url = calendarLib.getAuthUrl(state);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/integrations/google/callback?code=...&state=...
// Public — Google sends the user here. State JWT carries the user identity.
// (We must not require Bearer auth because the redirect is a normal browser GET.)
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query || {};
    if (error) {
      return res.redirect(`/admin-panel.html?google_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }
    let payload;
    try {
      payload = jwt.verify(state, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(400).send('Invalid or expired state. Try connecting again.');
    }
    if (!payload.uid) return res.status(400).send('State missing user id');

    await calendarLib.exchangeCodeAndStore(payload.uid, code);
    const rt = (typeof payload.rt === 'string' && payload.rt.startsWith('/')) ? payload.rt : '/admin-panel.html';
    const sep = rt.includes('?') ? '&' : '?';
    res.redirect(`${rt}${sep}google_connected=1`);
  } catch (err) {
    console.error('[google/callback] error:', err);
    res.redirect(`/admin-panel.html?google_error=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/integrations/google/status
router.get('/google/status', authMiddleware, requireRole(['instructor', 'admin']), (req, res) => {
  try {
    const connected = calendarLib.isConnected(req.user.id);
    res.json({
      connected,
      configured: !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/integrations/google
router.delete('/google', authMiddleware, requireRole(['instructor', 'admin']), (req, res) => {
  try {
    calendarLib.disconnect(req.user.id);
    res.json({ message: 'Google Calendar disconnected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
