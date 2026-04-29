(function () {
  'use strict';

  const I = {
    dashboard: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    courses: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    lessons: '<polygon points="5 3 19 12 5 21 5 3"/>',
    assignments: '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><polyline points="9 14 11 16 15 12"/>',
    certificates: '<circle cx="12" cy="8" r="6"/><polyline points="8.21 13.89 7 22 12 19 17 22 15.79 13.88"/>',
    catalog: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    practice: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    analytics: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    sheet: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    resources: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
    messages: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    discussions: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    notifications: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    announcements: '<path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    studio: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
    profile: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  };

  const ITEMS = [
    { href: '/student-dashboard.html', label: 'Dashboard', icon: I.dashboard },
    { section: 'Learning' },
    { href: '/student-courses.html', label: 'My Courses', icon: I.courses },
    { section: 'Library' },
    { href: '/student-resources.html',   label: 'Resources',   icon: I.resources },
    { href: '/student-archive.html',     label: 'The Archive', icon: I.archive },
    { section: 'Account' },
    { href: '/student-profile.html', label: 'Profile', icon: I.profile },
  ];

  const SVG_TPL = (inner) =>
    `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  function ensureStyles() {
    if (document.getElementById('student-sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'student-sidebar-styles';
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
    const l = (user.last_name || '')[0] || '';
    return (f + l).toUpperCase() || '—';
  }

  function render() {
    const path = window.location.pathname;
    const user = getCachedUser();
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Student';
    const initials = initialsFor(user);

    const nav = ITEMS.map(it => {
      if (it.section) return `<div class="nav-section">${it.section}</div>`;
      if (it.locked) return `<span class="nav-item nav-locked">${SVG_TPL(it.icon)}${it.label}<span class="nav-soon">Soon</span></span>`;
      const active = path === it.href ? ' active' : '';
      return `<a href="${it.href}" class="nav-item${active}">${SVG_TPL(it.icon)}${it.label}</a>`;
    }).join('');

    return `
      <div class="sidebar-brand">
        <img src="/assets/tfr-play/tfr-logo-main.png" alt="TFR" style="height:36px;width:auto;display:block;margin-bottom:8px;">
        <div class="brand-title">The Foundation Room</div>
        <div class="brand-sub">Student Portal</div>
      </div>
      <nav class="sidebar-nav">${nav}</nav>
      <div class="sidebar-footer">
        <div class="sidebar-user" onclick="(window.logout||function(){localStorage.clear();location.href='/signin.html';})()">
          <div class="sidebar-avatar" id="sb-avatar">${initials}</div>
          <div class="sidebar-user-info">
            <div class="user-name" id="sb-name">${name}</div>
            <div class="user-role">Log Out</div>
          </div>
        </div>
      </div>
    `;
  }

  function setupTopbarAvatar() {
    const el = document.getElementById('topbar-avatar');
    if (!el) return;

    const user = getCachedUser();
    const initials = initialsFor(user);
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Student';

    el.textContent = initials;
    el.title = name;

    // If already converted to a dropdown, just update the header text
    const existingHead = document.getElementById('_td-head-name');
    if (existingHead) { existingHead.textContent = name; return; }

    el.removeAttribute('href');
    el.removeAttribute('onclick');
    el.style.cursor = 'pointer';

    const dropdown = document.createElement('div');
    dropdown.style.cssText = [
      'position:absolute', 'top:calc(100% + 8px)', 'right:0',
      'min-width:200px', 'background:#0F0D0B',
      'border:1px solid rgba(200,168,75,0.22)', 'border-radius:8px',
      'padding:8px', 'box-shadow:0 18px 40px rgba(0,0,0,.45)',
      'opacity:0', 'transform:translateY(-4px)',
      'pointer-events:none', 'transition:opacity .15s,transform .15s', 'z-index:1000'
    ].join(';');

    const linkStyle = 'display:block;padding:9px 12px;border-radius:5px;font-size:13px;font-weight:500;color:#F0E6D3;text-decoration:none;';
    const btnStyle  = linkStyle + 'width:100%;text-align:left;background:transparent;border:0;cursor:pointer;';

    dropdown.innerHTML = `
      <div style="padding:10px 12px 12px;border-bottom:1px solid rgba(200,168,75,0.12);margin-bottom:6px;">
        <div id="_td-head-name" style="font-size:13px;font-weight:600;color:#F0E6D3;">${name}</div>
        <div style="font-size:10px;font-weight:600;color:#C8A84B;letter-spacing:.18em;text-transform:uppercase;margin-top:2px;">Student</div>
      </div>
      <a href="/student-dashboard.html" style="${linkStyle}" class="_td-item">Dashboard</a>
      <a href="/student-profile.html"   style="${linkStyle}" class="_td-item">Profile</a>
      <div style="height:1px;background:rgba(200,168,75,0.12);margin:6px 4px;"></div>
      <button style="${btnStyle}" class="_td-item _td-logout">Log Out</button>
    `;

    dropdown.querySelectorAll('._td-item').forEach(item => {
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(200,168,75,0.08)'; item.style.color = '#E8C96E'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; item.style.color = '#F0E6D3'; });
    });
    dropdown.querySelector('._td-logout').addEventListener('click', () => {
      (window.logout || function() { localStorage.clear(); location.href = '/signin.html'; })();
    });

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;display:inline-flex;align-items:center;';
    el.parentNode.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    wrapper.appendChild(dropdown);

    let open = false;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      open = !open;
      dropdown.style.opacity = open ? '1' : '0';
      dropdown.style.transform = open ? 'none' : 'translateY(-4px)';
      dropdown.style.pointerEvents = open ? 'auto' : 'none';
    });
    document.addEventListener('click', () => {
      open = false;
      dropdown.style.opacity = '0';
      dropdown.style.transform = 'translateY(-4px)';
      dropdown.style.pointerEvents = 'none';
    });
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
      overlay.addEventListener('click', closeSidebar);
    }

    btn.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      sidebar && sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
  }

  function openSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('_sidebar-overlay');
    sidebar && sidebar.classList.add('open');
    overlay && overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('_sidebar-overlay');
    sidebar && sidebar.classList.remove('open');
    overlay && overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  function mount() {
    const el = document.getElementById('sidebar') || document.querySelector('aside.sidebar');
    if (!el) return;
    ensureStyles();
    el.innerHTML = render();
    setupTopbarAvatar();
    setupMobileToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  document.addEventListener('userLoaded', () => { mount(); setupTopbarAvatar(); });
})();
