const { isValidRole } = require('../lib/roles');

module.exports = (allowed) => {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  for (const r of list) {
    if (!isValidRole(r)) throw new Error(`role middleware configured with invalid role: ${r}`);
  }
  return (req, res, next) => {
    if (!req.user || !list.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
};
