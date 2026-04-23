// Razorpay webhook — mounted at /api/webhooks/razorpay, no auth middleware.
// Security: raw-body HMAC SHA-256 against RAZORPAY_WEBHOOK_SECRET.
// Idempotent: keyed on razorpay_payment_id, safe to redeliver.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { finalizePurchase } = require('./purchases.routes');

const DRY_RUN = (process.env.RAZORPAY_WEBHOOK_DRY_RUN || 'false').toLowerCase() === 'true';

// Use express.raw so the signature check sees the exact bytes Razorpay signed.
router.post(
  '/razorpay',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) {
        // Explicit: refuse rather than silently accept unverified events.
        return res.status(503).json({ error: 'Webhook not configured' });
      }

      const sig = req.headers['x-razorpay-signature'];
      if (!sig) return res.status(400).json({ error: 'Missing signature' });

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');

      // timingSafeEqual needs equal-length buffers; bail if not hex-equal length
      if (sig.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }

      const payload = JSON.parse(raw.toString('utf8'));
      const event = payload.event;
      const entity = payload?.payload?.payment?.entity || {};
      const orderId = entity.order_id;
      const paymentId = entity.id;

      if (DRY_RUN) {
        console.log('[razorpay-webhook] DRY RUN —', event, { orderId, paymentId });
        return res.json({ ok: true, dry_run: true, event });
      }

      if (!orderId) return res.json({ ignored: true, reason: 'no_order_id' });

      const purchase = db.prepare('SELECT * FROM purchases WHERE razorpay_order_id = ?').get(orderId);
      if (!purchase) return res.json({ ignored: true, reason: 'order_not_found' });

      // Idempotency: if we've already completed this purchase via /verify, skip.
      if (event === 'payment.captured' && purchase.status !== 'completed') {
        db.prepare(`
          UPDATE purchases SET status = 'completed', razorpay_payment_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(paymentId || null, purchase.id);
        finalizePurchase(purchase.id);
      } else if (event === 'payment.failed' && purchase.status === 'pending') {
        db.prepare("UPDATE purchases SET status = 'failed', updated_at = datetime('now') WHERE id = ?")
          .run(purchase.id);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[razorpay-webhook] error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
