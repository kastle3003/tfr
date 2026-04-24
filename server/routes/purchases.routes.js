const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const access = require('../lib/access');
const pricing = require('../lib/pricing');
const rzpGuard = require('../lib/razorpay-guard');
const mailer = require('../lib/mailer');
const { emitEmail } = require('./progress.routes');

// Razorpay client — TEST KEYS ONLY. Live keys are refused at server boot by
// razorpay-guard; here we additionally require the rzp_test_ prefix before
// building the client so a misconfigured env never reaches real money.
let razorpay = null;
if (rzpGuard.canUseSdk()) {
  try {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  } catch (e) { /* razorpay dep missing, stay in mock mode */ }
}

// Safety rails (env-driven, default permissive for dev)
const paymentsEnabled = () => (process.env.PAYMENTS_ENABLED || 'true').toLowerCase() !== 'false';
const maxOrderPaise = () => Number(process.env.MAX_ORDER_PAISE) || 50_000_00; // ₹50,000 ceiling

// ── POST /api/purchases ────────────────────────────────────────────────────
// Body: { type: 'bundle'|'individual'|'upgrade', course_id?, foundation_id?, coupon_code? }
router.post('/', async (req, res) => {
  try {
    if (!paymentsEnabled()) {
      return res.status(503).json({ error: 'Payments are temporarily disabled' });
    }

    const { type, course_id, foundation_id, coupon_code } = req.body || {};
    if (!type || !['bundle', 'individual', 'upgrade'].includes(type)) {
      return res.status(400).json({ error: "type must be 'bundle', 'individual', or 'upgrade'" });
    }

    let course = null;
    let foundation = null;
    let baseAmount = 0;
    let isUpgrade = 0;
    let storedType = type; // what we store in purchases.type (upgrade is stored as 'bundle')

    if (type === 'bundle') {
      if (!course_id) return res.status(400).json({ error: 'course_id is required for a bundle purchase' });
      course = access.getCourse(course_id);
      if (!course) return res.status(404).json({ error: 'Course not found' });
      if (access.ownsBundle(req.user.id, course_id)) {
        return res.status(409).json({ error: 'You already own this bundle' });
      }
      baseAmount = pricing.bundlePricePaise(course.id);
    } else if (type === 'upgrade') {
      if (!course_id) return res.status(400).json({ error: 'course_id is required for upgrade' });
      course = access.getCourse(course_id);
      if (!course) return res.status(404).json({ error: 'Course not found' });
      if (access.ownsBundle(req.user.id, course_id)) {
        return res.status(409).json({ error: 'You already own this bundle' });
      }
      baseAmount = pricing.upgradeToBundlePaise(req.user.id, course.id);
      if (baseAmount <= 0) {
        return res.status(400).json({ error: 'Nothing to upgrade — either no foundations owned or bundle already covered' });
      }
      isUpgrade = 1;
      storedType = 'bundle'; // upgrade grants bundle access
    } else {
      // individual
      if (!foundation_id) return res.status(400).json({ error: 'foundation_id is required for an individual purchase' });
      foundation = access.getFoundation(foundation_id);
      if (!foundation) return res.status(404).json({ error: 'Foundation not found' });
      course = access.getCourse(foundation.course_id);

      const elig = access.canPurchaseFoundation(req.user.id, foundation_id);
      if (!elig.allowed) {
        return res.status(403).json({
          error: 'Foundation cannot be purchased yet',
          reason: elig.reason,
          blocked_by: elig.blocked_by,
        });
      }
      baseAmount = pricing.foundationPricePaise(foundation.id);
    }

    if (baseAmount < 0) return res.status(400).json({ error: 'Invalid price' });

    // Apply coupon (server-side only — ignore any client-sent discount)
    let finalAmount = baseAmount;
    let discount = 0;
    let couponRow = null;
    if (coupon_code) {
      const couponType = (type === 'upgrade' || type === 'bundle') ? 'bundle' : 'individual';
      const applied = pricing.applyCoupon({
        code: coupon_code,
        type: couponType,
        course_id: course?.id,
        amount_paise: baseAmount,
      });
      if (applied.error) return res.status(400).json({ error: applied.error });
      finalAmount = applied.final_paise;
      discount = applied.discount_paise;
      couponRow = applied.coupon;
    }

    // Ceiling guard
    if (finalAmount > maxOrderPaise()) {
      return res.status(400).json({
        error: `Order amount exceeds configured ceiling (${maxOrderPaise()} paise)`,
      });
    }

    // Create a Razorpay order (or a mock one)
    let order;
    if (razorpay && finalAmount > 0) {
      order = await razorpay.orders.create({
        amount: finalAmount,
        currency: 'INR',
        receipt: `musicapp_${type}_${req.user.id}_${Date.now()}`,
        notes: {
          app: 'musicapp',
          user_id: String(req.user.id),
          type,
          course_id: course?.id ? String(course.id) : '',
          foundation_id: foundation?.id ? String(foundation.id) : '',
          coupon_code: couponRow?.code || '',
        },
      });
    } else {
      order = {
        id: `order_mock_${Date.now()}`,
        amount: finalAmount,
        currency: 'INR',
        status: 'created',
      };
    }

    const ins = db.prepare(`
      INSERT INTO purchases (user_id, course_id, foundation_id, type, status,
                             amount_paise, currency, razorpay_order_id,
                             coupon_id, discount_paise, is_upgrade)
      VALUES (?, ?, ?, ?, 'pending', ?, 'INR', ?, ?, ?, ?)
    `).run(
      req.user.id,
      course ? course.id : null,
      foundation ? foundation.id : null,
      storedType,
      finalAmount,
      order.id,
      couponRow?.id || null,
      discount,
      isUpgrade
    );

    // A zero-price purchase is auto-completed (full coupon discount, free bundle, etc.)
    if (finalAmount === 0) {
      finalizePurchase(ins.lastInsertRowid);
    }

    res.status(201).json({
      purchase_id: ins.lastInsertRowid,
      order_id: order.id,
      amount_paise: finalAmount,
      base_paise: baseAmount,
      discount_paise: discount,
      currency: 'INR',
      key_id: rzpGuard.publicKeyId(),
      auto_completed: finalAmount === 0,
    });
  } catch (err) {
    // Razorpay SDK errors don't always set .message — surface whatever we can.
    const rzpErr = err?.error?.description || err?.error?.reason || err?.description;
    const msg = err?.message || rzpErr || (typeof err === 'string' ? err : '') || 'Unknown purchase error';
    console.error('[purchases.POST /] error:', {
      message: err?.message,
      statusCode: err?.statusCode,
      rzpError: err?.error,
      stack: err?.stack,
    });
    res.status(500).json({ error: msg, razorpay_error: err?.error || null });
  }
});

