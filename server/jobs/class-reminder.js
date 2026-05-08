// server/jobs/class-reminder.js
// Polls every 5 minutes. Sends a "Join your live class" email to registered
// attendees of sessions starting in ~30 minutes. Marks reminder_sent so each
// attendee only gets one email per session.
//
// Started automatically by server/index.js on boot.

'use strict';

const db     = require('../db');
const mailer = require('../lib/mailer');

const POLL_INTERVAL_MS  = 5 * 60 * 1000;   // 5 min
const WINDOW_EARLY_MIN  = 35;               // send if class starts within 35 min
const WINDOW_LATE_MIN   = 25;               // but not yet within 25 min (avoid re-send after class starts)

function formatTime(isoString) {
  try {
    return new Date(isoString).toLocaleString('en-IN', {
      timeZone:    'Asia/Kolkata',
      weekday:     'short',
      day:         'numeric',
      month:       'short',
      hour:        '2-digit',
      minute:      '2-digit',
      hour12:      true,
    }) + ' IST';
  } catch (_) { return isoString; }
}

async function runReminderJob() {
  try {
    // Find sessions that start in [now+25min, now+35min] and haven't been reminded
    const sessions = db.prepare(`
      SELECT ls.*, c.title AS course_title
      FROM live_sessions ls
      LEFT JOIN courses c ON ls.course_id = c.id
      WHERE ls.status = 'scheduled'
        AND ls.reminder_sent IS NULL
        AND datetime(ls.scheduled_at) BETWEEN datetime('now', '+${WINDOW_LATE_MIN} minutes')
                                          AND datetime('now', '+${WINDOW_EARLY_MIN} minutes')
    `).all();

    if (!sessions.length) return;

    console.log(`[class-reminder] ${sessions.length} session(s) need reminders`);

    for (const session of sessions) {
      // Get registered attendees with emails
      const attendees = db.prepare(`
        SELECT u.id, u.email, u.first_name
        FROM live_session_attendees lsa
        JOIN users u ON lsa.user_id = u.id
        WHERE lsa.session_id = ?
      `).all(session.id);

      if (!attendees.length) {
        // Mark sent even if no attendees — avoids repeated queries
        db.prepare(`UPDATE live_sessions SET reminder_sent = datetime('now') WHERE id = ?`).run(session.id);
        continue;
      }

      const courseLabel = session.course_title || 'your upcoming class';
      const timeLabel   = formatTime(session.scheduled_at);
      const joinUrl     = session.meeting_url || '#';

      let sent = 0;
      for (const att of attendees) {
        try {
          await mailer.sendTemplate('live_class_reminder', att.email, {
            first_name:  att.first_name || 'Student',
            session_title: session.title,
            course:      courseLabel,
            time:        timeLabel,
            join_url:    joinUrl,
            duration:    session.duration_minutes || 60,
          });
          sent++;
        } catch (e) {
          console.warn(`[class-reminder] email failed for ${att.email}:`, e.message);
        }
      }

      db.prepare(`UPDATE live_sessions SET reminder_sent = datetime('now') WHERE id = ?`).run(session.id);
      console.log(`[class-reminder] session ${session.id} "${session.title}" — reminded ${sent}/${attendees.length} attendees`);
    }
  } catch (err) {
    console.error('[class-reminder] job error:', err.message);
  }
}

function start() {
  // Run once shortly after boot, then on interval
  setTimeout(runReminderJob, 30_000);
  const interval = setInterval(runReminderJob, POLL_INTERVAL_MS);
  // Allow process to exit cleanly
  interval.unref();
  console.log('[class-reminder] job started — polling every 5 min');
}

module.exports = { start, runReminderJob };
