(function () {
  'use strict';

  const I = {
    dashboard:     '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    courses:       '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    gradebook:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>',
    quiz:          '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    live:          '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    studio:        '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    announce:      '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    messages:      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    email:         '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    notifications: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    analytics:     '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/>',
    calendar:      '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    resources:     '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    archive:       '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
    catalog:       '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    profile:       '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  };

  const ITEMS = [
    { href: '/instructor-dashboard.html', label: 'Dashboard',       icon: I.dashboard },
    { section: 'Teaching' },
    { href: '/course-manager.html',       label: 'Course Manager',  icon: I.courses },
    { href: '/gradebook.html',            label: 'Gradebook',       icon: I.gradebook },
    { href: '/quiz-builder.html',         label: 'Quiz Builder',    icon: I.quiz },
    { href: '/student-live-classes.html',         label: 'Live Classes',    icon: I.live },
    { href: '/studio.html',               label: 'Studio',          icon: I.studio },
    { section: 'Content' },
    { href: '/student-sheet-music.html',          label: 'Sheet Music',     icon: I.studio },
    { href: '/student-resources.html',     label: 'Resources',       icon: I.resources },
    { href: '/student-archive.html',       label: 'The Archive',     icon: I.archive },
    { href: '/student-course-catalog.html',       label: 'Browse Catalog',  icon: I.catalog },
    { section: 'Engagement' },
    { href: '/student-announcements.html',        label: 'Announcements',   icon: I.announce },
    { href: '/student-messaging.html',            label: 'Messages',        icon: I.messages },
    { href: '/email-automation.html',     label: 'Email Automation',icon: I.email },
    { href: '/student-notifications.html',        label: 'Notifications',   icon: I.notifications },
    { section: 'Insights' },
    { href: '/analytics-instructor.html', label: 'Analytics',       icon: I.analytics },
    { href: '/student-calendar.html',             label: 'Calendar',         icon: I.calendar },
    { section: 'Account' },
    { href: '/student-profile.html',      label: 'Profile',         icon: I.profile },
  ];

  const SVG_TPL = (inner) =>
    `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  function ensureStyles() {
    if (document.getElementById('role-sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'role-sidebar-styles';
    style.textContent = `
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
      const active = path === it.href ? ' active' : '';
      return `<a href="${it.href}" class="nav-item${active}">${SVG_TPL(it.icon)}${it.label}</a>`;
    }).join('');

    return `
      <div class="sidebar-brand">
        <div class="brand-monogram">TFR</div>
        <div class="brand-title">The Foundation Room</div>
        <div class="brand-sub">Instructor Portal</div>
      </div>
      <nav class="sidebar-nav">${nav}</nav>
      <div class="sidebar-footer">
        <div class="sidebar-user" onclick="(window.logout||function(){localStorage.clear();location.href='/index.html';})()">
          <div class="sidebar-avatar" id="sb-avatar">${initials}</div>
          <div class="sidebar-user-info">
            <div class="user-name" id="sb-name">${name}</div>
            <div class="user-role">Instructor</div>
          </div>
        </div>
      </div>
    `;
  }

  function mount() {
    const el = document.getElementById('sidebar') || document.querySelector('aside.sidebar');
    if (!el) return;
    ensureStyles();
    el.innerHTML = render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  document.addEventListener('userLoaded', mount);
})();
