// Thin wrapper around googleapis for instructor-side Calendar/Meet integration.
// Tokens are stored in instructor_google_tokens (one row per instructor).

const crypto = require('crypto');
const { google } = require('googleapis');
const db = require('../db');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function envOr(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function makeOAuthClient() {
  return new google.auth.OAuth2(
    envOr('GOOGLE_OAUTH_CLIENT_ID'),
    envOr('GOOGLE_OAUTH_CLIENT_SECRET'),
    envOr('GOOGLE_OAUTH_REDIRECT_URI')
  );
}

// Build the consent URL. `state` is a JWT-like opaque blob the caller chose to
// round-trip through Google; we don't interpret it here.
function getAuthUrl(state) {
  const oauth2 = makeOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',     // need refresh_token
    prompt: 'consent',          // force refresh_token even if already granted
    scope: SCOPES,
    state: state || '',
  });
}

// Exchange the auth code for tokens; persist them under userId.
async function exchangeCodeAndStore(userId, code) {
  const oauth2 = makeOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    // First connect must include offline scope; if a previous consent already
    // existed, Google won't re-issue refresh_token without prompt=consent.
    throw new Error('No refresh_token returned from Google. Disconnect and reconnect with prompt=consent.');
  }
  const expiresAt = Math.floor((tokens.expiry_date || (Date.now() + 3600 * 1000)) / 1000);
  db.prepare(`
    INSERT INTO instructor_google_tokens (user_id, access_token, refresh_token, expires_at, calendar_id, connected_at, updated_at)
    VALUES (?, ?, ?, ?, 'primary', datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run(userId, tokens.access_token, tokens.refresh_token, expiresAt);
  return { ok: true };
}

// Build an authed OAuth2 client for an instructor, refreshing if needed.
async function getAuthedClientForUser(userId) {
  const row = db.prepare('SELECT * FROM instructor_google_tokens WHERE user_id = ?').get(userId);
  if (!row) return null;

  const oauth2 = makeOAuthClient();
  oauth2.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expires_at * 1000,
  });

  // googleapis auto-refreshes when calls are made if expiry_date is in the past
  // and refresh_token is set. Persist updated tokens via the listener.
  oauth2.on('tokens', (tokens) => {
    try {
      const newExpiry = tokens.expiry_date
        ? Math.floor(tokens.expiry_date / 1000)
        : Math.floor(Date.now() / 1000) + 3300;
      db.prepare(`
        UPDATE instructor_google_tokens
           SET access_token = COALESCE(?, access_token),
               refresh_token = COALESCE(?, refresh_token),
               expires_at = ?,
               updated_at = datetime('now')
         WHERE user_id = ?
      `).run(tokens.access_token || null, tokens.refresh_token || null, newExpiry, userId);
    } catch (e) {
      console.error('[google-calendar] token refresh persist failed:', e.message);
    }
  });

  return oauth2;
}

function isConnected(userId) {
  return !!db.prepare('SELECT user_id FROM instructor_google_tokens WHERE user_id = ?').get(userId);
}

function disconnect(userId) {
  db.prepare('DELETE FROM instructor_google_tokens WHERE user_id = ?').run(userId);
}

// Create a Google Calendar event with a Meet link attached. Attendees is an
// optional array of emails. Returns { eventId, meetUrl, htmlLink }.
async function createMeetEvent(userId, { title, description, startISO, durationMinutes, attendees }) {
  const oauth2 = await getAuthedClientForUser(userId);
  if (!oauth2) throw new Error('Instructor has not connected Google Calendar');
  const cal = google.calendar({ version: 'v3', auth: oauth2 });

  const start = new Date(startISO);
  const end = new Date(start.getTime() + (parseInt(durationMinutes, 10) || 60) * 60 * 1000);

  const requestId = crypto.randomUUID();
  const res = await cal.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: title,
      description: description || '',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: (attendees || []).filter(Boolean).map(e => ({ email: e })),
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });

  const ev = res.data;
  const meetUrl = ev.hangoutLink || (ev.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video')?.uri;
  return { eventId: ev.id, meetUrl, htmlLink: ev.htmlLink };
}

module.exports = {
  getAuthUrl,
  exchangeCodeAndStore,
  isConnected,
  disconnect,
  createMeetEvent,
};
