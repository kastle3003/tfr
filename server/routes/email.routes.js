const express = require('express');
const router = express.Router();
const db = require('../db');
const mailer = require('../lib/mailer');

// Default email templates to seed on startup. These are DB-editable via the
// admin UI; the mailer falls back to its own in-code templates when a row is
// absent.
const DEFAULT_TEMPLATES = [
  {
    name: 'welcome',
    subject: 'Welcome to The Foundation Room',
    html_body: `<!DOCTYPE html>
<html><body style="font-family:Georgia,serif;background:#F4EBD0;margin:0;padding:0;">
<div style="max-width:600px;margin:40px auto;background:#FAF7EE;border:1px solid #D1A14E;border-radius:8px;overflow:hidden;">
  <div style="background:#2D4F1E;padding:28px 32px;">
    <h1 style="font-family:Georgia,serif;font-style:italic;color:#F4EBD0;margin:0;font-size:26px;">The Foundation Room</h1>
    <p style="color:rgba(244,235,208,0.7);margin:4px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Welcome</p>
  </div>
  <div style="padding:32px;">
    <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Welcome, {{student_name}}.</h2>
    <p style="color:#4A3C28;line-height:1.7;margin:16px 0;">Your account has been created at The Foundation Room. We are delighted to have you join our community of dedicated musicians.</p>
    <p style="color:#4A3C28;line-height:1.7;margin:16px 0;">You can now browse our library of courses, access sheet music from the archive, and connect with world-class instructors.</p>
    <a href="{{login_url}}" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;margin:12px 0;">Begin Your Studies →</a>
    <p style="color:#7A6A52;font-size:12px;margin-top:28px;border-top:1px solid #D1A14E;padding-top:16px;">The Foundation Room · Est. 1952</p>
  </div>
</div>
</body></html>`,
    variables: JSON.stringify(['student_name', 'login_url'])
  },
  {
    name: 'enrollment_confirmation',
    subject: 'Enrolled: {{course_name}}',
    html_body: `<!DOCTYPE html>
<html><body style="font-family:Georgia,serif;background:#F4EBD0;margin:0;padding:0;">
<div style="max-width:600px;margin:40px auto;background:#FAF7EE;border:1px solid #D1A14E;border-radius:8px;overflow:hidden;">
  <div style="background:#2D4F1E;padding:28px 32px;">
    <h1 style="font-family:Georgia,serif;font-style:italic;color:#F4EBD0;margin:0;font-size:26px;">The Foundation Room</h1>
    <p style="color:rgba(244,235,208,0.7);margin:4px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Enrollment Confirmed</p>
  </div>
  <div style="padding:32px;">
    <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">You're enrolled, {{student_name}}.</h2>
    <p style="color:#4A3C28;line-height:1.7;margin:16px 0;">Your enrollment in <strong>{{course_name}}</strong> has been confirmed.</p>
    <div style="background:#F4EBD0;border-left:3px solid #D1A14E;padding:14px 18px;margin:18px 0;border-radius:0 6px 6px 0;">
      <p style="margin:0;color:#4A3C28;font-size:13px;"><strong>Course:</strong> {{course_name}}</p>
      <p style="margin:6px 0 0;color:#4A3C28;font-size:13px;"><strong>Instructor:</strong> {{instructor_name}}</p>
      <p style="margin:6px 0 0;color:#4A3C28;font-size:13px;"><strong>Enrolled on:</strong> {{enrollment_date}}</p>
    </div>
    <a href="{{course_url}}" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;margin:12px 0;">Go to Course →</a>
    <p style="color:#7A6A52;font-size:12px;margin-top:28px;border-top:1px solid #D1A14E;padding-top:16px;">The Foundation Room · Est. 1952</p>
  </div>
</div>
</body></html>`,
    variables: JSON.stringify(['student_name', 'course_name', 'instructor_name', 'enrollment_date', 'course_url'])
  },
  {
    name: 'assignment_graded',
    subject: 'Your assignment has been graded',
    html_body: `<!DOCTYPE html>
<html><body style="font-family:Georgia,serif;background:#F4EBD0;margin:0;padding:0;">
<div style="max-width:600px;margin:40px auto;background:#FAF7EE;border:1px solid #D1A14E;border-radius:8px;overflow:hidden;">
  <div style="background:#2D4F1E;padding:28px 32px;">
    <h1 style="font-family:Georgia,serif;font-style:italic;color:#F4EBD0;margin:0;font-size:26px;">The Foundation Room</h1>
    <p style="color:rgba(244,235,208,0.7);margin:4px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Assignment Graded</p>
  </div>
  <div style="padding:32px;">
    <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Your work has been reviewed.</h2>
    <p style="color:#4A3C28;line-height:1.7;margin:16px 0;">Dear {{student_name}}, your submission for <strong>{{assignment_title}}</strong> has been graded.</p>
    <div style="background:#F4EBD0;border-left:3px solid #D1A14E;padding:14px 18px;margin:18px 0;border-radius:0 6px 6px 0;">
      <p style="margin:0;color:#4A3C28;font-size:13px;"><strong>Assignment:</strong> {{assignment_title}}</p>
      <p style="margin:6px 0 0;color:#4A3C28;font-size:13px;"><strong>Grade:</strong> {{grade}}</p>
      <p style="margin:6px 0 0;color:#4A3C28;font-size:13px;"><strong>Graded by:</strong> {{instructor_name}}</p>
    </div>
    <p style="color:#4A3C28;line-height:1.7;margin:16px 0;font-style:italic;"><strong>Feedback:</strong> {{feedback}}</p>
    <a href="{{submission_url}}" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;margin:12px 0;">View Full Feedback →</a>
    <p style="color:#7A6A52;font-size:12px;margin-top:28px;border-top:1px solid #D1A14E;padding-top:16px;">The Foundation Room · Est. 1952</p>
  </div>
</div>
</body></html>`,
    variables: JSON.stringify(['student_name', 'assignment_title', 'grade', 'instructor_name', 'feedback', 'submission_url'])
  },
  {
    name: 'masterclass_reminder',
    subject: 'Masterclass Tomorrow: {{title}}',
    html_body: `<!DOCTYPE html>
<html><body style="font-family:Georgia,serif;background:#F4EBD0;margin:0;padding:0;">
<div style="max-width:600px;margin:40px auto;background:#FAF7EE;border:1px solid #D1A14E;border-radius:8px;overflow:hidden;">
  <div style="background:#2D4F1E;padding:28px 32px;">
    <h1 style="font-family:Georgia,serif;font-style:italic;color:#F4EBD0;margin:0;font-size:26px;">The Foundation Room</h1>
    <p style="color:rgba(244,235,208,0.7);margin:4px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Masterclass Reminder</p>
  </div>
  <div style="padding:32px;">
    <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Tomorrow: {{title}}</h2>
    <p style="color:#4A3C28;line-height:1.7;margin:16px 0;">This is a reminder that your masterclass is scheduled for tomorrow.</p>
    <div style="background:#F4EBD0;border-left:3px solid #D1A14E;padding:14px 18px;margin:18px 0;border-radius:0 6px 6px 0;">
      <p style="margin:0;color:#4A3C28;font-size:13px;"><strong>Masterclass:</strong> {{title}}</p>
      <p style="margin:6px 0 0;color:#4A3C28;font-size:13px;"><strong>Instructor:</strong> {{instructor_name}}</p>
      <p style="margin:6px 0 0;color:#4A3C28;font-size:13px;"><strong>Date &amp; Time:</strong> {{scheduled_at}}</p>
      <p style="margin:6px 0 0;color:#4A3C28;font-size:13px;"><strong>Duration:</strong> {{duration}} minutes</p>
    </div>
    <a href="{{meeting_url}}" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;margin:12px 0;">Join Meeting →</a>
    <p style="color:#7A6A52;font-size:12px;margin-top:28px;border-top:1px solid #D1A14E;padding-top:16px;">The Foundation Room · Est. 1952</p>
  </div>
</div>
</body></html>`,
    variables: JSON.stringify(['title', 'instructor_name', 'scheduled_at', 'duration', 'meeting_url'])
  },
  {
    name: 'custom_announcement',
    subject: '{{subject}}',
    html_body: `<!DOCTYPE html>
<html><body style="font-family:Georgia,serif;background:#F4EBD0;margin:0;padding:0;">
<div style="max-width:600px;margin:40px auto;background:#FAF7EE;border:1px solid #D1A14E;border-radius:8px;overflow:hidden;">
  <div style="background:#2D4F1E;padding:28px 32px;">
    <h1 style="font-family:Georgia,serif;font-style:italic;color:#F4EBD0;margin:0;font-size:26px;">The Foundation Room</h1>
    <p style="color:rgba(244,235,208,0.7);margin:4px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Announcement</p>
  </div>
  <div style="padding:32px;color:#4A3C28;line-height:1.7;">
    {{body}}
    <p style="color:#7A6A52;font-size:12px;margin-top:28px;border-top:1px solid #D1A14E;padding-top:16px;">The Foundation Room · Est. 1952</p>
  </div>
</div>
</body></html>`,
    variables: JSON.stringify(['subject', 'body'])
  }
];

