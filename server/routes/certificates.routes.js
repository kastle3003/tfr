const express = require('express');
const router = express.Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');

let uuidv4;
try {
  const { v4 } = require('uuid');
  uuidv4 = v4;
} catch (e) {
  uuidv4 = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const CERT_DIR = path.join(__dirname, '../../data/certificates');
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

function generateCertificateSVG(studentName, courseName, instructorName, date, certNumber) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650" viewBox="0 0 900 650">
  <rect width="900" height="650" fill="#F4EBD0"/>
  <rect x="20" y="20" width="860" height="610" fill="none" stroke="#8B2E26" stroke-width="3"/>
  <rect x="28" y="28" width="844" height="594" fill="none" stroke="#D1A14E" stroke-width="1"/>
  <!-- Corner ornaments -->
  <circle cx="45" cy="45" r="8" fill="#8B2E26"/>
  <circle cx="855" cy="45" r="8" fill="#8B2E26"/>
  <circle cx="45" cy="605" r="8" fill="#8B2E26"/>
  <circle cx="855" cy="605" r="8" fill="#8B2E26"/>
  <!-- Header -->
  <text x="450" y="90" font-family="Georgia,serif" font-size="14" fill="#2D4F1E" text-anchor="middle" letter-spacing="4">THE ARCHIVE MUSIC SCHOOL</text>
  <text x="450" y="115" font-family="Georgia,serif" font-size="10" fill="#8A7260" text-anchor="middle" letter-spacing="2">EST. 1952 · LONDON / NEW YORK</text>
  <line x1="150" y1="128" x2="750" y2="128" stroke="#D1A14E" stroke-width="1"/>
  <!-- Title -->
  <text x="450" y="185" font-family="Georgia,serif" font-style="italic" font-size="42" fill="#8B2E26" text-anchor="middle">Certificate of Completion</text>
  <!-- Body -->
  <text x="450" y="250" font-family="Georgia,serif" font-size="16" fill="#4E3C2E" text-anchor="middle">This is to certify that</text>
  <text x="450" y="305" font-family="Georgia,serif" font-style="italic" font-size="36" fill="#1C1410" text-anchor="middle">${studentName}</text>
  <line x1="250" y1="318" x2="650" y2="318" stroke="#8B2E26" stroke-width="1"/>
  <text x="450" y="355" font-family="Georgia,serif" font-size="16" fill="#4E3C2E" text-anchor="middle">has successfully completed the course</text>
  <text x="450" y="400" font-family="Georgia,serif" font-style="italic" font-size="26" fill="#2D4F1E" text-anchor="middle">${courseName}</text>
  <!-- Footer -->
  <line x1="150" y1="490" x2="750" y2="490" stroke="#D1A14E" stroke-width="1"/>
  <text x="300" y="520" font-family="Georgia,serif" font-size="13" fill="#4E3C2E" text-anchor="middle">${instructorName}</text>
  <text x="300" y="540" font-family="Georgia,serif" font-size="10" fill="#8A7260" text-anchor="middle">Instructor</text>
  <text x="600" y="520" font-family="Georgia,serif" font-size="13" fill="#4E3C2E" text-anchor="middle">${date}</text>
  <text x="600" y="540" font-family="Georgia,serif" font-size="10" fill="#8A7260" text-anchor="middle">Date of Completion</text>
  <text x="450" y="590" font-family="Georgia,serif" font-size="9" fill="#8A7260" text-anchor="middle">Certificate No: ${certNumber}</text>
</svg>`;
}

// GET /api/certificates/me
router.get('/me', (req, res) => {
  try {
    const certs = db.prepare(`
      SELECT cert.*, c.title AS course_title, c.instructor_id,
        u.first_name || ' ' || u.last_name AS instructor_name
      FROM certificates cert
      LEFT JOIN courses c ON cert.course_id = c.id
      LEFT JOIN users u ON c.instructor_id = u.id
      WHERE cert.student_id = ?
      ORDER BY cert.issued_at DESC
    `).all(req.user.id);
    res.json({ certificates: certs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/certificates/:id/download
router.get('/:id/download', (req, res) => {
  try {
    const cert = db.prepare('SELECT * FROM certificates WHERE id = ? AND student_id = ?').get(req.params.id, req.user.id);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });

    if (cert.pdf_path && fs.existsSync(cert.pdf_path)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Disposition', `attachment; filename="certificate-${cert.certificate_number}.svg"`);
      return res.sendFile(cert.pdf_path);
    }

    // Regenerate on-the-fly
    const student = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(cert.student_id);
    const course = db.prepare(`
      SELECT c.title, u.first_name || ' ' || u.last_name AS instructor_name
      FROM courses c LEFT JOIN users u ON c.instructor_id = u.id WHERE c.id = ?
    `).get(cert.course_id);

    if (!student || !course) return res.status(404).json({ error: 'Certificate data incomplete' });

    const svg = generateCertificateSVG(
      student.first_name + ' ' + student.last_name,
      course.title,
      course.instructor_name || 'The Archive',
      new Date(cert.issued_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      cert.certificate_number
    );

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${cert.certificate_number}.svg"`);
    res.send(svg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/certificates/generate/:course_id
router.post('/generate/:course_id', (req, res) => {
  try {
    const courseId = parseInt(req.params.course_id);

    // Check enrollment and progress
    const enrollment = db.prepare(`
      SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?
    `).get(req.user.id, courseId);
    if (!enrollment) return res.status(400).json({ error: 'Not enrolled in this course' });

    if ((enrollment.progress_pct || 0) < 100) {
      return res.status(400).json({ error: 'Course not yet completed. Progress: ' + (enrollment.progress_pct || 0) + '%' });
    }

    // Check if certificate already exists
    const existing = db.prepare('SELECT * FROM certificates WHERE student_id = ? AND course_id = ?').get(req.user.id, courseId);
    if (existing) return res.json({ certificate: existing, already_exists: true });

    const student = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.user.id);
    const course = db.prepare(`
      SELECT c.title, u.first_name || ' ' || u.last_name AS instructor_name
      FROM courses c LEFT JOIN users u ON c.instructor_id = u.id WHERE c.id = ?
    `).get(courseId);

    if (!student || !course) return res.status(404).json({ error: 'Student or course not found' });

    const certNumber = 'ARCH-' + Date.now().toString(36).toUpperCase() + '-' + (uuidv4().slice(0, 6).toUpperCase());
    const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const svg = generateCertificateSVG(
      student.first_name + ' ' + student.last_name,
      course.title,
      course.instructor_name || 'The Archive',
      dateStr,
      certNumber
    );

    const filePath = path.join(CERT_DIR, `${certNumber}.svg`);
    fs.writeFileSync(filePath, svg, 'utf8');

    const result = db.prepare(`
      INSERT INTO certificates (student_id, course_id, certificate_number, pdf_path, issued_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(req.user.id, courseId, certNumber, filePath);

    const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(result.lastInsertRowid);
    res.json({ certificate: cert, svg_preview: svg });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      const cert = db.prepare('SELECT * FROM certificates WHERE student_id = ? AND course_id = ?').get(req.user.id, req.params.course_id);
      return res.json({ certificate: cert, already_exists: true });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
