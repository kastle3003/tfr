// Homepage CMS loader - substitutes [data-cms-key] elements from /api/homepage-cms.
// Silent failure -> hardcoded HTML remains visible. Re-hydrates twice to catch
// late-inserted DOM (footer/nav from site-chrome.js).
(function () {
  'use strict';
  let CACHE = null;

  function apply(el, value) {
    if (value == null) return;
    const tag = el.tagName;
    const target = el.dataset.cmsAttr;
    if (target) { el.setAttribute(target, value); return; }
    if (tag === 'IMG' || tag === 'SOURCE') { el.setAttribute(tag === 'IMG' ? 'src' : 'srcset', value); return; }
    if (tag === 'A') {
      if (el.dataset.cmsHref === 'true' || el.classList.contains('cms-href')) {
        el.setAttribute('href', value);
      } else {
        el.innerHTML = value;
      }
      return;
    }
    el.innerHTML = value;
  }

  function hydrate(data) {
    document.querySelectorAll('[data-cms-key]').forEach(el => {
      const key = el.dataset.cmsKey;
      if (key && Object.prototype.hasOwnProperty.call(data, key)) apply(el, data[key]);
    });
    document.querySelectorAll('[data-cms-href-key]').forEach(el => {
      const key = el.dataset.cmsHrefKey;
      if (key && data[key] != null) el.setAttribute('href', data[key]);
    });
    document.querySelectorAll('[data-cms-bg-key]').forEach(el => {
      const key = el.dataset.cmsBgKey;
      if (key && data[key]) el.style.backgroundImage = "url('" + data[key] + "')";
    });
  }

  function load() {
    fetch('/api/homepage-cms', { credentials: 'omit' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || typeof data !== 'object') return;
        CACHE = data;
        hydrate(data);
        setTimeout(() => hydrate(data), 300);
        setTimeout(() => hydrate(data), 1200);
      })
      .catch(() => {});
  }

  window.cmsRehydrate = function () { if (CACHE) hydrate(CACHE); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
