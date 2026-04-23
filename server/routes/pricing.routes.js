const express = require('express');
const router = express.Router();
const db = require('../db');
const access = require('../lib/access');
const pricing = require('../lib/pricing');

// GET /api/pricing/course/:id
// Everything the Enroll Now modal needs in one call.
router.get('/course/:id', (req, res) => {
  try {
    const courseId = parseInt(req.params.id, 10);
    if (!courseId) return res.status(400).json({ error: 'Invalid course id' });

    const course = access.getCourse(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const foundations = access.courseFoundations(courseId);
    const bundlePrice = pricing.bundlePricePaise(courseId);
    const ownsBundle = access.ownsBundle(req.user.id, courseId);

    const chapterRows = foundations.map((f, idx) => {
      const price = pricing.foundationPricePaise(f.id);
      const owned = ownsBundle || access.ownsFoundation(req.user.id, f.id);
      const elig = access.canPurchaseFoundation(req.user.id, f.id);
      return {
        id: f.id,
        title: f.title,
        order_index: f.order_index ?? idx,
        price_paise: price,
        owned,
        purchasable: elig.allowed,
        purchase_blocked_reason: elig.allowed ? null : elig.reason,
        purchase_blocked_by: elig.blocked_by || null,
      };
    });

    const chapterSumPaise = chapterRows.reduce((a, c) => a + c.price_paise, 0);
    const upgradePaise = ownsBundle ? 0 : pricing.upgradeToBundlePaise(req.user.id, courseId);
    const paidChaptersCount = chapterRows.filter(c => !ownsBundle && c.owned).length;

    res.json({
      course_id: courseId,
      title: course.title,
      currency: 'INR',
      bundle_price_paise: bundlePrice,
      chapters: chapterRows,
      chapters_sum_paise: chapterSumPaise,
      owns_bundle: ownsBundle,
      paid_chapters_count: paidChaptersCount,
      upgrade_to_bundle_paise: upgradePaise,
      upgrade_available: !ownsBundle && paidChaptersCount > 0 && bundlePrice > 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
