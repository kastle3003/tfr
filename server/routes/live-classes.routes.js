const express = require('express');
const router = express.Router();
const db = require('../db');

let uuidv4;
try {
  const { v4 } = require('uuid');
  uuidv4 = v4;
} catch (e) {
  uuidv4 = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// GET /api/live-sessions
router.get('/', (req, res) => {
  try {
    const { status, course_id } = req.query;
    let query = `
      SELECT ls.*,
        u.first_name || ' ' || u.last_name AS instructor_name,
        u.avatar_initials AS instructor_initials,
        c.title AS course_title,
        (SELECT COUNT(*) FROM live_session_attendees WHERE session_id = ls.id) AS attendee_count
      FROM live_sessions ls
      LEFT JOIN users u ON ls.instructor_id = u.id
      LEFT JOIN courses c ON ls.course_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (status) { query += ' AND ls.status = ?'; params.push(status); }
    if (course_id) { query += ' AND ls.course_id = ?'; params.push(course_id); }

    query += ' ORDER BY ls.scheduled_at ASC';
    const sessions = db.prepare(query).all(...params);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/live-sessions/:id
router.get('/:id', (req, res) => {
  try {
    const session = db.prepare(`
      SELECT ls.*,
        u.first_name || ' ' || u.last_name AS instructor_name,
        u.avatar_initials AS instructor_initials,
        c.title AS course_title,
        (SELECT COUNT(*) FROM live_session_attendees WHERE session_id = ls.id) AS attendee_count
      FROM live_sessions ls
      LEFT JOIN users u ON ls.instructor_id = u.id
      LEFT JOIN courses c ON ls.course_id = c.id
      WHERE ls.id = ?
    `).get(req.params.id);

    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Check if current user is registered
    const isAttendee = req.user ? db.prepare('SELECT 1 FROM live_session_attendees WHERE session_id = ? AND user_id = ?').get(req.params.id, req.user.id) : null;

    res.json({ session, is_registered: !!isAttendee });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live-sessions  (instructor)
router.post('/', async (req, res) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Instructor access required' });
    }

    const { title, description, course_id, masterclass_id, scheduled_at, duration_minutes, max_participants } = req.body;
    if (!title || !scheduled_at) return res.status(400).json({ error: 'title and scheduled_at are required' });

    let meetingUrl;
    let meetingId;

    // If the instructor has connected Google Calendar, create a real Meet
    // event. Any failure falls back to the legacy placeholder so a broken
    // OAuth token never blocks scheduling.
    try {
      const calendarLib = require('../lib/google-calendar');
      if (calendarLib.isConnected(req.user.id)) {
        const ev = await calendarLib.createMeetEvent(req.user.id, {
          title,
          description: description || '',
          startISO: scheduled_at,
          durationMinutes: duration_minutes || 60,
          attendees: [],
        });
        if (ev && ev.meetUrl) {
          meetingUrl = ev.meetUrl;
          meetingId = ev.eventId;
        }
      }
    } catch (e) {
      console.warn('[live-sessions] Google Meet creation failed, falling back to placeholder:', e.message);
    }

    if (!meetingUrl) {
      meetingId = uuidv4().slice(0, 8);
      meetingUrl = `https://meet.archive.edu/room/${meetingId}`;
    }

    const result = db.prepare(`
      INSERT INTO live_sessions (instructor_id, title, description, course_id, masterclass_id, scheduled_at, duration_minutes, meeting_url, meeting_id, max_participants, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `).run(
      req.user.id, title, description || null, course_id || null, masterclass_id || null,
      scheduled_at, duration_minutes || 60, meetingUrl, meetingId, max_participants || 50
    );

    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/live-sessions/:id  (instructor)
router.put('/:id', (req, res) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Instructor access required' });
    }

    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.instructor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your session' });
    }

    const { title, description, course_id, masterclass_id, scheduled_at, duration_minutes, max_participants, recording_url } = req.body;

    db.prepare(`
      UPDATE live_sessions SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        course_id = COALESCE(?, course_id),
        masterclass_id = COALESCE(?, masterclass_id),
        scheduled_at = COALESCE(?, scheduled_at),
        duration_minutes = COALESCE(?, duration_minutes),
        max_participants = COALESCE(?, max_participants),
        recording_url = COALESCE(?, recording_url)
      WHERE id = ?
    `).run(title, description, course_id, masterclass_id, scheduled_at, duration_minutes, max_participants, recording_url, req.params.id);

    const updated = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    res.json({ session: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/live-sessions/:id  (instructor)
router.delete('/:id', (req, res) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Instructor access required' });
    }

    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.instructor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your session' });
    }

    db.prepare('DELETE FROM live_session_attendees WHERE session_id = ?').run(req.params.id);
    db.prepare('DELETE FROM live_sessions WHERE id = ?').run(req.params.id);
    res.json({ message: 'Session cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live-sessions/:id/join  (student)
router.post('/:id/join', (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const attendeeCount = db.prepare('SELECT COUNT(*) AS cnt FROM live_session_attendees WHERE session_id = ?').get(req.params.id).cnt;
    if (attendeeCount >= session.max_participants) {
      return res.status(400).json({ error: 'Session is full' });
    }

    try {
      db.prepare(`
        INSERT INTO live_session_attendees (session_id, user_id, joined_at)
        VALUES (?, ?, datetime('now'))
      `).run(req.params.id, req.user.id);
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        // Update joined_at if already registered
        db.prepare(`UPDATE live_session_attendees SET joined_at = datetime('now') WHERE session_id = ? AND user_id = ?`).run(req.params.id, req.user.id);
      } else throw e;
    }

    res.json({ message: 'Joined session', meeting_url: session.meeting_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live-sessions/:id/leave
router.post('/:id/leave', (req, res) => {
  try {
    db.prepare(`UPDATE live_session_attendees SET left_at = datetime('now') WHERE session_id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    res.json({ message: 'Left session' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/live-sessions/:id/status  (instructor)
router.put('/:id/status', (req, res) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Instructor access required' });
    }

    const { status, recording_url } = req.body;
    if (!status || !['scheduled', 'live', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Valid status required: scheduled, live, completed, cancelled' });
    }

    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.instructor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your session' });
    }

    db.prepare(`
      UPDATE live_sessions SET status = ?, recording_url = COALESCE(?, recording_url) WHERE id = ?
    `).run(status, recording_url || null, req.params.id);

    const updated = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    res.json({ session: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/live-sessions/:id/recording — instructor/admin saves recording URL, marks completed
router.patch('/:id/recording', (req, res) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Instructor access required' });
    }

    const { recording_url } = req.body;
    if (!recording_url || !recording_url.trim()) {
      return res.status(400).json({ error: 'recording_url is required' });
    }

    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.instructor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your session' });
    }

    db.prepare(`UPDATE live_sessions SET recording_url = ?, status = 'completed' WHERE id = ?`)
      .run(recording_url.trim(), req.params.id);

    const updated = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    res.json({ session: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live-sessions/:id/convert-to-lesson — create a course lesson from the recording
router.post('/:id/convert-to-lesson', (req, res) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Instructor access required' });
    }

    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.recording_url) return res.status(400).json({ error: 'No recording URL set on this session' });
    if (!session.course_id) return res.status(400).json({ error: 'Session is not linked to a course' });
    if (session.instructor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your session' });
    }

    const { chapter_id, title } = req.body;
    const lessonTitle = (title || '').trim() || `${session.title} (Recording)`;

    // Pick order_index — append after existing lessons in the chapter (or course if no chapter)
    let maxOrder = 0;
    if (chapter_id) {
      const row = db.prepare('SELECT MAX(order_index) AS m FROM lessons WHERE chapter_id = ?').get(chapter_id);
      maxOrder = (row && row.m != null) ? row.m + 1 : 0;
    } else {
      const row = db.prepare('SELECT MAX(order_index) AS m FROM lessons WHERE course_id = ? AND chapter_id IS NULL').get(session.course_id);
      maxOrder = (row && row.m != null) ? row.m + 1 : 0;
    }

    const result = db.prepare(`
      INSERT INTO lessons (chapter_id, course_id, title, order_index, type, content_url, duration_minutes)
      VALUES (?, ?, ?, ?, 'video', ?, ?)
    `).run(
      chapter_id || null,
      session.course_id,
      lessonTitle,
      maxOrder,
      session.recording_url,
      session.duration_minutes || null
    );

    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ lesson });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
