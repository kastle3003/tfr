// Pricing helpers — single source of truth for amounts.
// Routes MUST call these; never trust client-sent amounts.

const db = require('../db');
const access = require('./access');

function bundlePricePaise(courseId) {
  const row = db.prepare('SELECT bundle_price_paise FROM courses WHERE id = ?').get(courseId);
  return Number(row?.bundle_price_paise) || 0;
}

function foundationPricePaise(foundationId) {
  const row = db.prepare('SELECT price_individual_paise FROM chapters WHERE id = ?').get(foundationId);
  return Number(row?.price_individual_paise) || 0;
}

// Pro-rated upgrade: bundle price minus what the user has already paid for
// individual foundations in this course. Completed purchases only. Floor at 0.
function upgradeToBundlePaise(userId, courseId) {
  const bundle = bundlePricePaise(courseId);
  if (bundle <= 0) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_paise), 0) AS paid_paise
    FROM purchases
    WHERE user_id = ? AND course_id = ? AND type = 'individual' AND status = 'completed'
  `).get(userId, courseId);
  const paid = Number(row?.paid_paise) || 0;
  return Math.max(0, bundle - paid);
}

// Apply a coupon to a base amount. Returns { final_paise, discount_paise, coupon }.
// Validates: active, not expired, redemptions remaining, applies_to matches,
// course_id scope matches if set. Does NOT mutate counters — do that on purchase verify.
function applyCoupon({ code, type, course_id, amount_paise }) {
  if (!code) return { final_paise: amount_paise, discount_paise: 0, coupon: null };
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').get(code.trim());
  if (!coupon) return { error: 'coupon_not_found' };
  if (!coupon.active) return { error: 'coupon_inactive' };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return { error: 'coupon_expired' };
  if (coupon.max_redemptions != null && coupon.redemptions_used >= coupon.max_redemptions) {
    return { error: 'coupon_exhausted' };
  }
  if (coupon.applies_to !== 'both' && coupon.applies_to !== type) {
    return { error: 'coupon_not_applicable' };
  }
  if (coupon.course_id && course_id && coupon.course_id !== course_id) {
    return { error: 'coupon_wrong_course' };
  }

  let discount = 0;
  if (coupon.discount_type === 'pct') {
    discount = Math.floor((amount_paise * coupon.discount_value) / 100);
  } else {
    discount = coupon.discount_value;
  }
  discount = Math.min(discount, amount_paise);
  return {
    final_paise: amount_paise - discount,
    discount_paise: discount,
    coupon,
  };
}

module.exports = {
  bundlePricePaise,
  foundationPricePaise,
  upgradeToBundlePaise,
  applyCoupon,
};