function seedTemplates() {
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO email_templates (name, subject, html_body, variables)
      VALUES (?, ?, ?, ?)
    `);
    const seedAll = db.transaction(() => {
      for (const t of DEFAULT_TEMPLATES) {
        insert.run(t.name, t.subject, t.html_body, t.variables);
      }
    });
    seedAll();
  } catch (e) {
    // Table may not exist yet at startup — will be created by db-sprint4.js
  }
}
setImmediate(seedTemplates);

function requireAdmin(req, res) {
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}
function requireInstructorOrAdmin(req, res) {
  if (!['instructor', 'admin'].includes(req.user.role)) {
    res.status(403).json({ error: 'Instructor or admin access required' });
    return false;
  }
  return true;
}

// ─── Templates ────────────────────────────────────────────────────────────

router.get('/templates', (req, res) => {
  if (!requireInstructorOrAdmin(req, res)) return;
  try {
    const templates = db.prepare('SELECT * FROM email_templates ORDER BY name').all();
    res.json({ templates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/templates/:name', (req, res) => {
  if (!requireInstructorOrAdmin(req, res)) return;
  try {
    const template = db.prepare('SELECT * FROM email_templates WHERE name = ?').get(req.params.name);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/templates/:name', (req, res) => {
  if (!requireInstructorOrAdmin(req, res)) return;
  try {
    const { subject, html_body, variables } = req.body;
    const existing = db.prepare('SELECT * FROM email_templates WHERE name = ?').get(req.params.name);
    if (existing) {
      db.prepare(`
        UPDATE email_templates SET
          subject = COALESCE(?, subject),
          html_body = COALESCE(?, html_body),
          variables = COALESCE(?, variables),
          updated_at = datetime('now')
        WHERE name = ?
      `).run(subject, html_body, variables ? JSON.stringify(variables) : null, req.params.name);
    } else {
      if (!subject || !html_body) return res.status(400).json({ error: 'subject and html_body required' });
      db.prepare(`
        INSERT INTO email_templates (name, subject, html_body, variables) VALUES (?, ?, ?, ?)
      `).run(req.params.name, subject, html_body, variables ? JSON.stringify(variables) : '[]');
    }
    const template = db.prepare('SELECT * FROM email_templates WHERE name = ?').get(req.params.name);
    res.json({ template, message: 'Template saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SMTP status ──────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  if (!requireInstructorOrAdmin(req, res)) return;
  res.json({ smtp: mailer.status() });
});

// ─── Templated send ───────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  if (!requireInstructorOrAdmin(req, res)) return;
  try {
    const { template_name, to_email, variables = {} } = req.body;
    if (!to_email) return res.status(400).json({ error: 'to_email is required' });
    if (!template_name) return res.status(400).json({ error: 'template_name is required' });

    const result = await mailer.sendTemplate(template_name, to_email, variables);
    if (result.ok && result.delivered) {
      return res.json({ message: `Email sent to ${to_email}`, messageId: result.messageId });
    }
    if (result.ok && result.logged) {
      return res.json({ message: `SMTP not configured — logged only for ${to_email}`, logged: true });
    }
    return res.status(502).json({ error: `Send failed: ${result.error}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Custom free-form send (admin) ────────────────────────────────────────

router.post('/send-custom', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { to_email, subject, html_body, reply_to } = req.body;
    if (!to_email || !subject || !html_body) {
      return res.status(400).json({ error: 'to_email, subject and html_body are required' });
    }
    const result = await mailer.send({
      to: to_email, subject, html: html_body, replyTo: reply_to, template_name: 'custom'
    });
    if (result.ok && result.delivered) {
      return res.json({ message: `Email sent to ${to_email}`, messageId: result.messageId });
    }
    if (result.ok && result.logged) {
      return res.json({ message: `SMTP not configured — logged only for ${to_email}`, logged: true });
    }
    return res.status(502).json({ error: `Send failed: ${result.error}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bulk send (admin) ────────────────────────────────────────────────────
// audience: 'all-students' | 'all-instructors' | 'all-users' | 'custom'
router.post('/send-bulk', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { audience = 'custom', emails, subject, html_body, reply_to } = req.body;
    if (!subject || !html_body) {
      return res.status(400).json({ error: 'subject and html_body are required' });
    }

    let recipients = [];
    if (audience === 'all-students') {
      recipients = db.prepare(`SELECT email FROM users WHERE role = 'student'`).all().map(r => r.email);
    } else if (audience === 'all-instructors') {
      recipients = db.prepare(`SELECT email FROM users WHERE role = 'instructor'`).all().map(r => r.email);
    } else if (audience === 'all-users') {
      recipients = db.prepare(`SELECT email FROM users`).all().map(r => r.email);
    } else {
      const raw = Array.isArray(emails) ? emails : String(emails || '').split(/[,\s;]+/);
      recipients = raw.map(e => String(e).trim()).filter(Boolean);
    }

    recipients = Array.from(new Set(recipients.map(e => e.toLowerCase())));
    if (!recipients.length) return res.status(400).json({ error: 'No recipients resolved' });

    // Respond immediately with job summary; per-address outcomes land in email_logs.
    res.json({ message: `Queued ${recipients.length} emails`, count: recipients.length, audience });

    (async () => {
      let sent = 0, failed = 0;
      for (const to of recipients) {
        const r = await mailer.send({ to, subject, html: html_body, replyTo: reply_to, template_name: `bulk:${audience}` });
        if (r.ok && r.delivered) sent++; else failed++;
        await new Promise(r => setTimeout(r, 250));
      }
      console.log(`[email] bulk '${audience}' done — sent=${sent} failed=${failed}`);
    })().catch(e => console.error('[email] bulk runner crashed:', e));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Audience preview (admin) ─────────────────────────────────────────────

router.get('/audience/:name', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = req.params.name;
    let rows = [];
    if (name === 'all-students') rows = db.prepare(`SELECT email, first_name, last_name FROM users WHERE role='student'`).all();
    else if (name === 'all-instructors') rows = db.prepare(`SELECT email, first_name, last_name FROM users WHERE role='instructor'`).all();
    else if (name === 'all-users') rows = db.prepare(`SELECT email, first_name, last_name FROM users`).all();
    else return res.status(400).json({ error: 'Unknown audience' });
    res.json({ count: rows.length, recipients: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Logs ─────────────────────────────────────────────────────────────────

router.get('/logs', (req, res) => {
  if (!requireInstructorOrAdmin(req, res)) return;
  try {
    const logs = db.prepare('SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 200').all();
    res.json({ logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
