// One-shot: insert the 'waitlist_welcome' email template if not present.
// Idempotent. Run: node server/scripts/seed-waitlist-template.js

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/archive.db');

const NAME = 'waitlist_welcome';
const SUBJECT = 'Welcome to The Foundation Room — {{course}}';
const HTML = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#0f0a05;color:#e8d5b3;">
  <h1 style="color:#c8a84b;font-size:22px;margin-bottom:18px;">Welcome to The Foundation Room</h1>
  <p style="font-size:15px;line-height:1.6;margin-bottom:14px;">Thank you for your interest in <strong>{{course}}</strong>.</p>
  <p style="font-size:15px;line-height:1.6;margin-bottom:14px;">We've added you to the waitlist. As soon as enrolment opens for the next batch we will reach out with details on the live class schedule, supporting materials, and the welcome session with the maestro.</p>
  <p style="font-size:15px;line-height:1.6;margin-bottom:14px;">If you have any questions, just reply to this email — a real human reads it.</p>
  <p style="font-size:13px;color:#a08862;margin-top:28px;">— The Foundation Room team<br/><a href="https://tfrplay.com" style="color:#c8a84b;text-decoration:none;">tfrplay.com</a></p>
</div>`;

function main() {
  const db = new Database(DB_PATH);
  const existing = db.prepare("SELECT id FROM email_templates WHERE name = ?").get(NAME);
  if (existing) {
    console.log(`Template '${NAME}' already exists (id=${existing.id}); nothing to do.`);
    return;
  }
  const r = db.prepare(`
    INSERT INTO email_templates (name, subject, html_body, variables)
    VALUES (?, ?, ?, ?)
  `).run(NAME, SUBJECT, HTML, JSON.stringify(['course']));
  console.log(`Inserted '${NAME}' template, id=${r.lastInsertRowid}`);
  console.log('Edit it any time via /email-automation.html in the admin panel.');
}

main();
