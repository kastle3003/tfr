const express = require('express');
const router = express.Router();
const db = require('../db');
const requireRole = require('../middleware/role');

// Helper: compute streak from practice_sessions for a student
function computeStreak(studentId) {
  const rows = db.prepare(`
    SELECT DISTINCT date FROM practice_sessions
    WHERE student_id = ?
    ORDER BY date DESC
  `).all(studentId);

  if (!rows.length) return { current: 0, longest: 0 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const dates = rows.map(r => {
    const d = new Date(r.date);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  });

  // current streak
  let current = 0;
  let check = today.getTime();
  // allow starting from today or yesterday
  if (!dates.includes(check)) {
    check = yesterday.getTime();
    if (!dates.includes(check)) {
      current = 0;
      check = null;
    }
  }
  if (check !== null) {
    while (dates.includes(check)) {
      current++;
      check -= 86400000;
    }
  }

  // longest streak
  const allDates = [...new Set(dates)].sort((a, b) => a - b);
  let longest = 0;
  let run = 1;
  for (let i = 1; i < allDates.length; i++) {
    if (allDates[i] - allDates[i - 1] === 86400000) {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }
  if (allDates.length === 1) longest = 1;
  else longest = Math.max(longest, run);
  current = Math.max(current, 0);
  longest = Math.max(longest, current);

  return { current, longest };
}

// GET /api/analytics/student
router.get('/student', (req, res) => {
  try {
    const studentId = req.user.id;

    // Weekly practice last 12 weeks
    const weeklyPractice = db.prepare(`
      SELECT
        strftime('%Y-W%W', date) AS week,
        SUM(duration_minutes) AS minutes
      FROM practice_sessions
      WHERE student_id = ?
        AND date >= date('now', '-84 days')
      GROUP BY strftime('%Y-W%W', date)
      ORDER BY week ASC
    `).all(studentId);

    // Grade trend last 6 months
    const gradeTrend = db.prepare(`
      SELECT
        strftime('%Y-%m', s.submitted_at) AS month,
        AVG(CAST(s.grade AS REAL)) AS avg_score
      FROM submissions s
      WHERE s.student_id = ?
        AND s.status = 'graded'
        AND s.grade IS NOT NULL
        AND s.submitted_at >= date('now', '-6 months')
      GROUP BY strftime('%Y-%m', s.submitted_at)
      ORDER BY month ASC
    `).all(studentId);

    // Course progress
    const courseProgress = db.prepare(`
      SELECT
        e.course_id,
        c.title,
        e.progress_pct,
        (SELECT COUNT(*) FROM lesson_progress lp WHERE lp.student_id = ? AND lp.completed = 1
          AND lp.lesson_id IN (SELECT id FROM lessons WHERE course_id = e.course_id)) AS lessons_done,
        c.lesson_count AS total_lessons
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      WHERE e.student_id = ?
    `).all(studentId, studentId);

    // Completion rate
    const totalCourses = courseProgress.length;
    const completedCourses = courseProgress.filter(c => c.progress_pct >= 100).length;
    const completionRate = totalCourses > 0 ? Math.round((completedCourses / totalCourses) * 100) : 0;

    // Total practice minutes
    const practiceTotal = db.prepare(`
      SELECT COALESCE(SUM(duration_minutes), 0) AS total FROM practice_sessions WHERE student_id = ?
    `).get(studentId);

    // Streak
    const { current: currentStreak, longest: longestStreak } = computeStreak(studentId);

    // Assignments
    const assignCounts = db.prepare(`
      SELECT
        COUNT(CASE WHEN s.status = 'graded' THEN 1 END) AS completed,
        COUNT(CASE WHEN s.status = 'pending' THEN 1 END) AS pending
      FROM submissions s
      WHERE s.student_id = ?
    `).get(studentId);

    res.json({
      weekly_practice: weeklyPractice,
      grade_trend: gradeTrend,
      course_progress: courseProgress,
      completion_rate: completionRate,
      total_practice_minutes: practiceTotal.total,
      current_streak_days: currentStreak,
      longest_streak_days: longestStreak,
      assignments_completed: assignCounts.completed || 0,
      assignments_pending: assignCounts.pending || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/instructor
router.get('/instructor', requireRole('instructor'), (req, res) => {
  try {
    const instructorId = req.user.id;

    // Total students and courses
    const totals = db.prepare(`
      SELECT
        COUNT(DISTINCT e.student_id) AS total_students,
        COUNT(DISTINCT c.id) AS total_courses
      FROM courses c
      LEFT JOIN enrollments e ON e.course_id = c.id
      WHERE c.instructor_id = ?
    `).get(instructorId);

    // Avg completion rate and avg score
    const avgStats = db.prepare(`
      SELECT
        AVG(e.progress_pct) AS avg_completion_rate,
        AVG(CAST(s.grade AS REAL)) AS avg_score_all
      FROM courses c
      JOIN enrollments e ON e.course_id = c.id
      LEFT JOIN submissions s ON s.course_id = c.id AND s.student_id = e.student_id AND s.status = 'graded'
      WHERE c.instructor_id = ?
    `).get(instructorId);

    // Enrollments by month last 6 months
    const enrollmentsByMonth = db.prepare(`
      SELECT
        strftime('%Y-%m', e.enrolled_at) AS month,
        COUNT(*) AS count
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      WHERE c.instructor_id = ?
        AND e.enrolled_at >= date('now', '-6 months')
      GROUP BY strftime('%Y-%m', e.enrolled_at)
      ORDER BY month ASC
    `).all(instructorId);

    // Top courses
    const topCourses = db.prepare(`
      SELECT
        c.title,
        COUNT(DISTINCT e.student_id) AS enrolled,
        AVG(CAST(s.grade AS REAL)) AS avg_score,
        AVG(e.progress_pct) AS completion_rate
      FROM courses c
      LEFT JOIN enrollments e ON e.course_id = c.id
      LEFT JOIN submissions s ON s.course_id = c.id AND s.status = 'graded'
      WHERE c.instructor_id = ?
      GROUP BY c.id
      ORDER BY enrolled DESC
    `).all(instructorId);

    // Student activity
    const studentActivity = db.prepare(`
      SELECT
        u.id AS student_id,
        u.first_name || ' ' || u.last_name AS name,
        u.avatar_initials,
        MAX(e.last_accessed_at) AS last_active,
        COUNT(DISTINCT e.course_id) AS courses_enrolled,
        AVG(CAST(s.grade AS REAL)) AS avg_grade
      FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      JOIN users u ON e.student_id = u.id
      LEFT JOIN submissions s ON s.student_id = u.id AND s.status = 'graded'
      WHERE c.instructor_id = ?
      GROUP BY u.id
      ORDER BY last_active DESC
    `).all(instructorId);

    // Submissions by week last 8 weeks
    const submissionsByWeek = db.prepare(`
      SELECT
        strftime('%Y-W%W', s.submitted_at) AS week,
        COUNT(*) AS count
      FROM submissions s
      JOIN courses c ON s.course_id = c.id
      WHERE c.instructor_id = ?
        AND s.submitted_at >= date('now', '-56 days')
      GROUP BY strftime('%Y-W%W', s.submitted_at)
      ORDER BY week ASC
    `).all(instructorId);

    res.json({
      total_students: totals.total_students || 0,
      total_courses: totals.total_courses || 0,
      avg_completion_rate: Math.round(avgStats.avg_completion_rate || 0),
      avg_score_all: Math.round(avgStats.avg_score_all || 0),
      enrollments_by_month: enrollmentsByMonth,
      top_courses: topCourses,
      student_activity: studentActivity,
      submissions_by_week: submissionsByWeek
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/course/:id
router.get('/course/:id', requireRole('instructor'), (req, res) => {
  try {
    const courseId = req.params.id;
    const instructorId = req.user.id;

    // Verify ownership
    const course = db.prepare('SELECT id FROM courses WHERE id = ? AND instructor_id = ?').get(courseId, instructorId);
    if (!course) return res.status(403).json({ error: 'Not authorized or course not found' });

    // Enrolled count
    const enrolledCount = db.prepare('SELECT COUNT(*) AS cnt FROM enrollments WHERE course_id = ?').get(courseId);

    // Avg progress and avg score
    const stats = db.prepare(`
      SELECT
        AVG(e.progress_pct) AS avg_progress,
        AVG(CAST(s.grade AS REAL)) AS avg_score
      FROM enrollments e
      LEFT JOIN submissions s ON s.course_id = e.course_id AND s.student_id = e.student_id AND s.status = 'graded'
      WHERE e.course_id = ?
    `).get(courseId);

    // Lesson completion rates
    const lessonRates = db.prepare(`
      SELECT
        l.id AS lesson_id,
        l.title,
        COUNT(lp.id) AS completed_count,
        ? AS total_enrolled
      FROM lessons l
      LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.completed = 1
      WHERE l.course_id = ?
      GROUP BY l.id
      ORDER BY l.order_index ASC
    `).all(enrolledCount.cnt, courseId);

    // Drop-off lesson: the lesson with the lowest completion rate that's not zero enrolled
    const dropOffLesson = lessonRates.length > 0
      ? lessonRates.reduce((min, l) => {
          const rate = enrolledCount.cnt > 0 ? l.completed_count / enrolledCount.cnt : 0;
          const minRate = enrolledCount.cnt > 0 ? min.completed_count / enrolledCount.cnt : 0;
          return rate < minRate ? l : min;
        })
      : null;

    res.json({
      enrolled_count: enrolledCount.cnt,
      avg_progress: Math.round(stats.avg_progress || 0),
      avg_score: Math.round(stats.avg_score || 0),
      lesson_completion_rates: lessonRates,
      drop_off_lesson: dropOffLesson ? { id: dropOffLesson.lesson_id, title: dropOffLesson.title } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
