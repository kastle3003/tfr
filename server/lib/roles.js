const ROLES = Object.freeze({
  STUDENT: 'student',
  INSTRUCTOR: 'instructor',
  ADMIN: 'admin',
});

const VALID_ROLES = Object.freeze(Object.values(ROLES));

function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

const DISPLAY_LABELS = Object.freeze({
  student: 'User',
  instructor: 'Instructor',
  admin: 'Admin',
});

function displayLabel(role) {
  return DISPLAY_LABELS[role] || role;
}

module.exports = { ROLES, VALID_ROLES, isValidRole, displayLabel };
