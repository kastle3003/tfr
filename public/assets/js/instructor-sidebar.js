(function () {
  'use strict';

  const I = {
    dashboard:     '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    courses:       '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    gradebook:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>',
    live:          '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    announce:      '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    notifications: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    analytics:     '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/>',
    export:        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    profile:       '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  };

  const ITEMS = [
    { href: '/instructor-dashboard.html',      label: 'Dashboard',          icon: I.dashboard },
    { section: 'Teaching' },
    { href: '/course-manager.html',            label: 'Course Manager',     icon: I.courses },
    { href: '/admin-live-batches.html',        label: 'Live Batches',       icon: I.live },
    { href: '/gradebook.html',                 label: 'Gradebook',          icon: I.gradebook },
    { section: 'Engagement' },
    { href: '/admin-panel.html#announcements', label: 'Announcements',      icon: I.announce },
    { href: '/admin-notifications.html',       label: 'Notifications',      icon: I.notifications },
    { section: 'Insights' },
    { href: '/analytics-instructor.html',      label: 'Analytics',          icon: I.analytics },
    { href: '/reports.html',                   label: 'Reports & Exports',  icon: I.export },
    { section: 'Account' },
    { href: '/student-profile.html',           label: 'Profile',            icon: I.profile },
  ];

  const SVG_TPL = (inner) =>
    `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  function ensureStyles() {
    if (document.getElementById('role-sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'role-sidebar-styles';
    style.textContent = `
      .sidebar-brand {
        background: rgba(200, 168, 75, 0.07);
        border-bottom: 1px solid rgba(200,168,75,0.13) !important;
      }
      .sidebar-nav .nav-section {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1.4px;
        text-transform: uppercase;
        color: rgba(255,255,255,0.32);
        padding: 18px 24px 6px;
        pointer-events: none;
      }
      .sidebar-nav .nav-section:first-child { padding-top: 6px; }
      .sidebar-nav .nav-locked {
        opacity: 0.4;
        cursor: not-allowed;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        color: rgba(255,255,255,0.5);
        text-decoration: none;
      }
      .sidebar-nav .nav-soon {
        margin-left: auto;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: rgba(200,168,75,0.8);
        background: rgba(200,168,75,0.1);
        border: 1px solid rgba(200,168,75,0.25);
        border-radius: 4px;
        padding: 1px 5px;
      }
    `;
    document.head.appendChild(style);
  }

  function getCachedUser() {
    try { return JSON.parse(localStorage.getItem('archive_user') || 'null') || {}; }
    catch { return {}; }
  }

  function initialsFor(user) {
    if (user.avatar_initials) return user.avatar_initials;
    const f = (user.first_name || '')[0] || '';
    const l = (user.last_name  || '')[0] || '';
    return (f + l).toUpperCase() || '—';
  }

  function render() {
    const path = window.location.pathname;
    const user = getCachedUser();
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Instructor';
    const initials = initialsFor(user);

    const nav = ITEMS.map(it => {
      if (it.section) return `<div class="nav-section">${it.section}</div>`;
      if (it.locked) return `<span class="nav-item nav-locked">${SVG_TPL(it.icon)}${it.label}<span class="nav-soon">Soon</span></span>`;
      // Match both exact path and path#hash links
      const itemPath = it.href.split('#')[0];
      const active = path === itemPath ? ' active' : '';
      return `<a href="${it.href}" class="nav-item${active}">${SVG_TPL(it.icon)}${it.label}</a>`;
    }).join('');

    return `
      <div class="sidebar-brand">
        <img src="/assets/tfr-play/tfr-logo-main.png" alt="TFR" style="height:36px;width:auto;display:block;margin-bottom:8px;">
        <div class="brand-title">The Foundation Room</div>
        <div class="brand-sub">Instructor Portal</div>
      </div>
      <nav class="sidebar-nav">${nav}</nav>
      <div class="sidebar-footer">
        <div class="sidebar-user" onclick="(window.logout||function(){localStorage.clear();location.href='/signin.html';})()">
          <div class="sidebar-avatar" id="sb-avatar">${initials}</div>
          <div class="sidebar-user-info">
            <div class="user-name" id="sb-name">${name}</div>
            <div class="user-role">Instructor</div>
          </div>
        </div>
      </div>
    `;
  }

  function setupMobileToggle() {
    if (document.getElementById('_sidebar-toggle')) return;
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    const btn = document.createElement('button');
    btn.id = '_sidebar-toggle';
    btn.className = 'sidebar-toggle-btn';
    btn.setAttribute('aria-label', 'Toggle menu');
    btn.innerHTML = `<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
    topbar.insertBefore(btn, topbar.firstChild);
    if (!document.getElementById('_sidebar-overlay')) {
      const overlay = document.createElement('div');
      overlay.id = '_sidebar-overlay';
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', () => {
        document.querySelector('.sidebar') && document.querySelector('.sidebar').classList.remove('open');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
      });
    }
    btn.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      const overlay = document.getElementById('_sidebar-overlay');
      const isOpen = sidebar && sidebar.classList.contains('open');
      if (isOpen) {
        sidebar.classList.remove('open');
        overlay && overlay.classList.remove('active');
        document.body.style.overflow = '';
      } else {
        sidebar && sidebar.classList.add('open');
        overlay && overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
      }
    });
  }

  function mount() {
    const el = document.getElementById('sidebar') || document.querySelector('aside.sidebar');
    if (!el) return;
    ensureStyles();
    el.innerHTML = render();
    setupMobileToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  document.addEventListener('userLoaded', mount);
})();
