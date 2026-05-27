const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/calendar?month=YYYY-MM
router.get('/', (req, res) => {
  try {
    const userId = req.user.id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [year, mon] = month.split('-');
    const startDate = `${year}-${mon}-01`;
    const endDate = new Date(parseInt(year), parseInt(mon), 0).toISOString().slice(0, 10); // last day of month

    // Personal calendar events
    const personalEvents = db.prepare(`
      SELECT * FROM calendar_events
      WHERE user_id = ?
        AND (
          strftime('%Y-%m', start_datetime) = ?
          OR strftime('%Y-%m', end_datetime) = ?
        )
      ORDER BY start_datetime ASC
    `).all(userId, month, month);

    // Masterclasses the user is registered for in this month
    let masterclassEvents = [];
    try {
      masterclassEvents = db.prepare(`
        SELECT m.id, m.title, m.scheduled_at AS start_datetime,
          datetime(m.scheduled_at, '+' || m.duration_minutes || ' minutes') AS end_datetime,
          m.location, m.meeting_url, 'masterclass' AS event_type,
          '#2D4F1E' AS color
        FROM masterclasses m
        JOIN masterclass_registrations mr ON mr.masterclass_id = m.id
        WHERE mr.student_id = ?
          AND strftime('%Y-%m', m.scheduled_at) = ?
        ORDER BY m.scheduled_at ASC
      `).all(userId, month);
    } catch (e) { /* table may not have registrations */ }

    // Assignment due dates from enrollments in this month
    let assignmentEvents = [];
    try {
      assignmentEvents = db.prepare(`
        SELECT a.id, a.title, a.due_date AS start_datetime,
          a.due_date AS end_datetime,
          'assignment' AS event_type,
          '#8B2E26' AS color,
          c.title AS course_title
        FROM assignments a
        JOIN courses c ON a.course_id = c.id
        JOIN enrollments e ON e.course_id = c.id
        WHERE e.student_id = ?
          AND a.due_date IS NOT NULL
          AND strftime('%Y-%m', a.due_date) = ?
          AND a.visible = 1
        ORDER BY a.due_date ASC
      `).all(userId, month);
    } catch (e) { /* assignments table may be empty */ }

    // Combine and tag
    const events = [
      ...personalEvents.map(e => ({ ...e, source: 'personal' })),
      ...masterclassEvents.map(e => ({ ...e, source: 'masterclass', all_day: 0 })),
      ...assignmentEvents.map(e => ({ ...e, source: 'assignment', all_day: 1 }))
    ];

    events.sort((a, b) => (a.start_datetime || '').localeCompare(b.start_datetime || ''));

    res.json({ events, month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendar
router.post('/', (req, res) => {
  try {
    const { title, description, event_type, start_datetime, end_datetime, all_day, color } = req.body;
    if (!title || !start_datetime) {
      return res.status(400).json({ error: 'title and start_datetime are required' });
    }

    const result = db.prepare(`
      INSERT INTO calendar_events (user_id, title, description, event_type, start_datetime, end_datetime, all_day, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, title,
      description || null,
      event_type || 'personal',
      start_datetime,
      end_datetime || null,
      all_day ? 1 : 0,
      color || '#8B2E26'
    );

    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/calendar/:id
router.put('/:id', (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!event) return res.status(404).json({ error: 'Event not found or not authorized' });

    const { title, description, event_type, start_datetime, end_datetime, all_day, color } = req.body;

    db.prepare(`
      UPDATE calendar_events SET
        title = COALESCE(?, title),
        description = ?,
        event_type = COALESCE(?, event_type),
        start_datetime = COALESCE(?, start_datetime),
        end_datetime = ?,
        all_day = COALESCE(?, all_day),
        color = COALESCE(?, color)
      WHERE id = ? AND user_id = ?
    `).run(
      title || null,
      description !== undefined ? description : event.description,
      event_type || null,
      start_datetime || null,
      end_datetime !== undefined ? end_datetime : event.end_datetime,
      all_day !== undefined ? (all_day ? 1 : 0) : null,
      color || null,
      req.params.id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    res.json({ event: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendar/:id
router.delete('/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM calendar_events WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Event not found or not authorized' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
