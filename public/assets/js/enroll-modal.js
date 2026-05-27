// Shared Enroll/Buy modal — loaded by course-landing.html and student-course-detail.html.
// Depends on: a JWT in localStorage['archive_token'] and Razorpay Checkout JS being loaded.

(function () {
  const TOKEN_KEY = 'archive_token';
  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const fmtINR = (paise) => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const escapeHTML = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Standalone toast — works on pages with or without a global toast()
  function emToast(msg, type) {
    if (typeof window.toast === 'function') { window.toast(msg, type); return; }
    let tc = document.getElementById('em-toast-container');
    if (!tc) {
      tc = document.createElement('div');
      tc.id = 'em-toast-container';
      tc.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(tc);
    }
    const t = document.createElement('div');
    const colors = { error: '#e05252', warn: '#d4af37', success: '#5cb85c' };
    t.style.cssText = `background:${colors[type] || colors.success};color:#fff;padding:12px 18px;border-radius:6px;font-size:13px;font-family:inherit;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,.5);`;
    t.textContent = msg;
    tc.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // Check if student profile is complete enough to make a purchase
  async function checkProfileComplete() {
    const cached = JSON.parse(localStorage.getItem('archive_user') || '{}');
    const basicMissing = [];
    if (!cached.first_name) basicMissing.push('First Name');
    if (!cached.last_name) basicMissing.push('Last Name');
    if (basicMissing.length) return { ok: false, missing: basicMissing };

    try {
      const r = await fetch('/api/profile', { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!r.ok) return { ok: true }; // don't block if profile check fails
      const d = await r.json();
      const u = d.user || {};
      const missing = [];
      if (!u.phone) missing.push('Phone Number');
      if (!u.instrument) missing.push('Primary Instrument');
      return { ok: missing.length === 0, missing };
    } catch {
      return { ok: true };
    }
  }

  async function openEnrollModal(courseId) {
    if (!getToken()) {
      sessionStorage.setItem('tfr_enroll_after_login', courseId);
      window.location.href = '/signin.html#panel-register';
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
    document.getElementById('em-modal').innerHTML = `
      <div style="padding:40px 24px;text-align:center;">
        <div class="em-spinner"></div>
        <p style="margin-top:14px;color:#a09889;font-size:13px;">Loading pricing…</p>
      </div>`;

    try {
      const r = await fetch(`/api/pricing/course/${courseId}`, {
        headers: { Authorization: 'Bearer ' + getToken() }
      });
      if (r.status === 401) {
        sessionStorage.setItem('tfr_enroll_after_login', courseId);
        window.location.href = '/signin.html#panel-register';
        return;
      }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load pricing');
      renderEnrollModal(data);
    } catch (err) {
      document.getElementById('em-modal').innerHTML = `
        <button class="em-close" onclick="closeEnrollModal()">×</button>
        <div style="padding:24px;text-align:center;">
          <p style="color:#e78a8a;margin-bottom:16px;">Failed to load pricing: ${escapeHTML(err.message)}</p>
          <button class="em-btn em-btn-ghost" onclick="closeEnrollModal()">Close</button>
        </div>`;
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
        <div style="text-align:center;padding:8px 0 4px;">
          <div style="width:52px;height:52px;border-radius:50%;background:rgba(212,175,55,.12);border:1px solid rgba(212,175,55,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#d4af37" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h2 class="em-title">You own this course</h2>
          <p class="em-subtitle">Head to your dashboard to continue learning.</p>
        </div>
        <div class="em-primary-row">
          <button class="em-btn em-btn-ghost" onclick="closeEnrollModal()">Close</button>
          <button class="em-btn" onclick="window.location.href='/student-courses.html'">Go to My Courses →</button>
        </div>`;
      return;
    }

    const hasBundle = data.bundle_price_paise > 0;
    const hasChapters = data.chapters.some(c => c.price_paise > 0);

    modal.innerHTML = `
      <button class="em-close" onclick="closeEnrollModal()">×</button>
      <h2 class="em-title">${escapeHTML(data.title)}</h2>
      <p class="em-subtitle">Choose how you'd like to learn — full bundle or chapter by chapter.</p>
      <div class="em-tabs">
        ${hasChapters ? `<button class="em-tab${hasBundle ? '' : ' active'}" data-tab="chapters" onclick="emSwitchTab('chapters')">Chapter by Chapter</button>` : ''}
        ${hasBundle ? `<button class="em-tab${hasChapters ? '' : ' active'}" data-tab="bundle" onclick="emSwitchTab('bundle')">Full Bundle</button>` : ''}
      </div>
      <div class="em-pane${hasChapters ? ' active' : ''}" data-pane="chapters">${renderChaptersPane(data)}</div>
      <div class="em-pane${!hasChapters && hasBundle ? ' active' : ''}" data-pane="bundle">${renderBundlePane(data)}</div>
      <div class="em-coupon">
        <div class="em-coupon-row">
          <input id="em-coupon-input" placeholder="Coupon code (optional)" maxlength="32" oninput="this.value = this.value.toUpperCase()">
          <button class="em-btn em-btn-ghost" onclick="applyCoupon()">Apply</button>
        </div>
        <div id="em-coupon-msg" class="em-coupon-msg"></div>
      </div>
      <div class="em-security">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Secured by Razorpay &nbsp;·&nbsp; 256-bit SSL encryption &nbsp;·&nbsp; Cancel anytime
      </div>`;

    // Default active tab: chapters if available, else bundle
    if (hasChapters) {
      modal._activeTab = 'chapters';
    } else if (hasBundle) {
      modal._activeTab = 'bundle';
      modal.querySelectorAll('.em-pane').forEach(p => p.classList.remove('active'));
      modal.querySelector('[data-pane="bundle"]').classList.add('active');
    }
  }

  function renderBundlePane(data) {
    if (data.bundle_price_paise <= 0) return '<p style="color:#a09889;padding:16px 0;">Bundle pricing not configured.</p>';
    const header = `
      <div class="em-row em-row-featured">
        <div class="em-row-main">
          <span class="em-row-title">Complete Bundle</span>
          <span class="em-row-note">All ${data.chapters.length} chapters · lifetime access · sequential unlock</span>
        </div>
        <span class="em-row-price">${fmtINR(data.bundle_price_paise)}</span>
      </div>`;

    let upgradeHTML = '';
    if (data.upgrade_available) {
      upgradeHTML = `
        <div class="em-upgrade">
          <div class="em-upgrade-title">Upgrade to Full Bundle</div>
          <p class="em-upgrade-note">You've already paid for ${data.paid_chapters_count} chapter${data.paid_chapters_count === 1 ? '' : 's'}. Pay only the remaining difference.</p>
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
        <button class="em-btn" id="em-buy-bundle" onclick="startPurchase('bundle')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:6px;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Pay ${fmtINR(data.bundle_price_paise)}
        </button>
      </div>${upgradeHTML}`;
  }

  function renderChaptersPane(data) {
    const rows = data.chapters.map((c, idx) => {
      const letter = String.fromCharCode(65 + idx);
      if (c.owned) {
        return `<div class="em-row owned">
          <div class="em-row-main">
            <span class="em-row-title">${letter}. ${escapeHTML(c.title)}</span>
            <span class="em-row-note em-owned-label">✓ Owned</span>
          </div>
          <span class="em-row-price">—</span>
        </div>`;
      }
      return `<div class="em-row">
          <div class="em-row-main">
            <span class="em-row-title">${letter}. ${escapeHTML(c.title)}</span>
            <span class="em-row-note">${c.price_paise > 0 ? 'Available to purchase' : 'Included'}</span>
          </div>
          <span class="em-row-price">${c.price_paise > 0 ? fmtINR(c.price_paise) : '—'}</span>
          ${c.price_paise > 0 ? `<button class="em-btn" style="padding:6px 14px;font-size:11px;" onclick="startPurchase('individual', ${c.id})">Buy</button>` : ''}
        </div>`;
    });
    return rows.join('') +
      `<p style="font-size:11px;color:#a09889;margin-top:12px;padding-top:10px;border-top:1px solid rgba(212,175,55,.1);">Chapters sum: ${fmtINR(data.chapters_sum_paise)}${data.bundle_price_paise > 0 ? ` · Bundle: ${fmtINR(data.bundle_price_paise)} (save ${Math.round((1 - data.bundle_price_paise/data.chapters_sum_paise)*100)}%)` : ''}</p>`;
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
      msg.textContent = `Coupon applied! You save ${fmtINR(d.discount_paise)}`;
      if (applyType === 'bundle') {
        const totalEl = document.getElementById('em-total-bundle');
        if (totalEl) totalEl.textContent = fmtINR(d.final_paise);
        const buyBtn = document.getElementById('em-buy-bundle');
        if (buyBtn) buyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:6px;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Pay ${fmtINR(d.final_paise)}`;
      }
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
    buttons.forEach(b => { b.disabled = true; });

    // Show loading state on the clicked button
    const activeBtn = modal.querySelector('.em-btn:not(.em-btn-ghost)');
    const origText = activeBtn ? activeBtn.innerHTML : '';
    if (activeBtn) activeBtn.innerHTML = '<span class="em-btn-spinner"></span> Processing…';

    const restoreButtons = () => {
      buttons.forEach(b => { b.disabled = false; });
      if (activeBtn) activeBtn.innerHTML = origText;
    };

    try {
      const r = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) {
        emToast(d.error || 'Purchase failed', 'error');
        restoreButtons();
        return;
      }

      if (d.auto_completed) {
        onPurchaseSuccess();
        return;
      }

      // Mock-mode fallback (when RAZORPAY_KEY_ID is not configured)
      if (String(d.order_id || '').startsWith('order_mock_')) {
        const verify = await fetch('/api/purchases/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
          body: JSON.stringify({ razorpay_order_id: d.order_id })
        });
        if (verify.ok) onPurchaseSuccess();
        else { emToast('Payment verification failed', 'error'); restoreButtons(); }
        return;
      }

      if (typeof Razorpay === 'undefined') {
        emToast('Payment gateway did not load. Check your network connection.', 'error');
        restoreButtons();
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
            else { emToast(vd.error || 'Payment verification failed', 'error'); restoreButtons(); }
          } catch (err) {
            emToast('Verification error: ' + err.message, 'error');
            restoreButtons();
          }
        },
        modal: { ondismiss: restoreButtons },
        theme: { color: '#d4af37' }
      });
      rzp.open();
    } catch (err) {
      emToast('Network error: ' + err.message, 'error');
      restoreButtons();
    }
  }

  function onPurchaseSuccess() {
    closeEnrollModal();
    emToast('Payment successful! Enrolling you now…', 'success');

    // After payment, check if profile is incomplete and nudge — non-blocking
    checkProfileComplete().then(profileCheck => {
      if (!profileCheck.ok) {
        const fields = (profileCheck.missing || []).join(' & ');
        setTimeout(() => {
          showProfileNudge(fields);
        }, 1800);
      }
    }).catch(() => {});

    setTimeout(() => window.location.reload(), 1200);
  }

  function showProfileNudge(fields) {
    const nudge = document.createElement('div');
    nudge.style.cssText = `
      position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
      z-index:99999;background:#1C1508;border:1px solid rgba(200,168,75,0.4);
      border-left:4px solid #C8A84B;border-radius:8px;
      padding:16px 20px;display:flex;align-items:center;gap:16px;
      box-shadow:0 8px 32px rgba(0,0,0,0.7);max-width:460px;width:90%;
    `;
    nudge.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#C8A84B" stroke-width="2" stroke-linecap="round" flex-shrink="0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#F0E6D3;margin-bottom:3px;">Complete your profile</div>
        <div style="font-size:12px;color:#B8A898;line-height:1.4;">Add your ${fields} to personalise your learning experience.</div>
      </div>
      <a href="/student-profile.html" style="flex-shrink:0;padding:8px 14px;background:rgba(200,168,75,0.15);border:1px solid rgba(200,168,75,0.4);border-radius:4px;color:#C8A84B;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;white-space:nowrap;">Update</a>
      <button onclick="this.parentNode.remove()" style="flex-shrink:0;background:none;border:none;color:#6B5E50;font-size:18px;cursor:pointer;padding:0 0 0 4px;line-height:1;">×</button>
    `;
    document.body.appendChild(nudge);
    setTimeout(() => nudge.remove(), 12000);
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
