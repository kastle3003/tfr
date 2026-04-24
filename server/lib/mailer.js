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
      replyTo: replyTo || SENDER,
      headers: {
        'X-Mailer': 'The Foundation Room',
        'X-Priority': '3',
        'List-Unsubscribe': `<mailto:${SENDER}?subject=unsubscribe>`,
      }
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
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <title>${kicker} — The Foundation Room</title>
</head>
<body style="margin:0;padding:0;background-color:#F4EBD0;font-family:Georgia,serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4EBD0;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background-color:#FAF7EE;border-radius:8px;overflow:hidden;border:1px solid #D1A14E;">
      <!-- HEADER -->
      <tr>
        <td style="background-color:#1A1208;padding:24px 32px;">
          <p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:22px;color:#C8A84B;letter-spacing:0.01em;">The Foundation Room</p>
          <p style="margin:4px 0 0;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(200,168,75,0.5);">${kicker}</p>
        </td>
      </tr>
      <!-- BODY -->
      <tr>
        <td style="padding:32px;color:#4A3C28;line-height:1.75;font-size:15px;">
          ${inner}
        </td>
      </tr>
      <!-- FOOTER -->
      <tr>
        <td style="padding:16px 32px 20px;border-top:1px solid #D1A14E;color:#9A8A72;font-size:11px;font-family:Arial,sans-serif;line-height:1.5;">
          <p style="margin:0 0 4px;">The Foundation Room &nbsp;|&nbsp; Mumbai, India</p>
          <p style="margin:0;color:#b8a088;">This is a transactional email related to your account. If you did not request this, you can safely ignore it.</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

const FALLBACK_TEMPLATES = {
  otp_verification: {
    subject: 'TFR: {{otp}} is your verification code',
    html_body: wrap('Email Verification', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;margin:0 0 12px;">Hello, {{first_name}}.</h2>
      <p style="margin:0 0 20px;">Use the code below to verify your account. This code is valid for <strong>10 minutes</strong> and can only be used once.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:8px 0 24px;">
          <div style="display:inline-block;font-size:36px;letter-spacing:10px;font-weight:700;background:#F4EBD0;border:1px solid #D1A14E;padding:16px 28px;border-radius:6px;color:#1A1208;font-family:Georgia,serif;">{{otp}}</div>
        </td></tr>
      </table>
      <p style="color:#7A6A52;font-size:13px;border-top:1px solid #e8d8b8;padding-top:16px;margin:0;">If you did not create an account with The Foundation Room, you can safely ignore this email.</p>`),
  },
  password_reset: {
    subject: 'TFR: Reset your password',
    html_body: wrap('Password Reset', `
      <h2 style="font-family:Georgia,serif;font-style:italic;color:#8B2E26;font-size:22px;margin:0 0 12px;">Hello, {{first_name}}.</h2>
      <p style="margin:0 0 8px;">We received a request to reset the password for your Foundation Room account.</p>
      <p style="margin:0 0 24px;">Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="border-radius:4px;background-color:#8B2E26;">
          <a href="{{reset_url}}" style="display:inline-block;background-color:#8B2E26;color:#FAF7EE;text-decoration:none;padding:13px 30px;border-radius:4px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:0.04em;">Reset my password</a>
        </td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:13px;color:#9A8A72;">If you did not request a password reset, no action is needed — your password will remain unchanged.</p>
      <p style="margin:12px 0 0;font-size:12px;color:#b8a088;word-break:break-all;">If the button above does not work, copy and paste this link into your browser:<br><a href="{{reset_url}}" style="color:#8B2E26;">{{reset_url}}</a></p>`),
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
