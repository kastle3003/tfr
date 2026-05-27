// Homepage CMS — key/value content editor for tfrplay.com/index.html.
// New isolated table `homepage_content`, namespaced API at /api/homepage-cms.
// Public GET returns all keys for frontend hydration; admin endpoints gated by
// JWT + role middleware. Nothing else in the codebase is modified.

const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const role = require('../middleware/role');

const router = express.Router();

// ── Schema init (idempotent) ──
let initialised = false;
function init() {
  if (initialised) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS homepage_content (
      key TEXT PRIMARY KEY,
      value TEXT,
      value_type TEXT DEFAULT 'text',
      section TEXT,
      label TEXT,
      sort_order INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS hc_section_idx ON homepage_content(section, sort_order);
  `);
  initialised = true;
}
init();

// ── Public ──
// GET /api/homepage-cms  → flat map of key→value for cms-loader.js
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM homepage_content').all();
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin ──
const adminRouter = express.Router();
adminRouter.use(express.json({ limit: '12mb' }));
adminRouter.use(auth, role(['admin']));

// GET /api/homepage-cms/admin  → all rows with metadata, grouped by section
adminRouter.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT key, value, value_type, section, label, sort_order, updated_at
      FROM homepage_content
      ORDER BY section, sort_order, key
    `).all();
    const sections = {};
    rows.forEach(r => {
      const s = r.section || 'other';
      (sections[s] ||= []).push(r);
    });
    res.json({ sections, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/homepage-cms/admin/:key  body: { value }
adminRouter.put('/:key', (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body || {};
    if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
    const existing = db.prepare('SELECT key FROM homepage_content WHERE key = ?').get(key);
    if (!existing) return res.status(404).json({ error: 'key not found — use POST /admin/bulk to create new keys' });
    db.prepare(`UPDATE homepage_content SET value = ?, updated_at = datetime('now') WHERE key = ?`).run(value, key);
    res.json({ ok: true, key, value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/homepage-cms/admin/bulk  body: { updates: [{key, value, value_type?, section?, label?, sort_order?}] }
adminRouter.post('/bulk', (req, res) => {
  try {
    const { updates } = req.body || {};
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates must be an array' });
    const ins = db.prepare(`
      INSERT INTO homepage_content (key, value, value_type, section, label, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        value_type = COALESCE(excluded.value_type, homepage_content.value_type),
        section = COALESCE(excluded.section, homepage_content.section),
        label = COALESCE(excluded.label, homepage_content.label),
        sort_order = COALESCE(excluded.sort_order, homepage_content.sort_order),
        updated_at = datetime('now')
    `);
    const tx = db.transaction((arr) => {
      for (const u of arr) {
        if (!u || typeof u.key !== 'string') continue;
        ins.run(
          u.key,
          u.value == null ? '' : String(u.value),
          u.value_type || null,
          u.section || null,
          u.label || null,
          u.sort_order != null ? Number(u.sort_order) : null
        );
      }
    });
    tx(updates);
    res.json({ ok: true, count: updates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/homepage-cms/admin/upload  body: { filename, content_base64, mimetype }
const path = require('path');
const fs = require('fs');
adminRouter.post('/upload', (req, res) => {
  try {
    const { filename, content_base64, mimetype } = req.body || {};
    if (!filename || !content_base64) return res.status(400).json({ error: 'filename and content_base64 required' });
    const buf = Buffer.from(content_base64, 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'file too large (max 10MB)' });
    if (mimetype && !mimetype.startsWith('image/')) return res.status(400).json({ error: 'only image uploads allowed' });
    const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const dir = path.join(__dirname, '../../data/uploads/cms');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const final = `${Date.now()}-${safe}`;
    fs.writeFileSync(path.join(dir, final), buf);
    res.json({ ok: true, url: `/uploads/cms/${final}`, filename: final, size: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/homepage-cms/admin/:key
adminRouter.delete('/:key', (req, res) => {
  try {
    db.prepare('DELETE FROM homepage_content WHERE key = ?').run(req.params.key);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use('/admin', adminRouter);

module.exports = router;
