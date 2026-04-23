/**
 * Role-dispatching sidebar loader.
 *
 * Include this on SHARED pages (catalog, calendar, messaging, notifications, etc.)
 * — pages that more than one role can access. It reads the cached user's role and
 * loads the matching per-role sidebar script:
 *   student    → /assets/js/student-sidebar.js
 *   instructor → /assets/js/instructor-sidebar.js
 *   admin      → /assets/js/admin-sidebar.js
 *
 * Pages for a single role (student-dashboard, instructor-dashboard, admin-panel,
 * my-courses, gradebook, etc.) should keep including the role-specific script
 * directly — saves a tiny extra lookup and makes role ownership obvious.
 *
 * Requires: /assets/js/auth-guard.js (populates localStorage.archive_user).
 */
(function () {
  'use strict';

  const SCRIPTS = {
    student:    '/assets/js/student-sidebar.js',
    instructor: '/assets/js/instructor-sidebar.js',
    admin:      '/assets/js/admin-sidebar.js',
  };

  let loaded = null;

  function loadFor(role) {
    const src = SCRIPTS[role] || SCRIPTS.student;
    if (loaded === src) return;
    loaded = src;
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    document.head.appendChild(s);
  }

  function getCachedRole() {
    try {
      const u = JSON.parse(localStorage.getItem('archive_user') || 'null');
      return u && u.role;
    } catch { return null; }
  }

  const role = getCachedRole();
  if (role) {
    loadFor(role);
  }

  // If role wasn't cached yet (first load), wait for auth-guard's userLoaded event.
  document.addEventListener('userLoaded', function (e) {
    if (!loaded) loadFor(e.detail && e.detail.role);
  });
})();
