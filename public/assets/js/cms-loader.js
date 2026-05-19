// Homepage CMS loader — substitutes [data-cms-key] elements with values from
// /api/homepage-cms. Silent failure → original hardcoded HTML remains visible.
// Load at bottom of <body> after content has rendered.

(function () {
  'use strict';

  // Apply a value to an element based on its semantics.
  function apply(el, value) {
    if (value == null) return;
    const tag = el.tagName;
    const target = el.dataset.cmsAttr; // optional explicit attribute target

    if (target) {
      el.setAttribute(target, value);
      return;
    }
    if (tag === 'IMG' || tag === 'SOURCE') {
      el.setAttribute(el.tagName === 'IMG' ? 'src' : 'srcset', value);
      return;
    }
    if (tag === 'A') {
      // For <a>, if data-cms-href is set we update href; otherwise update text
      if (el.dataset.cmsHref === 'true' || el.classList.contains('cms-href')) {
        el.setAttribute('href', value);
      } else {
        el.innerHTML = value;
      }
      return;
    }
    // Default: replace inner HTML (allows <br>, <em>, etc.)
    el.innerHTML = value;
  }

  function hydrate(data) {
    const nodes = document.querySelectorAll('[data-cms-key]');
    nodes.forEach(el => {
      const key = el.dataset.cmsKey;
      if (key && Object.prototype.hasOwnProperty.call(data, key)) {
        apply(el, data[key]);
      }
    });
    // Special handling: a[data-cms-href-key="some.key"] sets href from that key
    document.querySelectorAll('[data-cms-href-key]').forEach(el => {
      const key = el.dataset.cmsHrefKey;
      if (key && data[key] != null) el.setAttribute('href', data[key]);
    });
    // Special handling: [data-cms-bg-key="some.key"] sets background-image
    document.querySelectorAll('[data-cms-bg-key]').forEach(el => {
      const key = el.dataset.cmsBgKey;
      if (key && data[key]) el.style.backgroundImage = `url('${data[key]}')`;
    });
  }

  function load() {
    fetch('/api/homepage-cms', { credentials: 'omit' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data && typeof data === 'object') hydrate(data); })
      .catch(() => { /* silent — keep hardcoded fallback */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
