/* Shared site chrome — injects the canonical top nav and footer
   into any page that contains <div data-site-nav></div> and/or
   <div data-site-footer></div>. After injection, public-nav-auth.js
   can rewrite Sign In into the avatar pill as before. */
(function () {
  'use strict';

  const LOGO = '/assets/tfr-play/tfr-logo-main.png';

  const NAV_HTML = `
    <nav class="site-nav" id="main-nav" aria-label="Primary">
      <a href="/" class="nav-logo" aria-label="The Foundation Room — home">
        <img class="nav-logo-img" src="${LOGO}" alt="The Foundation Room">
      </a>
      <ul class="nav-links">
        <li><a href="/#experience" data-nav-key="experience">Experience</a></li>
        <li><a href="/#courses" data-nav-key="courses">Courses</a></li>
        <li><a href="/#connect" data-nav-key="connect">Connect</a></li>
      </ul>
      <div class="nav-actions">
        <a href="/login" class="btn-ghost">Log In</a>
        <a href="/login#panel-register" class="btn-gold">Sign Up</a>
      </div>
    </nav>
  `;

  const FOOTER_HTML = `
    <footer class="site-footer" id="connect">
      <div class="footer-grid">
        <div>
          <a href="/" class="footer-brand-logo" aria-label="The Foundation Room — home">
            <img src="${LOGO}" alt="The Foundation Room">
          </a>
          <p class="footer-tagline">Training is a Science.<br>Performing is an Art.</p>
          <div class="footer-socials">
            <a href="https://instagram.com/thisistfr" class="footer-social" target="_blank" rel="noopener" aria-label="Instagram">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
            </a>
            <a href="https://facebook.com/thefoundationroom" class="footer-social" target="_blank" rel="noopener" aria-label="Facebook">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            </a>
          </div>
        </div>

        <div>
          <p class="footer-col-title">Courses</p>
          <ul class="footer-links">
            <li><span class="footer-link-inactive">Sitara — Niladri Kumar's Signature Sitar Program</span></li>
            <li><a href="/experience/djembe-world-percussions">Djembe &amp; Indian Percussions — Taufiq Qureshi</a></li>
            <li><span class="footer-link-inactive">Vocals — Saylee Talwalkar</span></li>
            <li><span class="footer-link-inactive">Kathak — Guruma Sangeeta Sinha</span></li>
            <li><span class="footer-link-inactive">All Courses</span></li>
          </ul>
        </div>

        <div>
          <p class="footer-col-title">Platform</p>
          <ul class="footer-links">
            <li><a href="/">Home</a></li>
            <li><span class="footer-link-inactive">TFR Play</span></li>
            <li><span class="footer-link-inactive">TFR Kids</span></li>
          </ul>
        </div>

        <div>
          <p class="footer-col-title">Connect</p>
          <p class="footer-connect-tagline">Ready to begin? We'd love to hear from you.</p>
          <a href="mailto:join@thefoundationroom.in" class="footer-connect-cta">Start a Conversation &rarr;</a>
          <div class="footer-connect-item">
            <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.79 19.79 0 01.07 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92v2z"/></svg>
            <span><a href="tel:+919920615500">+91 99206 15500</a></span>
          </div>
          <div class="footer-connect-item">
            <svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            <span><a href="mailto:join@thefoundationroom.in">join@thefoundationroom.in</a></span>
          </div>
          <div class="footer-connect-item">
            <svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span>504, 505, Bal Gandharva Rang Mandir Auditorium,<br>Linking Road, Bandra West, Mumbai 400050</span>
          </div>
          <div class="footer-connect-item">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8.56 2.75c4.37 6.03 6.02 9.42 8.03 17.72m2.54-15.38c-3.72 4.35-8.94 5.66-16.88 5.85m19.5 1.9c-3.5-.93-6.63-.82-8.94 0-2.58.92-5.01 2.86-7.44 6.32"/></svg>
            <span><a href="https://instagram.com/thisistfr" target="_blank" rel="noopener">@thisistfr on Instagram</a></span>
          </div>
        </div>
      </div>
      <div class="footer-bar">
        <p class="footer-copy">&copy; 2026 THE FOUNDATION ROOM. ALL RIGHTS RESERVED. &nbsp;&middot;&nbsp; Designed &amp; Developed by Techinfinity</p>
        <div class="footer-legal">
          <span class="footer-link-inactive">Privacy Policy</span>
          <span class="footer-link-inactive">Refund Policy</span>
          <span class="footer-link-inactive">Terms</span>
        </div>
      </div>
    </footer>
  `;

  function markActiveLink(navEl) {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    const file = path.split('/').pop();
    const activeKey = navEl.getAttribute('data-active');
    const links = navEl.querySelectorAll('.nav-links a');
    links.forEach(a => {
      const key = a.getAttribute('data-nav-key');
      if (activeKey && key === activeKey) {
        a.classList.add('active');
        return;
      }
      if (key === 'courses' && /^courses(\.html)?$/.test(file)) a.classList.add('active');
    });
  }

  function ensureFavicon() {
    const existing = document.querySelector('link[rel="icon"]');
    if (existing) {
      existing.setAttribute('type', 'image/png');
      existing.setAttribute('href', '/assets/tfr-play/favicon-tfr.png');
      return;
    }
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = '/assets/tfr-play/favicon-tfr.png';
    document.head.appendChild(link);
  }

  function injectChrome() {
    ensureFavicon();
    document.querySelectorAll('[data-site-nav]').forEach(navMount => {
      const active = navMount.getAttribute('data-active');
      const tmp = document.createElement('div');
      tmp.innerHTML = NAV_HTML.trim();
      const navEl = tmp.firstElementChild;
      if (active) navEl.setAttribute('data-active', active);
      markActiveLink(navEl);
      navMount.replaceWith(navEl);
    });

    document.querySelectorAll('[data-site-footer]').forEach(footerMount => {
      const tmp = document.createElement('div');
      tmp.innerHTML = FOOTER_HTML.trim();
      footerMount.replaceWith(tmp.firstElementChild);
    });

    const nav = document.getElementById('main-nav');
    if (nav && nav.classList.contains('site-nav') && !nav.dataset.scrollBound) {
      nav.dataset.scrollBound = '1';
      // Smooth-scroll for same-page anchor links (e.g. Connect → #cta-banner from home)
      nav.querySelectorAll('a[href*="#"]').forEach(a => {
        a.addEventListener('click', (e) => {
          const url = new URL(a.href, window.location.href);
          const samePage = url.pathname === window.location.pathname || url.pathname === '/' + (window.location.pathname.split('/').pop() || '');
          if (samePage && url.hash) {
            const target = document.querySelector(url.hash);
            if (target) {
              e.preventDefault();
              target.scrollIntoView({ behavior: 'smooth' });
              history.replaceState(null, '', url.hash);
            }
          }
        });
      });
      const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 30);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();

      nav.addEventListener('mouseenter', () => nav.classList.add('nav-lit'));
      nav.addEventListener('mouseleave', () => nav.classList.remove('nav-lit'));
      nav.addEventListener('mousemove', e => {
        const rect = nav.getBoundingClientRect();
        nav.style.setProperty('--nav-glow-x', ((e.clientX - rect.left) / rect.width * 100).toFixed(1) + '%');
      });
    }
  }

  // Public hook so dynamically rendered pages can mount the chrome too.
  window.SiteChrome = { mount: injectChrome };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectChrome);
  } else {
    injectChrome();
  }
})();
