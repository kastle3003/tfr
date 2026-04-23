const express = require('express');
const router = express.Router();
const db = require('../db');
const access = require('../lib/access');
const pricing = require('../lib/pricing');

function isAdmin(user) {
  return user && (user.role === 'admin' || user.role === 'instructor');
}

// ── Student: validate a coupon against a prospective purchase ─────────────
// POST /api/coupons/validate
// Body: { code, type: 'bundle'|'individual'|'upgrade', course_id?, foundation_id? }
router.post('/validate', (req, res) => {
  try {
    const { code, type, course_id, foundation_id } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });
    if (!['bundle', 'individual', 'upgrade'].includes(type)) {
      return res.status(400).json({ error: "type must be 'bundle', 'individual', or 'upgrade'" });
    }

    let baseAmount = 0;
    let resolvedCourseId = course_id;
    let couponApplyType = type;

    if (type === 'individual') {
      if (!foundation_id) return res.status(400).json({ error: 'foundation_id is required' });
      const f = access.getFoundation(foundation_id);
      if (!f) return res.status(404).json({ error: 'Foundation not found' });
      resolvedCourseId = f.course_id;
      baseAmount = pricing.foundationPricePaise(foundation_id);
    } else if (type === 'bundle') {
      if (!course_id) return res.status(400).json({ error: 'course_id is required' });
      baseAmount = pricing.bundlePricePaise(course_id);
    } else {
      // upgrade → treated as bundle for coupon-applicability
      if (!course_id) return res.status(400).json({ error: 'course_id is required' });
      baseAmount = pricing.upgradeToBundlePaise(req.user.id, course_id);
      couponApplyType = 'bundle';
    }

    if (baseAmount <= 0) {
      return res.status(400).json({ error: 'Nothing to discount' });
    }

    const result = pricing.applyCoupon({
      code,
      type: couponApplyType,
      course_id: resolvedCourseId,
      amount_paise: baseAmount,
    });
    if (result.error) return res.status(400).json({ error: result.error });

    res.json({
      valid: true,
      base_paise: baseAmount,
      discount_paise: result.discount_paise,
      final_paise: result.final_paise,
      coupon: {
        code: result.coupon.code,
        discount_type: result.coupon.discount_type,
        discount_value: result.coupon.discount_value,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: CRUD ───────────────────────────────────────────────────────────

// GET /api/coupons/admin — list all
router.get('/admin', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const rows = db.prepare(`
      SELECT c.*, co.title AS course_title
      FROM coupons c
      LEFT JOIN courses co ON c.course_id = co.id
      ORDER BY c.created_at DESC
    `).all();
    res.json({ coupons: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coupons/admin — create
router.post('/admin', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const {
      code, description, discount_type, discount_value,
      applies_to = 'both', course_id = null, max_redemptions = null,
      expires_at = null, active = 1,
    } = req.body || {};

    if (!code || !discount_type || discount_value == null) {
      return res.status(400).json({ error: 'code, discount_type, discount_value are required' });
    }
    if (!['pct', 'flat'].includes(discount_type)) {
      return res.status(400).json({ error: "discount_type must be 'pct' or 'flat'" });
    }
    if (!['bundle', 'individual', 'both'].includes(applies_to)) {
      return res.status(400).json({ error: "applies_to must be 'bundle', 'individual', or 'both'" });
    }
    if (discount_type === 'pct' && (discount_value < 0 || discount_value > 100)) {
      return res.status(400).json({ error: 'Percentage must be 0-100' });
    }
    if (discount_value < 0) return res.status(400).json({ error: 'discount_value must be >= 0' });

    const result = db.prepare(`
      INSERT INTO coupons (code, description, discount_type, discount_value,
                           applies_to, course_id, max_redemptions, expires_at,
                           active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code.trim().toUpperCase(),
      description || '',
      discount_type,
      Number(discount_value),
      applies_to,
      course_id || null,
      max_redemptions != null ? Number(max_redemptions) : null,
      expires_at || null,
      active ? 1 : 0,
      req.user.id
    );

    const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ coupon });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Coupon code already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/coupons/admin/:id — update (description/active/expires/max)
router.patch('/admin/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM coupons WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Coupon not found' });

    const fields = ['description', 'active', 'expires_at', 'max_redemptions', 'applies_to', 'course_id'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (f in req.body) {
        sets.push(`${f} = ?`);
        params.push(req.body[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });
    sets.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE coupons SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(id);
    res.json({ coupon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/coupons/admin/:id — soft delete (deactivate)
router.delete('/admin/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    db.prepare("UPDATE coupons SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coupons/admin/:id/redemptions
router.get('/admin/:id/redemptions', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const id = parseInt(req.params.id, 10);
    const rows = db.prepare(`
      SELECT r.*, u.email, u.first_name, u.last_name, p.amount_paise AS purchase_amount_paise
      FROM coupon_redemptions r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN purchases p ON r.purchase_id = p.id
      WHERE r.coupon_id = ?
      ORDER BY r.created_at DESC
    `).all(id);
    res.json({ redemptions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
