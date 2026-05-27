const express = require('express');
const router = express.Router();
const db = require('../db');

// Helper: get practice goal for student
function getPracticeGoal(studentId) {
  try {
    const profile = db.prepare('SELECT practice_goal_minutes FROM user_profile WHERE user_id = ?').get(studentId);
    return profile ? (profile.practice_goal_minutes || 60) : 60;
  } catch {
    return 60;
  }
}

// Helper: compute streak
function computeStreak(studentId) {
  const rows = db.prepare(`
    SELECT DISTINCT date FROM practice_sessions
    WHERE student_id = ?
    ORDER BY date DESC
  `).all(studentId);

  if (!rows.length) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const dates = rows.map(r => {
    const d = new Date(r.date);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  });

  let current = 0;
  let check = today.getTime();
  if (!dates.includes(check)) {
    check = yesterday.getTime();
    if (!dates.includes(check)) return 0;
  }
  while (dates.includes(check)) {
    current++;
    check -= 86400000;
  }
  return current;
}

// GET /api/practice-log?month=YYYY-MM
router.get('/', (req, res) => {
  try {
    const studentId = req.user.id;
    const { month } = req.query;

    let query = `
      SELECT ps.*, c.title AS course_title
      FROM practice_sessions ps
      LEFT JOIN courses c ON ps.course_id = c.id
      WHERE ps.student_id = ?
    `;
    const params = [studentId];

    if (month) {
      query += ` AND strftime('%Y-%m', ps.date) = ?`;
      params.push(month);
    }

    query += ' ORDER BY ps.date DESC, ps.created_at DESC';

    const sessions = db.prepare(query).all(...params);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/practice-log/heatmap — last 365 days
router.get('/heatmap', (req, res) => {
  try {
    const studentId = req.user.id;

    const rows = db.prepare(`
      SELECT date, SUM(duration_minutes) AS total_minutes
      FROM practice_sessions
      WHERE student_id = ?
        AND date >= date('now', '-365 days')
      GROUP BY date
      ORDER BY date ASC
    `).all(studentId);

    const dates = {};
    rows.forEach(r => {
      dates[r.date] = r.total_minutes;
    });

    res.json({ dates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/practice-log/stats
router.get('/stats', (req, res) => {
  try {
    const studentId = req.user.id;

    // Week bounds (Mon-Sun)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + mondayOffset);
    thisMonday.setHours(0, 0, 0, 0);

    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(thisMonday.getDate() - 7);
    const lastSunday = new Date(thisMonday);
    lastSunday.setDate(thisMonday.getDate() - 1);

    const fmt = d => d.toISOString().slice(0, 10);

    const thisWeekStats = db.prepare(`
      SELECT COALESCE(SUM(duration_minutes), 0) AS minutes, COUNT(*) AS sessions
      FROM practice_sessions
      WHERE student_id = ? AND date >= ?
    `).get(studentId, fmt(thisMonday));

    const lastWeekStats = db.prepare(`
      SELECT COALESCE(SUM(duration_minutes), 0) AS minutes
      FROM practice_sessions
      WHERE student_id = ? AND date >= ? AND date <= ?
    `).get(studentId, fmt(lastMonday), fmt(lastSunday));

    const monthStart = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
    const thisMonthStats = db.prepare(`
      SELECT COALESCE(SUM(duration_minutes), 0) AS minutes
      FROM practice_sessions
      WHERE student_id = ? AND date >= ?
    `).get(studentId, monthStart);

    const totalStats = db.prepare(`
      SELECT COUNT(*) AS sessions, COALESCE(AVG(duration_minutes), 0) AS avg_minutes
      FROM practice_sessions
      WHERE student_id = ?
    `).get(studentId);

    const currentStreak = computeStreak(studentId);
    const goalMinutes = getPracticeGoal(studentId);

    res.json({
      this_week_minutes: thisWeekStats.minutes,
      last_week_minutes: lastWeekStats.minutes,
      this_month_minutes: thisMonthStats.minutes,
      total_sessions: totalStats.sessions,
      avg_session_minutes: Math.round(totalStats.avg_minutes),
      current_streak: currentStreak,
      goal_minutes: goalMinutes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/practice-log
router.post('/', (req, res) => {
  try {
    const { date, duration_minutes, piece, composer, course_id, focus_area, quality_rating, notes } = req.body;

    if (!date || !duration_minutes) {
      return res.status(400).json({ error: 'date and duration_minutes are required' });
    }

    if (quality_rating !== undefined && (quality_rating < 1 || quality_rating > 5)) {
      return res.status(400).json({ error: 'quality_rating must be 1–5' });
    }

    const result = db.prepare(`
      INSERT INTO practice_sessions (student_id, date, duration_minutes, piece, composer, course_id, focus_area, quality_rating, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, date, duration_minutes,
      piece || null, composer || null, course_id || null,
      focus_area || null, quality_rating || null, notes || null
    );

    const session = db.prepare('SELECT * FROM practice_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/practice-log/:id
router.put('/:id', (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM practice_sessions WHERE id = ? AND student_id = ?').get(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { date, duration_minutes, piece, composer, course_id, focus_area, quality_rating, notes } = req.body;

    db.prepare(`
      UPDATE practice_sessions SET
        date = COALESCE(?, date),
        duration_minutes = COALESCE(?, duration_minutes),
        piece = ?,
        composer = ?,
        course_id = ?,
        focus_area = ?,
        quality_rating = ?,
        notes = ?
      WHERE id = ? AND student_id = ?
    `).run(
      date || null, duration_minutes || null,
      piece !== undefined ? piece : session.piece,
      composer !== undefined ? composer : session.composer,
      course_id !== undefined ? course_id : session.course_id,
      focus_area !== undefined ? focus_area : session.focus_area,
      quality_rating !== undefined ? quality_rating : session.quality_rating,
      notes !== undefined ? notes : session.notes,
      req.params.id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM practice_sessions WHERE id = ?').get(req.params.id);
    res.json({ session: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/practice-log/:id
router.delete('/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM practice_sessions WHERE id = ? AND student_id = ?').run(req.params.id, req.user.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ message: 'Session deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
