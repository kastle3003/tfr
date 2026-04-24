const nodemailer = require('nodemailer');
const db = require('../db');

// ── ZeptoMail SMTP (Zoho's transactional email service) ──
// Reads ZEPTO_* env vars; falls back to legacy ZOHO_* names if set.
const SMTP_HOST   = process.env.ZEPTO_HOST   || process.env.ZOHO_HOST   || 'smtp.zeptomail.in';
const SMTP_PORT   = parseInt(process.env.ZEPTO_PORT || process.env.ZOHO_PORT || '587', 10);
const SMTP_USER   = process.env.ZEPTO_USER   || 'emailapikey';
const SMTP_TOKEN  = process.env.ZEPTO_TOKEN  || process.env.ZOHO_PASS   || '';
const SENDER      = process.env.ZEPTO_SENDER || process.env.ZOHO_USER   || '';
const FROM_NAME   = process.env.ZEPTO_FROM_NAME || process.env.ZOHO_FROM_NAME || 'The Foundation Room';

let transporter = null;
let verified = false;
let lastError = null;

function isConfigured() {
  return Boolean(SMTP_USER && SMTP_TOKEN && SENDER);
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,      // 465 = SSL, 587 = STARTTLS
    requireTLS: SMTP_PORT !== 465,   // force STARTTLS on 587
    auth: { user: SMTP_USER, pass: SMTP_TOKEN },
    tls: { rejectUnauthorized: true }
  });
  transporter.verify((err) => {
    if (err) {
      verified = false;
      lastError = err.message;
      console.warn('[mailer] ZeptoMail SMTP verify failed:', err.message);
    } else {
      verified = true;
      lastError = null;
      console.log(`[mailer] ZeptoMail SMTP ready (from ${SENDER} via ${SMTP_HOST}:${SMTP_PORT})`);
    }
  });
  return transporter;
}

function logRow({ to, subject, template_name, status, error }) {
  try {
    db.prepare(
      `INSERT INTO email_logs (to_email, subject, template_name, status, error) VALUES (?, ?, ?, ?, ?)`
    ).run(to, subject, template_name || null, status, error || null);
  } catch (_) { /* table may not exist yet at boot */ }
}

async function send({ to, subject, html, text, replyTo, template_name }) {
  if (!to) throw new Error('`to` is required');
  if (!isConfigured()) {
    logRow({ to, subject, template_name, status: 'logged', error: 'smtp_not_configured' });
    return { ok: true, delivered: false, logged: true };
  }
  try {
    const tx = getTransporter();
    const info = await tx.sendMail({
      from: `"${FROM_NAME}" <${SENDER}>`,
      to,
      subject,
      html,
      text: text || stripHtml(html || ''),
      replyTo: replyTo || undefined
    });
    logRow({ to, subject, template_name, status: 'sent' });
    return { ok: true, delivered: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } catch (err) {
    console.error('[mailer] send failed:', err?.message || err);
    logRow({ to, subject, template_name, status: 'failed', error: String(err?.message || err).slice(0, 500) });
    return { ok: false, error: err?.message || String(err) };
  }
}

function mergeVariables(text, variables = {}) {
  let out = String(text || '');
  for (const [key, val] of Object.entries(variables)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), val == null ? '' : String(val));
  }
  return out;
}

