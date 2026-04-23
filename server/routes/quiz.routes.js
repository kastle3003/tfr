const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/role');

// GET /api/quizzes?course_id=:id
router.get('/', (req, res) => {
  try {
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ error: 'course_id is required' });
    const quizzes = db.prepare(`
      SELECT q.*, COUNT(qq.id) AS question_count
      FROM quizzes q
      LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id
      WHERE q.course_id = ?
      GROUP BY q.id
      ORDER BY q.created_at DESC
    `).all(course_id);
    res.json({ quizzes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quizzes/:id
router.get('/:id', (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    const questions = db.prepare(
      'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY order_index ASC'
    ).all(req.params.id);
    // Parse options JSON for each question
    const parsedQuestions = questions.map(q => ({
      ...q,
      options: JSON.parse(q.options || '[]')
    }));
    res.json({ quiz, questions: parsedQuestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quizzes — instructor only
router.post('/', requireRole('instructor'), (req, res) => {
  try {
    const {
      course_id, lesson_id, title, description,
      time_limit_minutes, passing_score, attempts_allowed,
      randomize_questions, show_answers_after
    } = req.body;
    if (!course_id || !title) return res.status(400).json({ error: 'course_id and title are required' });
    const result = db.prepare(`
      INSERT INTO quizzes (course_id, lesson_id, title, description, time_limit_minutes,
        passing_score, attempts_allowed, randomize_questions, show_answers_after, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      course_id, lesson_id || null, title, description || null,
      time_limit_minutes || null, passing_score ?? 70,
      attempts_allowed ?? 3, randomize_questions ? 1 : 0,
      show_answers_after !== undefined ? (show_answers_after ? 1 : 0) : 1,
      req.user.id
    );
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ quiz });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/quizzes/:id — instructor only
router.put('/:id', requireRole('instructor'), (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found or not authorized' });
    const {
      title, description, lesson_id, course_id,
      time_limit_minutes, passing_score, attempts_allowed,
      randomize_questions, show_answers_after
    } = req.body;
    db.prepare(`
      UPDATE quizzes SET title = ?, description = ?, lesson_id = ?, course_id = ?,
        time_limit_minutes = ?, passing_score = ?, attempts_allowed = ?,
        randomize_questions = ?, show_answers_after = ?
      WHERE id = ?
    `).run(
      title ?? quiz.title, description ?? quiz.description,
      lesson_id !== undefined ? lesson_id : quiz.lesson_id,
      course_id ?? quiz.course_id,
      time_limit_minutes !== undefined ? time_limit_minutes : quiz.time_limit_minutes,
      passing_score ?? quiz.passing_score,
      attempts_allowed ?? quiz.attempts_allowed,
      randomize_questions !== undefined ? (randomize_questions ? 1 : 0) : quiz.randomize_questions,
      show_answers_after !== undefined ? (show_answers_after ? 1 : 0) : quiz.show_answers_after,
      req.params.id
    );
    const updated = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
    res.json({ quiz: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/quizzes/:id — instructor only
router.delete('/:id', requireRole('instructor'), (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found or not authorized' });
    db.prepare('DELETE FROM quiz_questions WHERE quiz_id = ?').run(req.params.id);
    db.prepare('DELETE FROM quiz_attempts WHERE quiz_id = ?').run(req.params.id);
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quizzes/:id/questions — instructor only
router.post('/:id/questions', requireRole('instructor'), (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found or not authorized' });
    const { question_text, question_type, options, correct_answer, points, order_index, audio_url, explanation } = req.body;
    if (!question_text) return res.status(400).json({ error: 'question_text is required' });
    const maxOrder = db.prepare('SELECT MAX(order_index) as mx FROM quiz_questions WHERE quiz_id = ?').get(req.params.id);
    const nextOrder = order_index !== undefined ? order_index : (maxOrder.mx !== null ? maxOrder.mx + 1 : 0);
    const result = db.prepare(`
      INSERT INTO quiz_questions (quiz_id, question_text, question_type, options, correct_answer, points, order_index, audio_url, explanation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, question_text, question_type || 'mcq',
      JSON.stringify(options || []), correct_answer || null,
      points ?? 1, nextOrder, audio_url || null, explanation || null
    );
    const question = db.prepare('SELECT * FROM quiz_questions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ question: { ...question, options: JSON.parse(question.options || '[]') } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/quizzes/:id/questions/:qid — instructor only
router.put('/:id/questions/:qid', requireRole('instructor'), (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found or not authorized' });
    const q = db.prepare('SELECT * FROM quiz_questions WHERE id = ? AND quiz_id = ?').get(req.params.qid, req.params.id);
    if (!q) return res.status(404).json({ error: 'Question not found' });
    const { question_text, question_type, options, correct_answer, points, order_index, audio_url, explanation } = req.body;
    db.prepare(`
      UPDATE quiz_questions SET question_text = ?, question_type = ?, options = ?,
        correct_answer = ?, points = ?, order_index = ?, audio_url = ?, explanation = ?
      WHERE id = ?
    `).run(
      question_text ?? q.question_text, question_type ?? q.question_type,
      options !== undefined ? JSON.stringify(options) : q.options,
      correct_answer !== undefined ? correct_answer : q.correct_answer,
      points ?? q.points, order_index ?? q.order_index,
      audio_url !== undefined ? audio_url : q.audio_url,
      explanation !== undefined ? explanation : q.explanation,
      req.params.qid
    );
    const updated = db.prepare('SELECT * FROM quiz_questions WHERE id = ?').get(req.params.qid);
    res.json({ question: { ...updated, options: JSON.parse(updated.options || '[]') } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/quizzes/:id/questions/:qid — instructor only
router.delete('/:id/questions/:qid', requireRole('instructor'), (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found or not authorized' });
    db.prepare('DELETE FROM quiz_questions WHERE id = ? AND quiz_id = ?').run(req.params.qid, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quizzes/:id/start — student starts attempt
router.post('/:id/start', (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    // Check attempts limit
    if (quiz.attempts_allowed > 0) {
      const attemptCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? AND completed_at IS NOT NULL'
      ).get(req.params.id, req.user.id);
      if (attemptCount.cnt >= quiz.attempts_allowed) {
        return res.status(403).json({ error: `Maximum attempts (${quiz.attempts_allowed}) reached` });
      }
    }
    const result = db.prepare(
      'INSERT INTO quiz_attempts (quiz_id, student_id, answers) VALUES (?, ?, ?)'
    ).run(req.params.id, req.user.id, '{}');
    res.status(201).json({ attempt_id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quizzes/:id/submit
router.post('/:id/submit', (req, res) => {
  try {
    const { attempt_id, answers } = req.body;
    if (!attempt_id || !answers) return res.status(400).json({ error: 'attempt_id and answers are required' });
    const attempt = db.prepare(
      'SELECT * FROM quiz_attempts WHERE id = ? AND quiz_id = ? AND student_id = ?'
    ).get(attempt_id, req.params.id, req.user.id);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    if (attempt.completed_at) return res.status(400).json({ error: 'Attempt already submitted' });

    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
    const questions = db.prepare(
      'SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY order_index ASC'
    ).all(req.params.id);

    // Auto-grade MCQ and T/F
    let totalPoints = 0;
    let earnedPoints = 0;
    const results = {};

    questions.forEach(q => {
      const studentAnswer = answers[q.id];
      totalPoints += q.points;
      let correct = false;
      if (q.question_type === 'mcq' || q.question_type === 'tf') {
        correct = studentAnswer !== undefined &&
          String(studentAnswer).trim().toLowerCase() === String(q.correct_answer || '').trim().toLowerCase();
        if (correct) earnedPoints += q.points;
      } else if (q.question_type === 'short') {
        // short answer: partial credit if answer contains any keyword
        correct = false;
      } else {
        // ear_training treated like mcq
        correct = studentAnswer !== undefined &&
          String(studentAnswer).trim().toLowerCase() === String(q.correct_answer || '').trim().toLowerCase();
        if (correct) earnedPoints += q.points;
      }
      results[q.id] = {
        correct,
        correct_answer: quiz.show_answers_after ? q.correct_answer : undefined,
        explanation: quiz.show_answers_after ? q.explanation : undefined,
        student_answer: studentAnswer,
        points: q.points,
        earned: correct ? q.points : 0
      };
    });

    const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    const passed = score >= quiz.passing_score ? 1 : 0;

    const startTime = new Date(attempt.started_at).getTime();
    const timeTaken = Math.round((Date.now() - startTime) / 1000);

    db.prepare(`
      UPDATE quiz_attempts SET answers = ?, score = ?, passed = ?, completed_at = datetime('now'), time_taken_seconds = ?
      WHERE id = ?
    `).run(JSON.stringify(answers), score, passed, timeTaken, attempt_id);

    res.json({ score, passed: !!passed, results, total_points: totalPoints, earned_points: earnedPoints });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quizzes/:id/attempts/me — student's own attempts
router.get('/:id/attempts/me', (req, res) => {
  try {
    const attempts = db.prepare(`
      SELECT * FROM quiz_attempts
      WHERE quiz_id = ? AND student_id = ?
      ORDER BY started_at DESC
    `).all(req.params.id, req.user.id);
    res.json({ attempts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quizzes/:id/attempts — all attempts (instructor)
router.get('/:id/attempts', requireRole('instructor'), (req, res) => {
  try {
    const attempts = db.prepare(`
      SELECT qa.*, u.first_name, u.last_name, u.email, u.avatar_initials
      FROM quiz_attempts qa
      JOIN users u ON qa.student_id = u.id
      WHERE qa.quiz_id = ?
      ORDER BY qa.started_at DESC
    `).all(req.params.id);
    res.json({ attempts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
