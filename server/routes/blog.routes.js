const express = require('express');
const router = express.Router();
const db = require('../db');

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Public endpoints ──────────────────────────────────────────────────────────

// GET / — list published posts
router.get('/', (req, res) => {
  try {
    const { category, limit = 10, offset = 0 } = req.query;
    let sql = `
      SELECT b.id, b.title, b.slug, b.excerpt, b.cover_image, b.category, b.tags,
             u.first_name || ' ' || u.last_name AS author_name,
             b.published_at, b.views
      FROM blogs b
      LEFT JOIN users u ON b.author_id = u.id
      WHERE b.status = 'published'
    `;
    const params = [];
    if (category) {
      sql += ` AND b.category = ?`;
      params.push(category);
    }
    sql += ` ORDER BY b.published_at DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const posts = db.prepare(sql).all(...params);
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug — single published post
router.get('/:slug', (req, res) => {
  try {
    const post = db.prepare(`
      SELECT b.*,
             u.first_name || ' ' || u.last_name AS author_name,
             u.bio AS author_bio,
             u.avatar_initials AS author_initials
      FROM blogs b
      LEFT JOIN users u ON b.author_id = u.id
      WHERE b.slug = ? AND b.status = 'published'
    `).get(req.params.slug);

    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Increment views
    db.prepare(`UPDATE blogs SET views = views + 1 WHERE id = ?`).run(post.id);
    post.views = post.views + 1;

    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

// GET /admin — all posts (any status), paginated
router.get('/admin', adminOnly, (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const posts = db.prepare(`
      SELECT b.*,
             u.first_name || ' ' || u.last_name AS author_name
      FROM blogs b
      LEFT JOIN users u ON b.author_id = u.id
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `).all(Number(limit), Number(offset));
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin — create post
router.post('/admin', adminOnly, (req, res) => {
  try {
    const { title, body, excerpt, cover_image, category, tags, status, published_at } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

    const slug = slugify(title);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const resolvedPublishedAt = status === 'published' ? (published_at || now) : (published_at || null);

    const result = db.prepare(`
      INSERT INTO blogs (title, slug, excerpt, body, cover_image, author_id, category, tags, status, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title, slug, excerpt || null, body, cover_image || null,
      req.user.id, category || 'general', tags || '[]',
      status || 'draft', resolvedPublishedAt
    );

    const post = db.prepare('SELECT * FROM blogs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ post });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A post with this slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/:id — update post
router.put('/admin/:id', adminOnly, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM blogs WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Post not found' });

    const { title, body, excerpt, cover_image, category, tags, status, published_at } = req.body;

    const newTitle = title !== undefined ? title : existing.title;
    const newSlug = title ? slugify(title) : existing.slug;
    const newStatus = status !== undefined ? status : existing.status;

    let newPublishedAt = published_at !== undefined ? published_at : existing.published_at;
    if (newStatus === 'published' && !newPublishedAt) {
      newPublishedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    db.prepare(`
      UPDATE blogs SET
        title = ?, slug = ?, excerpt = ?, body = ?, cover_image = ?,
        category = ?, tags = ?, status = ?, published_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      newTitle,
      newSlug,
      excerpt !== undefined ? excerpt : existing.excerpt,
      body !== undefined ? body : existing.body,
      cover_image !== undefined ? cover_image : existing.cover_image,
      category !== undefined ? category : existing.category,
      tags !== undefined ? tags : existing.tags,
      newStatus,
      newPublishedAt,
      now,
      req.params.id
    );

    const post = db.prepare('SELECT * FROM blogs WHERE id = ?').get(req.params.id);
    res.json({ post });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A post with this slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/:id — delete post
router.delete('/admin/:id', adminOnly, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM blogs WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Post not found' });

    db.prepare('DELETE FROM blogs WHERE id = ?').run(req.params.id);
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
