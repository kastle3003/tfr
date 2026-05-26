// Shared helpers for live-classes public pages.
// fetch wrappers (no auth needed for public endpoints), Razorpay loader, INR fmt.
(function () {
  'use strict';

  const lcApi = {
    get(path) {
      return fetch(path, { credentials: 'omit' }).then(handle);
    },
    post(path, body) {
      const headers = { 'Content-Type': 'application/json' };
      // If a logged-in TFR user is on the page, pass their token (allows admin to test
      // without making a guest checkout). Public endpoints don't require it.
      const tok = localStorage.getItem('archive_token');
      if (tok) headers.Authorization = `Bearer ${tok}`;
      return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) }).then(handle);
    }
  };
  async function handle(res) {
    let data; try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function fmtINR(paise) {
    return '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', weekday: 'short'
      });
    } catch { return iso; }
  }
  function fmtTime(t) { return t || ''; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function loadRazorpay() {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve();
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Razorpay'));
      document.head.appendChild(s);
    });
  }

  // openCheckout({ order, name, email, phone, onSuccess(payload), onDismiss?() })
  async function openCheckout(opts) {
    await loadRazorpay();
    const rzp = new Razorpay({
      key: opts.order.key_id,
      amount: opts.order.amount,
      currency: opts.order.currency || 'INR',
      name: 'The Foundation Room',
      description: opts.description || 'Live class booking',
      order_id: opts.order.order_id,
      prefill: { name: opts.name || '', email: opts.email || '', contact: opts.phone || '' },
      theme: { color: '#C8A84B' },
      handler: (response) => opts.onSuccess && opts.onSuccess(response),
      modal: {
        ondismiss: () => opts.onDismiss && opts.onDismiss()
      }
    });
    rzp.open();
  }

  window.lcApi = lcApi;
  window.lcFmt = { fmtINR, fmtDate, fmtTime, esc };
  window.lcCheckout = { openCheckout };
})();