// Render template from DB (or fallback), merge vars, send.
async function sendTemplate(templateName, to, variables = {}) {
  let tpl = null;
  try { tpl = db.prepare('SELECT * FROM email_templates WHERE name = ?').get(templateName); } catch (_) {}
  const fallback = FALLBACK_TEMPLATES[templateName];
  const subjectSrc = tpl?.subject || fallback?.subject || 'The Foundation Room';
  const bodySrc = tpl?.html_body || fallback?.html_body || '<p>A message from The Foundation Room.</p>';
  const vars = { ...variables, frontend_url: frontendUrl() };
  return send({
    to,
    subject: mergeVariables(subjectSrc, vars),
    html: mergeVariables(bodySrc, vars),
    template_name: templateName,
  });
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function status() {
  return {
    configured: isConfigured(),
    user: SENDER || null,
    host: SMTP_HOST,
    port: SMTP_PORT,
    verified,
    lastError
  };
}

// ── Fallback templates — used when the admin hasn't customised the DB row ──
function wrap(kicker, inner) {
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#F4EBD0;margin:0;padding:0;">
<div style="max-width:600px;margin:40px auto;background:#FAF7EE;border:1px solid #D1A14E;border-radius:8px;overflow:hidden;">
  <div style="background:#2D4F1E;padding:28px 32px;">
    <h1 style="font-family:Georgia,serif;font-style:italic;color:#F4EBD0;margin:0;font-size:26px;">The Foundation Room</h1>
    <p style="color:rgba(244,235,208,0.7);margin:4px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;">${kicker}</p>
  </div>
  <div style="padding:32px;color:#4A3C28;line-height:1.7;">${inner}</div>
  <div style="padding:12px 32px 24px;color:#7A6A52;font-size:11px;border-top:1px solid #D1A14E;">The Foundation Room · Est. 1952</div>
</div></body></html>`;
}

const FALLBACK_TEMPLATES = {
  otp_verification: {
    subject: 'Your verification code: {{otp}}',
    html_body: wrap('Verify your email', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Welcome, {{first_name}}.</h2>
      <p>Use the code below to verify your account. It expires in 10 minutes.</p>
      <div style="font-size:34px;letter-spacing:8px;font-weight:700;background:#F4EBD0;border:1px dashed #D1A14E;padding:18px 24px;text-align:center;border-radius:6px;margin:18px 0;color:#2D4F1E;">{{otp}}</div>
      <p style="color:#7A6A52;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>`),
  },
  password_reset: {
    subject: 'Reset your password',
    html_body: wrap('Reset password', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Password reset requested</h2>
      <p>Hello {{first_name}}, click the button below to choose a new password. This link expires in one hour.</p>
      <a href="{{reset_url}}" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;margin:12px 0;">Reset password →</a>
      <p style="color:#7A6A52;font-size:12px;">If you didn't request a reset, you can safely ignore this email — your password will stay the same.</p>`),
  },
  payment_success: {
    subject: 'Payment received — ₹{{amount_rupees}}',
    html_body: wrap('Payment received', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Thank you, {{first_name}}.</h2>
      <p>We've received your payment of <strong>₹{{amount_rupees}}</strong> for <strong>{{item_name}}</strong>.</p>
      <div style="background:#F4EBD0;border-left:3px solid #D1A14E;padding:14px 18px;margin:18px 0;border-radius:0 6px 6px 0;">
        <p style="margin:0;font-size:13px;"><strong>Order id:</strong> {{order_id}}</p>
        <p style="margin:6px 0 0;font-size:13px;"><strong>Payment id:</strong> {{payment_id}}</p>
        <p style="margin:6px 0 0;font-size:13px;"><strong>Amount:</strong> ₹{{amount_rupees}}</p>
      </div>
      <a href="{{frontend_url}}/student-payments.html" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;">View receipt →</a>`),
  },
  course_unlocked: {
    subject: "You're enrolled: {{course_name}}",
    html_body: wrap('Course unlocked', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">You're in, {{first_name}}.</h2>
      <p>Your access to <strong>{{course_name}}</strong> is now live. Begin at any time.</p>
      <a href="{{course_url}}" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;">Open course →</a>`),
  },
  course_upgraded: {
    subject: 'Upgraded to full bundle: {{course_name}}',
    html_body: wrap('Upgrade complete', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Upgrade complete.</h2>
      <p>All foundations of <strong>{{course_name}}</strong> are now unlocked. We've credited the foundations you already purchased.</p>
      <a href="{{course_url}}" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;">Continue learning →</a>`),
  },
  foundation_unlocked: {
    subject: 'Foundation unlocked: {{foundation_name}}',
    html_body: wrap('Foundation unlocked', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">{{foundation_name}} is yours.</h2>
      <p>Dive in whenever you're ready.</p>
      <a href="{{frontend_url}}/student-courses.html" style="display:inline-block;background:#8B2E26;color:#F4EBD0;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;">Start practising →</a>`),
  },
  lecture_completed: {
    subject: 'Lecture completed: {{title}}',
    html_body: wrap('Lecture completed', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;">Well done.</h2>
      <p>You've completed <strong>{{title}}</strong>. Keep the rhythm going.</p>`),
  },
};

// Warm up transporter so verify runs at server start
getTransporter();

module.exports = { send, sendTemplate, isConfigured, status, mergeVariables, frontendUrl };
