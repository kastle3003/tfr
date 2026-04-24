(function () {
  'use strict';

  const ROLE_HOMES = {
    admin: '/admin-panel.html',
    instructor: '/instructor-dashboard.html',
    student: '/student-dashboard.html',
  };

  function roleHome(role) {
    return ROLE_HOMES[role] || '/student-dashboard.html';
  }

  function initialsFor(user) {
    if (!user) return '?';
    if (user.avatar_initials) return user.avatar_initials;
    const f = (user.first_name || '')[0] || '';
    const l = (user.last_name || '')[0] || '';
    const out = (f + l).toUpperCase();
    if (out) return out;
    return ((user.email || '?')[0] || '?').toUpperCase();
  }

  function getUser() {
    if (!localStorage.getItem('archive_token')) return null;
    try { return JSON.parse(localStorage.getItem('archive_user') || 'null'); }
    catch { return null; }
  }

  function signOut() {
    localStorage.removeItem('archive_token');
    localStorage.removeItem('archive_user');
    window.location.replace('/');
  }

  function injectStyles() {
    if (document.getElementById('public-nav-auth-style')) return;
    const s = document.createElement('style');
    s.id = 'public-nav-auth-style';
    s.textContent = `
      .pn-auth { position: relative; display: inline-flex; align-items: center; gap: 10px; text-decoration: none; }
      .pn-auth-pill {
        display: inline-flex; align-items: center; gap: 10px;
        padding: 5px 5px 5px 14px;
        border-radius: 999px;
        border: 1px solid rgba(200,168,75,0.35);
        background: rgba(200,168,75,0.05);
        color: #F0E6D3;
        font-family: inherit;
        cursor: pointer;
        transition: border-color .18s, background .18s, transform .15s;
      }
      .pn-auth-pill:hover { border-color: #C8A84B; background: rgba(200,168,75,0.10); transform: translateY(-1px); }
      .pn-auth-label {
        font-size: 12px; font-weight: 600; letter-spacing: 0.08em;
        color: #C8A84B; text-transform: uppercase;
      }
      .pn-auth-avatar {
        width: 30px; height: 30px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        background: #C8A84B; color: #080706;
        font-family: inherit; font-size: 12px; font-weight: 700;
        letter-spacing: .02em;
      }
      .pn-auth-caret { color: #B8A898; font-size: 10px; margin-left: 2px; }
      .pn-auth-menu {
        position: absolute; top: calc(100% + 8px); right: 0;
        min-width: 220px;
        background: #0F0D0B;
        border: 1px solid rgba(200,168,75,0.22);
        border-radius: 8px;
        padding: 8px;
        box-shadow: 0 18px 40px rgba(0,0,0,.45);
        opacity: 0; transform: translateY(-4px);
        pointer-events: none; transition: opacity .15s, transform .15s;
        z-index: 1000;
      }
      .pn-auth.open .pn-auth-menu { opacity: 1; transform: none; pointer-events: auto; }
      .pn-auth-menu-head {
        padding: 10px 12px 12px; border-bottom: 1px solid rgba(200,168,75,0.12); margin-bottom: 6px;
      }
      .pn-auth-menu-name { font-size: 13px; font-weight: 600; color: #F0E6D3; letter-spacing: .02em; }
      .pn-auth-menu-role { font-size: 10px; font-weight: 600; color: #C8A84B; letter-spacing: .18em; text-transform: uppercase; margin-top: 2px; }
      .pn-auth-menu a, .pn-auth-menu button {
        display: block; width: 100%;
        padding: 9px 12px; border-radius: 5px;
        font-family: inherit; font-size: 13px; font-weight: 500;
        color: #F0E6D3; text-align: left;
        background: transparent; border: 0; cursor: pointer;
        text-decoration: none;
        transition: background .12s, color .12s;
      }
      .pn-auth-menu a:hover, .pn-auth-menu button:hover { background: rgba(200,168,75,0.08); color: #E8C96E; }
      .pn-auth-menu .pn-divider { height: 1px; background: rgba(200,168,75,0.12); margin: 6px 4px; }
      @media (max-width: 560px) { .pn-auth-label, .pn-auth-caret { display: none; } .pn-auth-pill { padding: 5px; } }
    `;
    document.head.appendChild(s);
  }

  function findLoginLinksInNav() {
    const result = [];
    document.querySelectorAll('nav a').forEach(a => {
      const href = (a.getAttribute('href') || '').toLowerCase();
      if (/^\/(login|register|index\.html)(#|$|\?)/.test(href)) result.push(a);
    });
    return result;
  }

  function buildPill(user) {
    const home = roleHome(user.role);
    const display = user.first_name || 'Account';
    const inits = initialsFor(user);
    const role = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : 'Member';

    const wrap = document.createElement('div');
    wrap.className = 'pn-auth';
    wrap.innerHTML = `
      <button type="button" class="pn-auth-pill" aria-haspopup="menu" aria-expanded="false" title="Signed in as ${display}">
        <span class="pn-auth-label">${display}</span>
        <span class="pn-auth-avatar" aria-hidden="true">${inits}</span>
        <span class="pn-auth-caret">▾</span>
      </button>
      <div class="pn-auth-menu" role="menu">
        <div class="pn-auth-menu-head">
          <div class="pn-auth-menu-name">${[user.first_name, user.last_name].filter(Boolean).join(' ') || display}</div>
          <div class="pn-auth-menu-role">${role}</div>
        </div>
        <a href="${home}" role="menuitem">Go to Dashboard</a>
        ${user.role === 'student' ? `
          <a href="/student-courses.html" role="menuitem">My Courses</a>
          <a href="/student-course-catalog.html" role="menuitem">Browse Catalog</a>
          <a href="/student-profile.html" role="menuitem">Profile</a>
        ` : ''}
        <div class="pn-divider"></div>
        <button type="button" data-pn-signout role="menuitem">Sign out</button>
      </div>
    `;

    const btn = wrap.querySelector('.pn-auth-pill');
    const menu = wrap.querySelector('.pn-auth-menu');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = wrap.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    wrap.querySelector('[data-pn-signout]').addEventListener('click', signOut);
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) {
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        wrap.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    return wrap;
  }

  function renderSignedIn(user) {
    injectStyles();

    // Case 1: pages with a .nav-actions container (home.html, courses.html)
    document.querySelectorAll('nav .nav-actions').forEach(container => {
      container.innerHTML = '';
      container.appendChild(buildPill(user));
    });

    // Case 2: pages where the Sign In / Join Now buttons are direct nav children
    // (course-experience.html, course-landing.html). Replace the first login
    // link in-place and remove any other adjacent login/register links.
    const loginLinks = findLoginLinksInNav().filter(a => !a.closest('.nav-actions'));
    if (loginLinks.length) {
      const first = loginLinks[0];
      const parent = first.parentElement;
      const pill = buildPill(user);
      parent.replaceChild(pill, first);
      loginLinks.slice(1).forEach(a => a.remove());
    }
  }

  function isSignedIn() { return !!localStorage.getItem('archive_token'); }

  function courseDestination(course) {
    const user = getUser();
    if (user && user.role === 'student' && course && course.id) {
      return `/student-course-detail.html?id=${encodeURIComponent(course.id)}`;
    }
    const key = course && (course.slug || course.id);
    return key ? `/experience/${encodeURIComponent(key)}` : '/courses.html';
  }

  window.archiveAuth = {
    isSignedIn,
    getUser,
    roleHome,
    courseDestination,
    signOut,
  };

  function start() {
    const user = getUser();
    if (user) renderSignedIn(user);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
