module.exports = [
  `CREATE TABLE IF NOT EXISTS practice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    piece TEXT,
    composer TEXT,
    course_id INTEGER,
    focus_area TEXT,
    quality_rating INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    event_type TEXT DEFAULT 'personal',
    start_datetime TEXT NOT NULL,
    end_datetime TEXT,
    all_day INTEGER DEFAULT 0,
    color TEXT DEFAULT '#8B2E26',
    related_id INTEGER,
    related_type TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`
];
