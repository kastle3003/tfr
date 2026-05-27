const router = require('express').Router();
const db = require('../db');

// GET /api/assignments?course_id=X
router.get('/', (req, res) => {
  try {
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ error: 'course_id is required' });
    const assignments = db.prepare('SELECT * FROM assignments WHERE course_id = ? ORDER BY created_at').all(course_id);
    res.json({ assignments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assignments
router.post('/', (req, res) => {
  try {
    const {
      course_id, title, description, instructions, submission_type,
      allowed_file_types, max_file_size_mb, max_score, due_type,
      due_days, due_date, is_required, visible
    } = req.body;
    if (!course_id || !title) return res.status(400).json({ error: 'course_id and title are required' });
    const result = db.prepare(`
      INSERT INTO assignments (course_id, title, description, instructions, submission_type, allowed_file_types,
        max_file_size_mb, max_score, due_type, due_days, due_date, is_required, visible)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      course_id, title, description || '', instructions || '',
      submission_type || 'file',
      JSON.stringify(allowed_file_types || []),
      max_file_size_mb || 10, max_score || 100,
      due_type || 'relative', due_days || null, due_date || null,
      is_required ? 1 : 0, visible !== false ? 1 : 0
    );
    const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(result.lastInsertRowid);
    res.json(assignment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/assignments/:id
router.put('/:id', (req, res) => {
  try {
    const {
      title, description, instructions, submission_type,
      allowed_file_types, max_file_size_mb, max_score, due_type,
      due_days, due_date, is_required, visible
    } = req.body;
    db.prepare(`
      UPDATE assignments SET title = ?, description = ?, instructions = ?, submission_type = ?,
        allowed_file_types = ?, max_file_size_mb = ?, max_score = ?, due_type = ?,
        due_days = ?, due_date = ?, is_required = ?, visible = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      title, description || '', instructions || '', submission_type || 'file',
      JSON.stringify(allowed_file_types || []),
      max_file_size_mb || 10, max_score || 100,
      due_type || 'relative', due_days || null, due_date || null,
      is_required ? 1 : 0, visible !== false ? 1 : 0,
      req.params.id
    );
    res.json({ message: 'Assignment updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/assignments/:id
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
    res.json({ message: 'Assignment deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
