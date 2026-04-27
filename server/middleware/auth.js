const jwt = require('jsonwebtoken');
const db  = require('../db');

module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const row = db.prepare('SELECT is_blocked FROM users WHERE id = ?').get(decoded.id);
    if (row && row.is_blocked) {
      return res.status(403).json({ error: 'Your account has been suspended.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
