module.exports = [
  `CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    question_type TEXT DEFAULT 'mcq',
    options TEXT DEFAULT '[]',
    correct_answer TEXT,
    points INTEGER DEFAULT 1,
    order_index INTEGER DEFAULT 0,
    audio_url TEXT,
    explanation TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id INTEGER,
    course_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    time_limit_minutes INTEGER,
    passing_score INTEGER DEFAULT 70,
    attempts_allowed INTEGER DEFAULT 3,
    randomize_questions INTEGER DEFAULT 0,
    show_answers_after INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    answers TEXT DEFAULT '{}',
    score INTEGER,
    passed INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    time_taken_seconds INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS message_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER,
    created_by INTEGER NOT NULL,
    subject TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS thread_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    UNIQUE(thread_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    attachment_path TEXT,
    read_by TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    avatar_url TEXT,
    bio TEXT,
    practice_goal_minutes INTEGER DEFAULT 60,
    phone TEXT,
    location TEXT,
    social_links TEXT DEFAULT '{}',
    notification_prefs TEXT DEFAULT '{"email":true,"inapp":true,"graded":true,"messages":true,"masterclass":true}',
    updated_at TEXT DEFAULT (datetime('now'))
  )`
];
