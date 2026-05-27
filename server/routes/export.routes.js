const express = require('express');
const router = express.Router();
const db = require('../db');

// CSV helpers
function csvCell(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function toCSV(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}
function fmtDate(str) { return str ? str.slice(0, 10) : ''; }
function fmtINR(paise) { return paise ? (paise / 100).toFixed(2) : '0.00'; }

function sendCSV(res, filename, headers, rows) {
  const csv = '﻿' + toCSV(headers, rows); // BOM for Excel UTF-8
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
}

function requireInstructorOrAdmin(req, res, next) {
  if (!['instructor', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ── GET /api/export/preview ─ return record counts for the UI ──────────────
router.get('/preview', requireInstructorOrAdmin, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const id = req.user.id;

    let students, enrollments, payments;

    if (isAdmin) {
      students    = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'student'`).get().c;
      enrollments = db.prepare(`SELECT COUNT(*) AS c FROM enrollments`).get().c;
      payments    = db.prepare(`SELECT COUNT(*) AS c FROM payments`).get().c;
    } else {
      students    = db.prepare(`
        SELECT COUNT(DISTINCT e.student_id) AS c FROM enrollments e
        JOIN courses c ON e.course_id = c.id WHERE c.instructor_id = ?
      `).get(id).c;
      enrollments = db.prepare(`
        SELECT COUNT(*) AS c FROM enrollments e
        JOIN courses c ON e.course_id = c.id WHERE c.instructor_id = ?
      `).get(id).c;
      payments    = db.prepare(`
        SELECT COUNT(*) AS c FROM payments p
        JOIN courses c ON p.course_id = c.id WHERE c.instructor_id = ?
      `).get(id).c;
    }

    res.json({ students, enrollments, payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/export/students ────────────────────────────────────────────────
router.get('/students', requireInstructorOrAdmin, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const params = isAdmin ? [] : [req.user.id];

    const instrFilter = isAdmin
      ? ''
      : `AND u.id IN (
          SELECT DISTINCT e.student_id FROM enrollments e
          JOIN courses c ON e.course_id = c.id
          WHERE c.instructor_id = ?
        )`;

    const rows = db.prepare(`
      SELECT
        u.id, u.first_name, u.last_name, u.email, u.instrument, u.bio, u.created_at,
        up.phone, up.location, up.practice_goal_minutes, up.social_links
      FROM users u
      LEFT JOIN user_profile up ON up.user_id = u.id
      WHERE u.role = 'student'
      ${instrFilter}
      ORDER BY u.created_at DESC
    `).all(...params);

    const headers = [
      'ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Location',
      'Instrument', 'Bio', 'Member Since', 'Practice Goal (min)',
      'Website', 'YouTube', 'Instagram', 'Twitter / X', 'LinkedIn',
      'Spotify', 'SoundCloud', 'Facebook', 'TikTok', 'Bandcamp', 'Apple Music'
    ];

    const data = rows.map(u => {
      const sl = JSON.parse(u.social_links || '{}');
      return [
        u.id, u.first_name || '', u.last_name || '', u.email || '',
        u.phone || '', u.location || '', u.instrument || '', (u.bio || '').replace(/\n/g, ' '),
        fmtDate(u.created_at), u.practice_goal_minutes || 60,
        sl.website || '', sl.youtube || '', sl.instagram || '', sl.twitter || '',
        sl.linkedin || '', sl.spotify || '', sl.soundcloud || '',
        sl.facebook || '', sl.tiktok || '', sl.bandcamp || '', sl.applemusic || ''
      ];
    });

    sendCSV(res, 'students_profiles.csv', headers, data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/export/enrollments ─ profiles + enrollment + payment ───────────
router.get('/enrollments', requireInstructorOrAdmin, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const filter = isAdmin ? '' : 'WHERE c.instructor_id = ?';
    const params = isAdmin ? [] : [req.user.id];

    const rows = db.prepare(`
      SELECT
        u.id AS student_id,
        u.first_name, u.last_name, u.email, u.instrument,
        up.phone, up.location,
        c.title AS course_title, c.level AS course_level, c.instrument AS course_instrument,
        ins.first_name || ' ' || ins.last_name AS instructor_name,
        e.enrolled_at, e.last_accessed_at, e.progress_pct, e.completed_at,
        CASE
          WHEN e.progress_pct >= 80 THEN 'Excellent'
          WHEN e.progress_pct >= 50 THEN 'On Track'
          ELSE 'At Risk'
        END AS progress_status,
        COALESCE(pur.status, pay.status, 'free') AS payment_status,
        COALESCE(pur.amount_paise, pay.amount_paise, 0) AS amount_paise,
        COALESCE(pur.type, 'free') AS purchase_type,
        COALESCE(pur.created_at, pay.created_at, '') AS payment_date
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      JOIN users u ON e.student_id = u.id
      LEFT JOIN users ins ON c.instructor_id = ins.id
      LEFT JOIN user_profile up ON up.user_id = u.id
      LEFT JOIN purchases pur
        ON pur.user_id = e.student_id AND pur.course_id = e.course_id AND pur.status = 'completed'
      LEFT JOIN payments pay
        ON pay.user_id = e.student_id AND pay.course_id = e.course_id AND pay.status = 'paid'
      ${filter}
      ORDER BY e.enrolled_at DESC
    `).all(...params);

    const headers = [
      'Student ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Location', 'Instrument',
      'Course', 'Course Level', 'Course Instrument', 'Instructor',
      'Enrolled Date', 'Last Accessed', 'Progress %', 'Completed Date', 'Progress Status',
      'Payment Status', 'Purchase Type', 'Amount Paid (INR)', 'Payment Date'
    ];

    const data = rows.map(r => [
      r.student_id, r.first_name || '', r.last_name || '', r.email || '',
      r.phone || '', r.location || '', r.instrument || '',
      r.course_title || '', r.course_level || '', r.course_instrument || '', r.instructor_name || '',
      fmtDate(r.enrolled_at), fmtDate(r.last_accessed_at),
      r.progress_pct || 0, fmtDate(r.completed_at), r.progress_status,
      r.payment_status || 'free', r.purchase_type || 'free',
      fmtINR(r.amount_paise), fmtDate(r.payment_date)
    ]);

    sendCSV(res, 'enrollments_report.csv', headers, data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/export/payments ─────────────────────────────────────────────────
router.get('/payments', requireInstructorOrAdmin, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const filter = isAdmin ? '' : 'AND c.instructor_id = ?';
    const params = isAdmin ? [] : [req.user.id];

    const rows = db.prepare(`
      SELECT
        p.id, p.created_at,
        u.first_name || ' ' || u.last_name AS student_name,
        u.email AS student_email,
        up.phone AS student_phone,
        c.title AS course_title,
        p.amount_paise, p.currency, p.status,
        p.razorpay_order_id, p.razorpay_payment_id
      FROM payments p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN user_profile up ON up.user_id = p.user_id
      LEFT JOIN courses c ON p.course_id = c.id
      WHERE 1=1 ${filter}
      ORDER BY p.created_at DESC
    `).all(...params);

    const headers = [
      'Payment ID', 'Date', 'Student Name', 'Email', 'Phone',
      'Course', 'Amount (INR)', 'Currency', 'Status',
      'Razorpay Order ID', 'Razorpay Payment ID'
    ];

    const data = rows.map(r => [
      r.id, fmtDate(r.created_at),
      r.student_name || '', r.student_email || '', r.student_phone || '',
      r.course_title || '', fmtINR(r.amount_paise),
      r.currency || 'INR', r.status || '',
      r.razorpay_order_id || '', r.razorpay_payment_id || ''
    ]);

    sendCSV(res, 'payments_report.csv', headers, data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