// POST /api/purchases/verify
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post('/verify', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id) return res.status(400).json({ error: 'razorpay_order_id is required' });

    const purchase = db.prepare('SELECT * FROM purchases WHERE razorpay_order_id = ? AND user_id = ?')
      .get(razorpay_order_id, req.user.id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'completed') return res.json({ message: 'Already completed', purchase_id: purchase.id });

    // Real verification (only when secret is configured)
    if (process.env.RAZORPAY_KEY_SECRET && razorpay_payment_id && razorpay_signature) {
      const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');
      if (expected !== razorpay_signature) {
        db.prepare("UPDATE purchases SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(purchase.id);
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    db.prepare(`
      UPDATE purchases
         SET status = 'completed', razorpay_payment_id = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(razorpay_payment_id || null, purchase.id);

    finalizePurchase(purchase.id);

    res.json({ message: 'Payment verified', purchase_id: purchase.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchases/me — purchases owned by the current user
router.get('/me', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*,
             c.title AS course_title,
             ch.title AS foundation_title
      FROM purchases p
      LEFT JOIN courses  c  ON p.course_id = c.id
      LEFT JOIN chapters ch ON p.foundation_id = ch.id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
    `).all(req.user.id);
    res.json({ purchases: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchases/eligibility?foundation_id=X
router.get('/eligibility', (req, res) => {
  try {
    const { foundation_id } = req.query;
    if (!foundation_id) return res.status(400).json({ error: 'foundation_id is required' });
    res.json(access.canPurchaseFoundation(req.user.id, parseInt(foundation_id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Post-payment side effects ──────────────────────────────────────────────
function finalizePurchase(purchaseId) {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  if (!p || p.status !== 'completed') return;

  // Record coupon redemption (idempotent — only once per purchase)
  if (p.coupon_id && p.discount_paise > 0) {
    const existing = db.prepare('SELECT id FROM coupon_redemptions WHERE purchase_id = ?').get(p.id);
    if (!existing) {
      db.prepare(`
        INSERT INTO coupon_redemptions (coupon_id, user_id, purchase_id, amount_discounted_paise)
        VALUES (?, ?, ?, ?)
      `).run(p.coupon_id, p.user_id, p.id, p.discount_paise);
      db.prepare("UPDATE coupons SET redemptions_used = redemptions_used + 1, updated_at = datetime('now') WHERE id = ?")
        .run(p.coupon_id);
    }
  }

  // Resolve the course id either directly or via the foundation.
  let courseId = p.course_id;
  if (!courseId && p.foundation_id) {
    const f = access.getFoundation(p.foundation_id);
    if (f) courseId = f.course_id;
  }
  if (courseId) {
    db.prepare(`INSERT OR IGNORE INTO enrollments (student_id, course_id, last_accessed_at) VALUES (?, ?, datetime('now'))`)
      .run(p.user_id, courseId);
  }

  // Friendly item name for the receipt email.
  let itemName = 'your purchase';
  if (p.type === 'bundle' && courseId) {
    const c = db.prepare('SELECT title FROM courses WHERE id = ?').get(courseId);
    itemName = c ? `${c.title} — full bundle` : itemName;
  } else if (p.type === 'individual' && p.foundation_id) {
    const f = db.prepare('SELECT title FROM chapters WHERE id = ?').get(p.foundation_id);
    itemName = f ? `${f.title}` : itemName;
  }

  emitEmail(p.user_id, 'payment_success', {
    purchase_id: p.id,
    amount_paise: p.amount_paise,
    order_id: p.razorpay_order_id || '',
    payment_id: p.razorpay_payment_id || '',
    item_name: itemName,
  });
  if (p.type === 'bundle') {
    emitEmail(p.user_id, p.is_upgrade ? 'course_upgraded' : 'course_unlocked', { course_id: courseId });
  } else if (p.type === 'individual') {
    emitEmail(p.user_id, 'foundation_unlocked', { foundation_id: p.foundation_id });
  }
}

module.exports = router;
module.exports.finalizePurchase = finalizePurchase;
