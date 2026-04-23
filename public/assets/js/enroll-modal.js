// Shared Enroll/Buy modal — loaded by course-landing.html and student-course-detail.html.
// Depends on: a JWT in localStorage['archive_token'] and Razorpay Checkout JS being loaded.

(function () {
  const TOKEN_KEY = 'archive_token';
  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const fmtINR = (paise) => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const escapeHTML = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function openEnrollModal(courseId) {
    if (!getToken()) {
      sessionStorage.setItem('tfr_enroll_after_login', courseId);
      window.location.href = '/login#panel-register';
      return;
    }
    let overlay = document.getElementById('em-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'em-overlay';
      overlay.className = 'em-overlay';
      overlay.innerHTML = `<div class="em-modal" id="em-modal"></div>`;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEnrollModal(); });
      document.body.appendChild(overlay);
    }
    overlay.classList.add('open');
    document.getElementById('em-modal').innerHTML = '<p style="padding:24px;text-align:center;color:#a09889">Loading pricing…</p>';

    try {
      const r = await fetch(`/api/pricing/course/${courseId}`, {
        headers: { Authorization: 'Bearer ' + getToken() }
      });
      if (r.status === 401) {
        sessionStorage.setItem('tfr_enroll_after_login', courseId);
        window.location.href = '/login#panel-register';
        return;
      }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load pricing');
      renderEnrollModal(data);
    } catch (err) {
      document.getElementById('em-modal').innerHTML = `<p style="color:#e78a8a">Failed to load pricing: ${escapeHTML(err.message)}</p>`;
    }
  }

  function closeEnrollModal() {
    const overlay = document.getElementById('em-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function renderEnrollModal(data) {
    const modal = document.getElementById('em-modal');
    modal._data = data;
    modal._activeTab = 'bundle';
    modal._coupon = null;

    if (data.owns_bundle) {
      modal.innerHTML = `
        <button class="em-close" onclick="closeEnrollModal()">×</button>
        <h2 class="em-title">You own this course</h2>
        <p class="em-subtitle">Head to your dashboard to continue learning.</p>
        <div class="em-primary-row">
          <button class="em-btn em-btn-ghost" onclick="closeEnrollModal()">Close</button>
          <button class="em-btn" onclick="window.location.href='/student-dashboard.html'">Go to Dashboard →</button>
        </div>`;
      return;
    }

    const hasBundle = data.bundle_price_paise > 0;
    const hasChapters = data.chapters.some(c => c.price_paise > 0);

    modal.innerHTML = `
      <button class="em-close" onclick="closeEnrollModal()">×</button>
      <h2 class="em-title">${escapeHTML(data.title)}</h2>
      <p class="em-subtitle">Choose how you'd like to learn. Chapters unlock A → E in sequence.</p>
      <div class="em-tabs">
        ${hasBundle ? `<button class="em-tab active" data-tab="bundle" onclick="emSwitchTab('bundle')">Full Bundle</button>` : ''}
        ${hasChapters ? `<button class="em-tab${hasBundle ? '' : ' active'}" data-tab="chapters" onclick="emSwitchTab('chapters')">Chapter by Chapter</button>` : ''}
      </div>
      <div class="em-pane active" data-pane="bundle">${renderBundlePane(data)}</div>
      <div class="em-pane" data-pane="chapters">${renderChaptersPane(data)}</div>
      <div class="em-coupon">
        <div class="em-coupon-row">
          <input id="em-coupon-input" placeholder="Coupon code (optional)" maxlength="32" oninput="this.value = this.value.toUpperCase()">
          <button class="em-btn em-btn-ghost" onclick="applyCoupon()">Apply</button>
        </div>
        <div id="em-coupon-msg" class="em-coupon-msg"></div>
      </div>`;

    if (!hasBundle && hasChapters) {
      modal._activeTab = 'chapters';
      modal.querySelectorAll('.em-pane').forEach(p => p.classList.remove('active'));
      modal.querySelector('[data-pane="chapters"]').classList.add('active');
    }
  }

  function renderBundlePane(data) {
    if (data.bundle_price_paise <= 0) return '<p style="color:#a09889">Bundle pricing not set.</p>';
    const header = `
      <div class="em-row">
        <div class="em-row-main">
          <span class="em-row-title">Complete bundle</span>
          <span class="em-row-note">All chapters · lifetime access · sequential unlock</span>
        </div>
        <span class="em-row-price">${fmtINR(data.bundle_price_paise)}</span>
      </div>`;

    let upgradeHTML = '';
    if (data.upgrade_available) {
      upgradeHTML = `
        <div class="em-upgrade">
          <div class="em-upgrade-title">Upgrade to full bundle</div>
          <p class="em-upgrade-note">You've already paid for ${data.paid_chapters_count} chapter${data.paid_chapters_count === 1 ? '' : 's'}. Pro-rated upgrade price shown below.</p>
          <div class="em-summary-row"><span>Upgrade price</span><span>${fmtINR(data.upgrade_to_bundle_paise)}</span></div>
          <div class="em-primary-row">
            <button class="em-btn" onclick="startPurchase('upgrade')">Upgrade — ${fmtINR(data.upgrade_to_bundle_paise)}</button>
          </div>
        </div>`;
    }

    return header + `
      <div class="em-summary">
        <div class="em-summary-row"><span>Bundle</span><span>${fmtINR(data.bundle_price_paise)}</span></div>
        <div class="em-summary-row total"><span>Total</span><span id="em-total-bundle">${fmtINR(data.bundle_price_paise)}</span></div>
      </div>
      <div class="em-primary-row">
        <button class="em-btn em-btn-ghost" onclick="closeEnrollModal()">Cancel</button>
        <button class="em-btn" id="em-buy-bundle" onclick="startPurchase('bundle')">Buy Bundle — ${fmtINR(data.bundle_price_paise)}</button>
      </div>${upgradeHTML}`;
  }

  function renderChaptersPane(data) {
    const rows = data.chapters.map((c, idx) => {
      const letter = String.fromCharCode(65 + idx);
      if (c.owned) {
        return `<div class="em-row owned">
          <div class="em-row-main">
            <span class="em-row-title">${letter}. ${escapeHTML(c.title)}</span>
            <span class="em-row-note">Owned</span>
          </div>
          <span class="em-row-price">—</span>
        </div>`;
      }
      if (c.purchasable) {
        return `<div class="em-row">
          <div class="em-row-main">
            <span class="em-row-title">${letter}. ${escapeHTML(c.title)}</span>
            <span class="em-row-note">Available to purchase</span>
          </div>
          <span class="em-row-price">${fmtINR(c.price_paise)}</span>
          <button class="em-btn" onclick="startPurchase('individual', ${c.id})">Buy</button>
        </div>`;
      }
      return `<div class="em-row locked">
        <div class="em-row-main">
          <span class="em-row-title">${letter}. ${escapeHTML(c.title)}</span>
          <span class="em-row-note">🔒 Unlock previous chapter first</span>
        </div>
        <span class="em-row-price">${fmtINR(c.price_paise)}</span>
      </div>`;
    });
    return rows.join('') +
      `<p style="font-size:12px;color:#a09889;margin-top:10px">Chapters sum: ${fmtINR(data.chapters_sum_paise)} · Bundle: ${data.bundle_price_paise > 0 ? fmtINR(data.bundle_price_paise) : '—'}</p>`;
  }

  function emSwitchTab(tab) {
    const modal = document.getElementById('em-modal');
    modal._activeTab = tab;
    modal.querySelectorAll('.em-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    modal.querySelectorAll('.em-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
  }

  async function applyCoupon() {
    const modal = document.getElementById('em-modal');
    const data = modal._data;
    const input = document.getElementById('em-coupon-input');
    const msg = document.getElementById('em-coupon-msg');
    const code = (input.value || '').trim();
    msg.className = 'em-coupon-msg';
    msg.textContent = '';
    if (!code) { modal._coupon = null; return; }

    const applyType = modal._activeTab === 'chapters' ? 'individual' : 'bundle';
    let foundation_id = null;
    if (applyType === 'individual') {
      const nxt = data.chapters.find(c => c.purchasable && !c.owned);
      if (!nxt) { msg.className = 'em-coupon-msg err'; msg.textContent = 'No purchasable chapter to apply to.'; return; }
      foundation_id = nxt.id;
    }

    try {
      const r = await fetch('/api/coupons/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ code, type: applyType, course_id: data.course_id, foundation_id })
      });
      const d = await r.json();
      if (!r.ok) { msg.className = 'em-coupon-msg err'; msg.textContent = d.error || 'Invalid coupon'; modal._coupon = null; return; }
      modal._coupon = { code, discount_paise: d.discount_paise, final_paise: d.final_paise, apply_type: applyType };
      msg.className = 'em-coupon-msg ok';
      msg.textContent = `Coupon applied: −${fmtINR(d.discount_paise)}`;
    } catch (err) {
      msg.className = 'em-coupon-msg err';
      msg.textContent = 'Network error validating coupon';
    }
  }

  async function startPurchase(type, foundation_id) {
    const modal = document.getElementById('em-modal');
    const data = modal._data;
    const coupon = modal._coupon;
    const body = { type, course_id: data.course_id };
    if (type === 'individual') body.foundation_id = foundation_id;
    if (coupon && ((type === 'individual' && coupon.apply_type === 'individual') || (type !== 'individual' && coupon.apply_type === 'bundle'))) {
      body.coupon_code = coupon.code;
    }

    const buttons = modal.querySelectorAll('.em-btn');
    buttons.forEach(b => b.disabled = true);

    try {
      const r = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) {
        alert(d.error || 'Purchase failed');
        buttons.forEach(b => b.disabled = false);
        return;
      }

      if (d.auto_completed) {
        onPurchaseSuccess();
        return;
      }

      // Mock-mode fallback (dev, when RAZORPAY_KEY_ID is not set server-side)
      if (String(d.order_id || '').startsWith('order_mock_')) {
        const verify = await fetch('/api/purchases/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
          body: JSON.stringify({ razorpay_order_id: d.order_id })
        });
        if (verify.ok) onPurchaseSuccess();
        else alert('Mock verify failed');
        return;
      }

      if (typeof Razorpay === 'undefined') {
        alert('Razorpay Checkout did not load. Check your network / ad blocker.');
        buttons.forEach(b => b.disabled = false);
        return;
      }

      const rzp = new Razorpay({
        key: d.key_id,
        order_id: d.order_id,
        amount: d.amount_paise,
        currency: d.currency,
        name: 'The Foundation Room',
        description: data.title,
        handler: async function (response) {
          try {
            const verify = await fetch('/api/purchases/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              })
            });
            const vd = await verify.json();
            if (verify.ok) onPurchaseSuccess();
            else alert(vd.error || 'Payment verification failed');
          } catch (err) {
            alert('Verification error: ' + err.message);
          }
        },
        modal: { ondismiss: () => { buttons.forEach(b => b.disabled = false); } },
        theme: { color: '#d4af37' }
      });
      rzp.open();
    } catch (err) {
      alert('Network error: ' + err.message);
      buttons.forEach(b => b.disabled = false);
    }
  }

  function onPurchaseSuccess() {
    closeEnrollModal();
    setTimeout(() => window.location.reload(), 600);
  }

  // Expose on window so inline onclicks in the modal HTML can call them.
  window.openEnrollModal = openEnrollModal;
  window.closeEnrollModal = closeEnrollModal;
  window.emSwitchTab = emSwitchTab;
  window.applyCoupon = applyCoupon;
  window.startPurchase = startPurchase;
  // Back-compat alias
  window.handleEnroll = openEnrollModal;
})();
