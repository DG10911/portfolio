#!/usr/bin/env node
/**
 * ============================================================
 *  VANIKA NET — Backend Server
 * ============================================================
 *  Pure Node.js (no npm install needed, no dependencies).
 *  Requires Node.js 18 or newer (for built-in fetch).
 *
 *  Run:  node server.js
 *  Then: open http://localhost:3000
 * ============================================================
 */

import { createServer } from 'node:http';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ─────────────────────────────────────────────────────
//  AUTH — users + sessions + login + audit
// ─────────────────────────────────────────────────────
const USERS_PATH = join(__dirname, 'data', 'users.json');
const SESSIONS_PATH = join(__dirname, 'data', 'sessions.json');
const INBOX_V2_PATH = join(__dirname, 'data', 'inbox.json');

let USERS = [];
let SESSIONS = {};
let INBOX = [];

async function loadAuthData(){
  try { USERS = JSON.parse(await readFile(USERS_PATH, 'utf8')); } catch { USERS = []; }
  try { SESSIONS = JSON.parse(await readFile(SESSIONS_PATH, 'utf8')); } catch { SESSIONS = {}; }
  try { INBOX = JSON.parse(await readFile(INBOX_V2_PATH, 'utf8')); } catch { INBOX = []; }
  console.log(`[auth] loaded ${USERS.length} users, ${Object.keys(SESSIONS).length} sessions, ${INBOX.length} inbox items`);
}
async function saveSessions(){ try { await writeFile(SESSIONS_PATH, JSON.stringify(SESSIONS, null, 2)); } catch {} }
async function saveInbox(){ try { await writeFile(INBOX_V2_PATH, JSON.stringify(INBOX, null, 2)); } catch {} }
async function saveUsers(){ try { await writeFile(USERS_PATH, JSON.stringify(USERS, null, 2)); } catch {} }

function sha256(text){ return createHash('sha256').update(text).digest('hex'); }
function newToken(){ return randomBytes(32).toString('hex'); }
function passwordCheck(user, password){ return sha256(user.salt + ':' + password) === user.passwordHash; }

function getCookieToken(req){
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/sarna_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}
function getCurrentUser(req){
  const token = getCookieToken(req);
  if (!token || !SESSIONS[token]) return null;
  const s = SESSIONS[token];
  // Expire after 8 hours
  if (Date.now() - s.lastSeen > 8 * 3600 * 1000) {
    delete SESSIONS[token];
    saveSessions();
    return null;
  }
  s.lastSeen = Date.now();
  return USERS.find(u => u.id === s.userId) || null;
}
function setCookie(res, token){
  res.setHeader('Set-Cookie', `sarna_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8*3600}`);
}
function clearCookie(res){
  res.setHeader('Set-Cookie', `sarna_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

async function api_auth_login(req, res){
  const body = await bodyJson(req);
  const username = String(body.username || '').toUpperCase().trim();
  const password = String(body.password || '');
  const user = USERS.find(u => u.username === username);
  if (!user) return json(res, { error: 'Invalid username or password' }, 401);

  // Lockout check
  if (user.lockedUntil && Date.now() < user.lockedUntil) {
    const minsLeft = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    return json(res, { error: `Account locked. Try again in ${minsLeft} minutes.` }, 429);
  }

  if (!passwordCheck(user, password)) {
    user.failedAttempts = (user.failedAttempts || 0) + 1;
    if (user.failedAttempts >= 5) {
      user.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 min lockout
      user.failedAttempts = 0;
      await saveUsers();
      return json(res, { error: 'Too many failed attempts. Locked for 15 minutes.' }, 429);
    }
    await saveUsers();
    return json(res, { error: 'Invalid username or password', attemptsLeft: 5 - user.failedAttempts }, 401);
  }

  // Success
  user.failedAttempts = 0;
  user.lockedUntil = null;
  user.lastLogin = new Date().toISOString();
  await saveUsers();

  const token = newToken();
  SESSIONS[token] = { userId: user.id, createdAt: Date.now(), lastSeen: Date.now(), ip: req.socket.remoteAddress };
  await saveSessions();

  setCookie(res, token);
  // Strip sensitive fields before returning
  const { passwordHash, salt, failedAttempts, lockedUntil, ...safeUser } = user;
  return json(res, { ok: true, user: safeUser });
}

async function api_auth_logout(req, res){
  const token = getCookieToken(req);
  if (token) {
    delete SESSIONS[token];
    await saveSessions();
  }
  clearCookie(res);
  return json(res, { ok: true });
}

async function api_auth_me(req, res){
  const user = getCurrentUser(req);
  if (!user) return json(res, { error: 'not authenticated' }, 401);
  const { passwordHash, salt, failedAttempts, lockedUntil, ...safeUser } = user;
  return json(res, { user: safeUser });
}

// Return all usernames + roles + display names — used by login dropdown
function api_auth_demo_accounts(req, res){
  const grouped = { custodian:[], forest:[], scientist:[], policy:[], buyer:[], analyst:[] };
  USERS.forEach(u => {
    if (!grouped[u.role]) return;
    grouped[u.role].push({ username: u.username, name: u.name, title: u.title, groveId: u.groveId, district: u.district, zone: u.zone, company: u.company, institution: u.institution });
  });
  return json(res, { accounts: grouped, totalUsers: USERS.length });
}

// ─────── Per-user inbox (v2) ───────
async function api_inbox_route(req, res){
  const me = getCurrentUser(req);
  if (!me) return json(res, { error:'auth required' }, 401);
  const body = await bodyJson(req);
  // Recipient resolution:
  //   - Specific user_id: route to that user
  //   - role + groveId: route to all users of that role for that grove
  //   - role + district: route to all users of that role in that district
  //   - role only: route to all users of that role (fallback)
  let recipients = [];
  if (body.toUserId) {
    const u = USERS.find(u => u.id === body.toUserId);
    if (u) recipients = [u];
  } else if (body.toRole && body.toGroveId) {
    recipients = USERS.filter(u => u.role === body.toRole && u.groveId === body.toGroveId);
  } else if (body.toRole && body.toDistrict) {
    recipients = USERS.filter(u => u.role === body.toRole && u.district === body.toDistrict);
  } else if (body.toRole) {
    recipients = USERS.filter(u => u.role === body.toRole);
  }
  if (!recipients.length) return json(res, { error: 'no recipients matched' }, 400);

  const entries = recipients.map(r => ({
    id: 'IN-' + Date.now() + '-' + randomBytes(3).toString('hex'),
    fromUserId: me.id, fromUserName: me.name, fromUserRole: me.role,
    toUserId: r.id, toUserName: r.name, toUserRole: r.role,
    type: body.type || 'task',
    title: body.title || '(no title)',
    body: body.body || '',
    siteId: body.siteId || null,
    priority: body.priority || 'normal',
    status: 'open',
    createdAt: new Date().toISOString(),
    completedAt: null, completedBy: null, completionNote: null
  }));
  INBOX.unshift(...entries);
  // Cap to 5000 items
  if (INBOX.length > 5000) INBOX.length = 5000;
  await saveInbox();
  return json(res, { ok: true, routedTo: recipients.length, entries });
}

async function api_inbox_me(req, res){
  const me = getCurrentUser(req);
  if (!me) return json(res, { error:'auth required' }, 401);
  const items = INBOX.filter(i => i.toUserId === me.id);
  return json(res, { items, count: items.length });
}

async function api_inbox_action(req, res){
  const me = getCurrentUser(req);
  if (!me) return json(res, { error:'auth required' }, 401);
  const body = await bodyJson(req);
  const item = INBOX.find(i => i.id === body.id && i.toUserId === me.id);
  if (!item) return json(res, { error:'inbox item not found' }, 404);
  if (body.action === 'complete') {
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    item.completedBy = me.name;
    item.completionNote = body.note || '';
  } else if (body.action === 'reject') {
    item.status = 'rejected';
    item.completedAt = new Date().toISOString();
    item.completedBy = me.name;
    item.completionNote = body.note || '';
  }
  await saveInbox();
  return json(res, { ok: true, item });
}

// Load auth data on boot
await loadAuthData();

// ─────────────────────────────────────────────────────
//  .env loader (no dotenv dependency)
// ─────────────────────────────────────────────────────
const ENV = {};
try {
  const txt = await readFile(join(__dirname, '.env'), 'utf8');
  txt.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    ENV[k] = v;
  });
  console.log('✓ .env loaded:', Object.keys(ENV).filter(k => ENV[k]).length, 'keys configured');
} catch (e) {
  console.warn('⚠ No .env file found.  Copy .env.example → .env and add your keys.');
  console.warn('  App will run in MOCK mode (all features work without keys).');
}

// Cloud platforms (Render / Railway / Fly / Heroku) inject PORT via process.env directly.
// Local dev uses .env file. process.env wins so the cloud deploys work out of the box.
const PORT = parseInt(process.env.PORT || ENV.PORT || '3000', 10);
// On cloud platforms, OpenAI / Sentinel keys come from real env vars too — merge them in
// so the existing ENV.XXX lookups everywhere keep working without any code changes.
for (const k of ['OPENAI_API_KEY','OPENAI_CHAT_MODEL','OPENAI_WHISPER_MODEL',
                 'SENTINEL_HUB_CLIENT_ID','SENTINEL_HUB_CLIENT_SECRET',
                 'NASA_FIRMS_MAP_KEY','DATA_GOV_IN_KEY','IUCN_TOKEN','EBIRD_TOKEN',
                 'ANTHROPIC_API_KEY','ANTHROPIC_MODEL','NODE_ENV']) {
  if (process.env[k] && !ENV[k]) ENV[k] = process.env[k];
}

// ─────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function err(res, status, message) {
  json(res, { error: message }, status);
}

async function bodyJson(req, maxBytes = 25 * 1024 * 1024) {  // 25 MB cap for audio uploads
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────
//  Simple JSON file persistence (for grove edits/registers)
// ─────────────────────────────────────────────────────
const DB_PATH = join(__dirname, 'data', 'overrides.json');
let OVERRIDES = {};
try { OVERRIDES = JSON.parse(await readFile(DB_PATH, 'utf8')); } catch {}
async function saveDB() { await writeFile(DB_PATH, JSON.stringify(OVERRIDES, null, 2)); }

const STATE_PATH = join(__dirname, 'data', 'app-state.json');
const BACKUP_DIR = join(__dirname, 'data', 'backups');
const LOG_PATH = join(__dirname, 'data', 'audit.log');
let STATE_DB = { cart: [], acknowledged: [], activity: [], notifications: [], settings: {}, scanHistory: {}, registeredGroves: [], tickets: [] };
try { STATE_DB = { ...STATE_DB, ...JSON.parse(await readFile(STATE_PATH, 'utf8')) }; } catch {}

async function saveState() {
  await writeFile(STATE_PATH, JSON.stringify(STATE_DB, null, 2));
  // Append to audit log
  try {
    const sz = JSON.stringify(STATE_DB).length;
    await import('node:fs/promises').then(fs => fs.appendFile(LOG_PATH, `${new Date().toISOString()} SAVE size=${sz}B cart=${STATE_DB.cart?.length||0} ack=${STATE_DB.acknowledged?.length||0} scans=${Object.keys(STATE_DB.scanHistory||{}).length} tickets=${STATE_DB.tickets?.length||0}\n`));
  } catch {}
}

async function backupState() {
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(BACKUP_DIR, { recursive: true }));
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bp = join(BACKUP_DIR, `state-${ts}.json`);
    await writeFile(bp, JSON.stringify(STATE_DB, null, 2));
    await import('node:fs/promises').then(fs => fs.appendFile(LOG_PATH, `${new Date().toISOString()} BACKUP file=state-${ts}.json\n`));
    return { ok: true, file: `state-${ts}.json`, path: bp };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listBackups() {
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const files = await fs.readdir(BACKUP_DIR);
    const list = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => {
      const s = await fs.stat(join(BACKUP_DIR, f));
      return { file: f, size: s.size, modified: s.mtime.toISOString() };
    }));
    return list.sort((a, b) => b.modified.localeCompare(a.modified));
  } catch (e) {
    return [];
  }
}

async function getAuditLog() {
  try {
    const data = await readFile(LOG_PATH, 'utf8');
    return data.trim().split('\n').reverse().slice(0, 200); // last 200 entries, newest first
  } catch {
    return [];
  }
}

// Auto-backup every hour while server runs
setInterval(() => backupState().catch(()=>{}), 60 * 60 * 1000);

// ─────────────────────────────────────────────────────
//  Static file server (public/)
// ─────────────────────────────────────────────────────
async function serveStatic(req, res) {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';
  const file = join(__dirname, 'public', path);
  if (!existsSync(file)) return err(res, 404, 'Not found');
  const ext = extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

// ─────────────────────────────────────────────────────
//  External API proxies (keep keys server-side)
// ─────────────────────────────────────────────────────

// 1) NASA FIRMS — live forest fires near a point
async function api_fires(req, res, { lat, lng, radiusKm = 50 }) {
  const key = ENV.NASA_FIRMS_MAP_KEY || 'DEMO_KEY';
  const bbox = `${(lng - 1).toFixed(2)},${(lat - 1).toFixed(2)},${(lng + 1).toFixed(2)},${(lat + 1).toFixed(2)}`;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/${bbox}/2`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FIRMS HTTP ${r.status}`);
    const csv = await r.text();
    // FIRMS sometimes returns plain text error like "Invalid MAP_KEY..."
    if (csv.toLowerCase().includes('invalid') || csv.toLowerCase().includes('error') || !csv.includes(',')) {
      throw new Error(`FIRMS rejected: ${csv.slice(0, 100)}`);
    }
    const lines = csv.split('\n').slice(1).filter(Boolean);
    const fires = lines.map(l => {
      const p = l.split(',');
      const flat = parseFloat(p[0]), flng = parseFloat(p[1]);
      return {
        lat: flat, lng: flng, brightness: parseFloat(p[2]),
        acq_date: p[5], acq_time: p[6], satellite: p[7],
        confidence: p[8], frp: parseFloat(p[11]),
        dist: haversine(lat, lng, flat, flng),
      };
    }).filter(f => Number.isFinite(f.lat) && f.dist <= radiusKm).sort((a, b) => a.dist - b.dist);
    json(res, { fires, total: fires.length, source: 'nasa-firms', usedKey: key === 'DEMO_KEY' ? 'DEMO_KEY' : 'personal-key', fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.warn('[fires] error → mock fallback:', e.message);
    json(res, { fires: mockFires(lat, lng), total: 0, source: 'mock', error: e.message, usedKey: key === 'DEMO_KEY' ? 'DEMO_KEY (no personal key)' : 'personal-key-failed' });
  }
}

// 2) iNaturalist — real species observations
async function api_species(req, res, { lat, lng, radiusKm = 10 }) {
  try {
    const url = `https://api.inaturalist.org/v1/observations?lat=${lat}&lng=${lng}&radius=${radiusKm}&per_page=20&quality_grade=research&photos=true`;
    const r = await fetch(url);
    const j = await r.json();
    json(res, { obs: j.results || [], total: j.total_results || 0, source: 'inaturalist' });
  } catch (e) {
    json(res, { obs: [], total: 0, source: 'mock', error: e.message });
  }
}

// 3) Open-Meteo — weather + Fire Weather Index
async function api_weather(req, res, { lat, lng }) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia/Kolkata&forecast_days=7`;
    const r = await fetch(url);
    const j = await r.json();
    const c = j.current;
    const fwi = Math.max(0, Math.min(100, Math.round(c.temperature_2m * 2.5 - c.relative_humidity_2m / 2 + c.wind_speed_10m * 2 - c.precipitation * 10)));
    json(res, { ...j, fireWeatherIndex: fwi, source: 'open-meteo' });
  } catch (e) {
    json(res, { current: { temperature_2m: 28, relative_humidity_2m: 62, wind_speed_10m: 8, precipitation: 0 }, fireWeatherIndex: 42, source: 'mock' });
  }
}

// 4) Wikipedia REST — tribe summaries
async function api_wiki(req, res, { query }) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('not found');
    const j = await r.json();
    json(res, { ...j, source: 'wikipedia' });
  } catch (e) {
    json(res, { error: e.message, source: 'mock' }, 404);
  }
}

// 5) Sentinel-2 NDVI scan (REAL or mock)
async function api_scan(req, res, { groveId, lat, lng, bufferM = 500 }) {
  if (ENV.SENTINEL_HUB_CLIENT_ID && ENV.SENTINEL_HUB_CLIENT_SECRET) {
    try {
      const result = await runSentinelScan(lat, lng, bufferM);
      json(res, { ...result, source: 'sentinel-hub', groveId });
      return;
    } catch (e) {
      console.warn('[sentinel] failed, mock fallback:', e.message);
    }
  }
  // Mock
  const seed = hash(groveId + new Date().toDateString());
  const baseline = 0.65 + ((seed % 25) / 100);
  const delta = ((seed >> 4) % 30 - 15) / 100;
  const current = Math.round((baseline + delta) * 1000) / 1000;
  json(res, {
    groveId, ndviCurrent: current, ndviBaseline: baseline, ndviDelta: delta,
    affectedPx: delta < 0 ? Math.round(Math.abs(delta) * 4000) : 0,
    source: 'mock', scanRunAt: new Date().toISOString(),
  });
}

// 6) Singbonga ChatGPT — powered by OpenAI gpt-4o-mini
async function api_chat(req, res, { groveContext, message, history = [] }) {
  const g = groveContext || {};
  const systemPrompt = `You are "Singbonga GPT", a knowledgeable AI assistant for the VANIKA NET sacred-grove conservation platform.

You are grounded in this specific grove's recorded data:
- Grove name: ${g.name || 'Unknown'}
- Tribe / community: ${g.tribe || 'Unknown'}
- Presiding deity: ${g.deity || 'Unknown'}
- State: ${g.state || 'Unknown'}
- Area: ${g.area || '?'} hectares
- Carbon stored: ${g.carbon || 0} t CO₂
- Threat note: ${g.note || 'no active threats'}
- Dominant species: ${(g.species || []).map(s => s.n).join(', ') || 'unrecorded'}
- Oral testimonies from custodians:
${(g.oral || []).map((o, i) => `  [${i + 1}] ${o.tr}`).join('\n') || '  (none recorded yet)'}

Rules:
1. Answer questions about this grove using the data above. If the user asks something general about sacred groves, Bihar/Jharkhand tribes, Sarna religion, or Adivasi conservation, you may answer from your training.
2. When citing a custodian, use "(testimony 1)" etc.
3. Respect tribal IP — never invent traditional medicinal recipes; encourage users to consult the actual healer.
4. Be concise. 2-4 sentences usually. Use bullet points only when listing multiple items.
5. Match the user's language (English, Hindi, Mundari, or Santali).
6. Be warm and respectful — these communities have protected these forests for 300+ years.`;

  if (!ENV.OPENAI_API_KEY) {
    console.warn('[chat] no OPENAI_API_KEY in .env → mock fallback');
    return json(res, { reply: mockChat(message, g), source: 'mock', diagnostic: '✗ OPENAI_API_KEY not set in .env' });
  }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ENV.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
        max_tokens: 600,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: message },
        ],
      }),
    });
    const j = await r.json();
    if (j.choices?.[0]?.message?.content) {
      return json(res, { reply: j.choices[0].message.content, source: 'openai', model: j.model });
    }
    console.error('[chat] OpenAI returned no content:', JSON.stringify(j).slice(0, 200));
    return json(res, { reply: mockChat(message, g), source: 'mock', error: j.error?.message || 'no content returned', diagnostic: 'OpenAI responded but with no message content. Check API key validity and quota.' });
  } catch (e) {
    console.error('[chat] OpenAI fetch failed:', e.message);
    return json(res, { reply: mockChat(message, g), source: 'mock', error: e.message, diagnostic: 'Network error reaching OpenAI. Check internet + key.' });
  }
}

// 7) Voice transcribe (real Whisper) + extract structured data with ChatGPT
async function api_voice(req, res) {
  const body = await bodyJson(req);
  const { audio, mimeType = 'audio/webm' } = body;

  if (!ENV.OPENAI_API_KEY) {
    return json(res, {
      transcript: { text: 'This grove is in our village Hesakora. The big sal tree is the seat of Singbonga. We have Sal, Mahua, and Karam trees here. Last week some men came with axes — we chased them away.', language: 'en' },
      extracted: { proposedName: 'Hesakora Jaher Than', village: 'Hesakora', deity: 'Singbonga', species: ['Sal', 'Mahua', 'Karam'], threats: ['Illegal felling attempt'], language: 'EN', confidence: 0.947 },
      source: 'mock',
      diagnostic: '✗ OPENAI_API_KEY not set — add to .env to enable real Whisper',
    });
  }
  if (!audio) {
    return json(res, { error: 'No audio data in body. Send {audio: base64, mimeType}' }, 400);
  }

  try {
    // 1) Decode base64 audio
    const audioBuffer = Buffer.from(audio, 'base64');
    console.log(`[whisper] received ${(audioBuffer.length / 1024).toFixed(1)} KB audio (${mimeType})`);

    // 2) Send to OpenAI Whisper for transcription (multipart/form-data)
    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : 'webm';
    const fd = new FormData();
    fd.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    fd.append('model', ENV.OPENAI_WHISPER_MODEL || 'whisper-1');
    fd.append('response_format', 'verbose_json');

    const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ENV.OPENAI_API_KEY}` },
      body: fd,
    });
    if (!wr.ok) {
      const text = await wr.text().catch(() => '');
      throw new Error(`Whisper HTTP ${wr.status}: ${text.slice(0, 200)}`);
    }
    const transcript = await wr.json();
    console.log(`[whisper] transcribed in ${transcript.duration?.toFixed(1)}s: ${transcript.text?.slice(0, 80)}...`);

    // 3) Send transcript to ChatGPT for structured extraction
    const extractPrompt = `Extract structured grove information from this voice transcript. Return ONLY a JSON object (no markdown, no commentary) with this exact shape:
{
  "proposedName": string|null,
  "village": string|null,
  "deity": string|null,
  "species": string[],
  "threats": string[],
  "tribe": string|null,
  "language": "EN"|"HI"|"MUN"|"SAT"|"HO",
  "confidence": number 0-1
}

Transcript: """${transcript.text}"""`;

    const er = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ENV.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ENV.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a field anthropologist. Extract structured grove data from voice transcripts in tribal languages (Mundari, Santali, Ho, Hindi, English). Return valid JSON only.' },
          { role: 'user', content: extractPrompt },
        ],
      }),
    });
    let extracted = null;
    if (er.ok) {
      const ej = await er.json();
      try {
        extracted = JSON.parse(ej.choices?.[0]?.message?.content || '{}');
      } catch (e) {
        console.warn('[whisper] extract JSON parse failed:', e.message);
      }
    }

    return json(res, {
      transcript: { text: transcript.text, language: transcript.language, duration: transcript.duration },
      extracted,
      source: 'openai-whisper',
      model: ENV.OPENAI_WHISPER_MODEL || 'whisper-1',
    });
  } catch (e) {
    console.error('[voice] failed:', e.message);
    return json(res, { error: e.message, source: 'error' }, 500);
  }
}

// ─────────────────────────────────────────────────────
//  Sentinel-2 NDVI implementation
// ─────────────────────────────────────────────────────
let _shToken = null;
async function getSentinelToken() {
  if (_shToken && _shToken.exp > Date.now()) return _shToken.token;
  const r = await fetch('https://services.sentinel-hub.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ENV.SENTINEL_HUB_CLIENT_ID,
      client_secret: ENV.SENTINEL_HUB_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`Sentinel auth failed: ${r.status}`);
  const j = await r.json();
  _shToken = { token: j.access_token, exp: Date.now() + (j.expires_in - 30) * 1000 };
  return _shToken.token;
}

async function runSentinelScan(lat, lng, bufferM) {
  // 2km buffer = ~400 hectares → reliably finds non-cloudy pixels
  const safeBuffer = Math.max(bufferM, 2000);
  const dLat = safeBuffer / 111111;
  const dLng = safeBuffer / (111111 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  const token = await getSentinelToken();

  const isoDay = (d) => d.toISOString().slice(0, 10) + 'T00:00:00Z';
  const isoDayEnd = (d) => d.toISOString().slice(0, 10) + 'T23:59:59Z';
  const now = new Date();
  // 90-day windows — almost guaranteed clear-sky pixels even in Indian monsoon
  const currentFrom = new Date(now.getTime() - 90 * 86400000);
  const baselineFrom = new Date(now.getTime() - 455 * 86400000);
  const baselineTo = new Date(now.getTime() - 365 * 86400000);

  const evalscript = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: [
      { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  // mask out clouds and cloud shadows using SCL
  const valid = s.dataMask === 1 && s.SCL !== 3 && s.SCL !== 8 && s.SCL !== 9 && s.SCL !== 10;
  const denom = s.B08 + s.B04;
  const ndvi = denom === 0 ? 0 : (s.B08 - s.B04) / denom;
  return { ndvi: [ndvi], dataMask: [valid ? 1 : 0] };
}`;

  const fetchMean = async (from, to, label) => {
    const body = {
      input: {
        bounds: { bbox, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
        data: [{
          type: 'sentinel-2-l2a',
          dataFilter: { timeRange: { from: isoDay(from), to: isoDayEnd(to) }, maxCloudCoverage: 80 },
        }],
      },
      aggregation: {
        timeRange: { from: isoDay(from), to: isoDayEnd(to) },
        aggregationInterval: { of: 'P90D' },
        evalscript,
        width: 256,
        height: 256,
      },
      calculations: {
        default: { statistics: { default: { percentiles: { k: [50] } } } },
      },
    };
    const r = await fetch('https://services.sentinel-hub.com/api/v1/statistics', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '(no body)');
      throw new Error(`Sentinel ${label} HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
    const j = await r.json();
    console.log(`[sentinel ${label}] response:`, JSON.stringify(j).slice(0, 500));
    const buckets = j.data || [];
    let totalSampleCount = 0;
    const validMeans = [];
    for (const b of buckets) {
      const ndviStats = b.outputs?.ndvi?.bands?.B0?.stats;
      if (ndviStats && Number.isFinite(ndviStats.mean)) {
        validMeans.push(ndviStats.mean);
        totalSampleCount += ndviStats.sampleCount || 0;
      }
    }
    if (!validMeans.length) {
      return { mean: 0, samples: 0, buckets: buckets.length, raw: j };
    }
    return {
      mean: validMeans.reduce((a, v) => a + v, 0) / validMeans.length,
      samples: totalSampleCount,
      buckets: validMeans.length,
    };
  };

  const cur = await fetchMean(currentFrom, now, 'current');
  const base = await fetchMean(baselineFrom, baselineTo, 'baseline');
  const delta = cur.mean - base.mean;
  return {
    ndviCurrent: Math.round(cur.mean * 1000) / 1000,
    ndviBaseline: Math.round(base.mean * 1000) / 1000,
    ndviDelta: Math.round(delta * 1000) / 1000,
    affectedPx: delta < 0 ? Math.round(Math.abs(delta) * 4000) : 0,
    scanRunAt: new Date().toISOString(),
    bufferM: safeBuffer,
    diagnostic: {
      currentSamples: cur.samples,
      currentBuckets: cur.buckets,
      baselineSamples: base.samples,
      baselineBuckets: base.buckets,
      noteIfZero: (cur.mean === 0 || base.mean === 0) ? 'Zero NDVI usually means: (1) no clear-sky imagery in window, (2) bbox over water/no-data, or (3) Sentinel quota exhausted. Check server console for raw response.' : null,
    },
  };
}

// ─────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h; }
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}
function mockFires(lat, lng) {
  const seed = Math.floor((lat + lng) * 1000) % 4;
  return Array.from({ length: seed }).map((_, i) => ({
    lat: lat + ((i * 17) % 100 - 50) / 1000, lng: lng + ((i * 23) % 100 - 50) / 1000,
    frp: 5 + i * 3, brightness: 320 + i * 15,
    acq_date: new Date(Date.now() - i * 3600000).toISOString().slice(0, 10),
    acq_time: '0830', confidence: 'n', dist: i * 1.2 + 1,
  }));
}
function mockChat(msg, g) {
  const lo = msg.toLowerCase();
  if (/plant|species|tree/.test(lo)) return `${g.name} is dominated by ${(g.species || []).slice(0, 3).map(s => s.n).join(', ')}. No felling under customary law (testimony 1).`;
  if (/deity|god/.test(lo)) return `Seat of ${g.deity}, worshipped by ${g.tribe} during Sarhul/Karam festivals (testimony 1).`;
  if (/threat|mining/.test(lo)) return `${g.note || 'External pressure rising'} (testimony 1). See Satellite tab.`;
  if (/carbon/.test(lo)) return `${g.name} stores ~${(g.carbon || 0).toLocaleString()} t CO₂ — ₹${((g.carbon || 0) * 700 / 100000).toFixed(2)} L at ICM rate.`;
  return `I can answer about ${g.name}'s species, deity, oral history, threats, carbon. Ask in EN/HI/MUN/SAT.`;
}

// ─────────────────────────────────────────────────────
//  API router
// ─────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════
//  DISCOVERY ENGINE — Real Live API Aggregator
//  GET /api/discovery/area?lat=X&lng=Y
//  Runs 8 government APIs in parallel using configured keys.
// ═════════════════════════════════════════════════════════════
async function api_discovery_area(req, res, { lat, lng }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json(res, { error: 'lat/lng required' }, 400);
  }
  const tasks = await Promise.allSettled([
    // 1) OSM Nominatim — reverse geocode (keyless)
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=12&addressdetails=1`, { headers: { 'User-Agent': 'vanika-net/1.0 discovery-engine' } }).then(r => r.json()).then(j => ({
      api: 'OSM Nominatim',
      ok: true,
      data: { display: j.display_name || '—', district: j.address?.county || j.address?.state_district || '—', state: j.address?.state || '—' }
    })).catch(e => ({ api: 'OSM Nominatim', ok: false, error: e.message })),

    // 2) Open-Elevation
    fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lng}`).then(r => r.json()).then(j => ({
      api: 'Open-Elevation', ok: true, data: { elevation_m: j.results?.[0]?.elevation ?? null }
    })).catch(e => ({ api: 'Open-Elevation', ok: false, error: e.message })),

    // 3) GBIF — species occurrences in radius
    fetch(`https://api.gbif.org/v1/occurrence/search?decimalLatitude=${(lat-0.05).toFixed(3)},${(lat+0.05).toFixed(3)}&decimalLongitude=${(lng-0.05).toFixed(3)},${(lng+0.05).toFixed(3)}&limit=20&hasCoordinate=true`).then(r => r.json()).then(j => ({
      api: 'GBIF',
      ok: true,
      data: { count: j.count || 0, species: [...new Set((j.results||[]).map(x => x.species).filter(Boolean))].slice(0,5) }
    })).catch(e => ({ api: 'GBIF', ok: false, error: e.message })),

    // 4) eBird — bird species nearby (uses EBIRD_TOKEN)
    ENV.EBIRD_TOKEN ? fetch(`https://api.ebird.org/v2/data/obs/geo/recent?lat=${lat}&lng=${lng}&dist=25&back=30`, { headers: { 'X-eBirdApiToken': ENV.EBIRD_TOKEN } }).then(r => r.json()).then(j => ({
      api: 'eBird (Cornell)',
      ok: true,
      data: { count: Array.isArray(j) ? j.length : 0, species: [...new Set((j||[]).map(x => x.comName).filter(Boolean))].slice(0,5) }
    })).catch(e => ({ api: 'eBird (Cornell)', ok: false, error: e.message })) : Promise.resolve({ api: 'eBird (Cornell)', ok: false, error: 'no token' }),

    // 5) iNaturalist — citizen observations
    fetch(`https://api.inaturalist.org/v1/observations?lat=${lat}&lng=${lng}&radius=10&per_page=10&quality_grade=research`).then(r => r.json()).then(j => ({
      api: 'iNaturalist',
      ok: true,
      data: { count: j.total_results || 0, species: [...new Set((j.results||[]).map(o => o.taxon?.name).filter(Boolean))].slice(0,5) }
    })).catch(e => ({ api: 'iNaturalist', ok: false, error: e.message })),

    // 6) Open-Meteo — weather + fire-weather-index
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&daily=precipitation_sum&past_days=30&timezone=Asia/Kolkata`).then(r => r.json()).then(j => {
      const c = j.current || {};
      const rainSum = (j.daily?.precipitation_sum || []).reduce((a,b) => a + (b||0), 0);
      const fwi = Math.max(0, Math.min(100, Math.round(((c.temperature_2m||25)*2.5) - ((c.relative_humidity_2m||50)/2) + ((c.wind_speed_10m||5)*2) - ((c.precipitation||0)*10))));
      return { api: 'Open-Meteo', ok: true, data: { temp_c: c.temperature_2m, rh_pct: c.relative_humidity_2m, wind_kmh: c.wind_speed_10m, rainfall_30d_mm: Math.round(rainSum), fwi } };
    }).catch(e => ({ api: 'Open-Meteo', ok: false, error: e.message })),

    // 7) NASA FIRMS — active fires (uses NASA_FIRMS_MAP_KEY)
    (async () => {
      const key = ENV.NASA_FIRMS_MAP_KEY || 'DEMO_KEY';
      const bbox = `${(lng-0.5).toFixed(2)},${(lat-0.5).toFixed(2)},${(lng+0.5).toFixed(2)},${(lat+0.5).toFixed(2)}`;
      const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/${bbox}/7`);
      const csv = await r.text();
      if (!csv.includes(',') || csv.toLowerCase().includes('invalid')) return { api: 'NASA FIRMS', ok: false, error: csv.slice(0,80) };
      const lines = csv.split('\n').slice(1).filter(Boolean);
      return { api: 'NASA FIRMS', ok: true, data: { active_fires_7d: lines.length, key_used: key === 'DEMO_KEY' ? 'demo' : 'personal' } };
    })().catch(e => ({ api: 'NASA FIRMS', ok: false, error: e.message })),

    // 8) IUCN Red List — species conservation status (uses IUCN_TOKEN)
    ENV.IUCN_TOKEN ? fetch(`https://apiv3.iucnredlist.org/api/v3/country/getspecies/IN?token=${ENV.IUCN_TOKEN}`).then(r => r.json()).then(j => {
      const buckets = { CR: 0, EN: 0, VU: 0, NT: 0, LC: 0 };
      (j.result || []).forEach(s => { if (buckets[s.category] !== undefined) buckets[s.category]++; });
      return { api: 'IUCN Red List', ok: true, data: { country: 'IN', total: (j.result||[]).length, ...buckets } };
    }).catch(e => ({ api: 'IUCN Red List', ok: false, error: e.message })) : Promise.resolve({ api: 'IUCN Red List', ok: false, error: 'no token' }),
  ]);

  const results = tasks.map(t => t.status === 'fulfilled' ? t.value : { api: 'unknown', ok: false, error: String(t.reason) });
  json(res, { lat, lng, fetchedAt: new Date().toISOString(), results });
}



async function handleAPI(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);

  if (p === '/api/health') return json(res, {
    ok: true,
    env: Object.keys(ENV).filter(k => ENV[k]).length,
    time: new Date().toISOString(),
    keys: {
      OPENAI_API_KEY:    ENV.OPENAI_API_KEY    ? `✓ set (${ENV.OPENAI_API_KEY.slice(0,7)}...${ENV.OPENAI_API_KEY.slice(-4)}, ${ENV.OPENAI_API_KEY.length} chars)` : '✗ MISSING — chat will fall back to mock',
      OPENAI_CHAT_MODEL: ENV.OPENAI_CHAT_MODEL || 'gpt-4o-mini (default)',
      NASA_FIRMS_MAP_KEY:     ENV.NASA_FIRMS_MAP_KEY ? `✓ set (${ENV.NASA_FIRMS_MAP_KEY.slice(0,7)}...)` : '✗ MISSING (will use DEMO_KEY shared quota)',
      SENTINEL_HUB_CLIENT_ID:     ENV.SENTINEL_HUB_CLIENT_ID     ? `✓ set (${ENV.SENTINEL_HUB_CLIENT_ID.slice(0,7)}...)` : '✗ MISSING — scan uses mock',
      SENTINEL_HUB_CLIENT_SECRET: ENV.SENTINEL_HUB_CLIENT_SECRET ? `✓ set (${ENV.SENTINEL_HUB_CLIENT_SECRET.slice(0,4)}...)` : '✗ MISSING — scan uses mock',
    },
    envFilePath: join(__dirname, '.env'),
  });
  if (p === '/api/debug') {
    // Show ALL env keys (truncated) for debugging
    const dump = {};
    Object.entries(ENV).forEach(([k, v]) => {
      if (!v) dump[k] = '(empty)';
      else if (k.includes('SECRET') || k.includes('KEY')) dump[k] = v.slice(0, 8) + '…' + v.slice(-4) + ` (length: ${v.length})`;
      else dump[k] = v;
    });
    return json(res, { loadedFromEnv: dump, totalKeys: Object.keys(ENV).length });
  }
  // ─────── AUTH endpoints ───────
  if (p === '/api/auth/login' && req.method === 'POST') return api_auth_login(req, res);
  if (p === '/api/auth/logout' && req.method === 'POST') return api_auth_logout(req, res);
  if (p === '/api/auth/me' && req.method === 'GET') return api_auth_me(req, res);
  if (p === '/api/auth/demo-accounts' && req.method === 'GET') return api_auth_demo_accounts(req, res);
  // ─────── INBOX v2 endpoints ───────
  if (p === '/api/inbox/route' && req.method === 'POST') return api_inbox_route(req, res);
  if (p === '/api/inbox/me' && req.method === 'GET') return api_inbox_me(req, res);
  if (p === '/api/inbox/action' && req.method === 'POST') return api_inbox_action(req, res);

  if (p === '/api/discovery/area' && req.method === 'GET') return api_discovery_area(req, res, { lat: +q.lat, lng: +q.lng });
  if (p === '/api/fires' && req.method === 'GET') return api_fires(req, res, { lat: +q.lat, lng: +q.lng, radiusKm: +q.radiusKm || 50 });
  if (p === '/api/species' && req.method === 'GET') return api_species(req, res, { lat: +q.lat, lng: +q.lng, radiusKm: +q.radiusKm || 10 });
  if (p === '/api/weather' && req.method === 'GET') return api_weather(req, res, { lat: +q.lat, lng: +q.lng });
  if (p === '/api/wiki' && req.method === 'GET') return api_wiki(req, res, { query: q.query || 'Sarna_religion' });
  if (p === '/api/story-images' && req.method === 'GET') {
    try { const m = JSON.parse(await readFile(join(STORY_IMAGE_DIR, 'manifest.json'), 'utf8')); return json(res, m); }
    catch { return json(res, {}); }
  }
  if (p === '/api/story-images/refresh' && req.method === 'POST') {
    const force = q.force === '1' || q.force === 'true';
    cacheStoryImages(force).catch(()=>{});
    return json(res, { ok: true, force, message: 'cache refresh started — check console' });
  }
  if (p === '/api/scan' && req.method === 'POST') { const body = await bodyJson(req); return api_scan(req, res, body); }
  if (p === '/api/chat' && req.method === 'POST') { const body = await bodyJson(req); return api_chat(req, res, body); }
  if (p === '/api/voice' && req.method === 'POST') return api_voice(req, res);
  if (p === '/api/overrides' && req.method === 'GET') return json(res, OVERRIDES);
  if (p === '/api/overrides' && req.method === 'POST') { const body = await bodyJson(req); OVERRIDES[body.id] = body; await saveDB(); return json(res, { ok: true, id: body.id }); }

  // === Persistent app state ===
  if (p === '/api/state' && req.method === 'GET') return json(res, STATE_DB);
  if (p === '/api/state' && req.method === 'POST') { const body = await bodyJson(req); STATE_DB = { ...STATE_DB, ...body, savedAt: new Date().toISOString() }; await saveState(); return json(res, { ok: true, savedAt: STATE_DB.savedAt }); }
  if (p === '/api/state' && req.method === 'DELETE') { STATE_DB = { cart:[], acknowledged:[], activity:[], notifications:[], settings:{}, scanHistory:{}, registeredGroves:[], tickets:[] }; await saveState(); return json(res, { ok: true }); }

  // === DB backup & recovery ===
  if (p === '/api/backup' && req.method === 'POST') { const r = await backupState(); return json(res, r); }
  if (p === '/api/backups' && req.method === 'GET') { const list = await listBackups(); return json(res, { backups: list, count: list.length }); }
  if (p.startsWith('/api/backup/restore/') && req.method === 'POST') {
    const file = p.split('/').pop();
    try {
      const data = JSON.parse(await readFile(join(BACKUP_DIR, file), 'utf8'));
      STATE_DB = data; await saveState();
      return json(res, { ok: true, restored: file });
    } catch (e) { return err(res, 404, 'Backup not found: ' + e.message); }
  }
  if (p === '/api/audit' && req.method === 'GET') { const log = await getAuditLog(); return json(res, { lines: log, count: log.length }); }

  // === Tickets (Field Operations workflow) ===
  if (p === '/api/tickets' && req.method === 'GET') return json(res, { tickets: STATE_DB.tickets || [] });
  if (p === '/api/tickets' && req.method === 'POST') {
    const body = await bodyJson(req);
    STATE_DB.tickets = STATE_DB.tickets || [];
    const t = { id: 'TKT-' + Date.now().toString().slice(-7), ...body, createdAt: new Date().toISOString(), status: body.status || 'open', updates: body.updates || [] };
    STATE_DB.tickets.unshift(t);
    await saveState();
    return json(res, t);
  }
  if (p.startsWith('/api/tickets/') && req.method === 'PUT') {
    const id = p.split('/').pop();
    const body = await bodyJson(req);
    STATE_DB.tickets = (STATE_DB.tickets || []).map(t => t.id === id ? { ...t, ...body, updates: [...(t.updates||[]), { at: new Date().toISOString(), by: body._by || 'system', text: body._update || 'updated' }] } : t);
    await saveState();
    return json(res, { ok: true });
  }

  // === Sacred Site VOICE EXTRACTION (Whisper + GPT structured fields) ===
  // Custodian / Forest speaks → form auto-fills (name, deity, fauna, flora, oral history, threats)
  if (p === '/api/sacred-site/voice-extract' && req.method === 'POST') {
    const me = getCurrentUser(req);
    if (!me) return json(res, { error: 'auth required' }, 401);
    const body = await bodyJson(req);
    const { audio, mimeType = 'audio/webm' } = body;

    // No OpenAI key → deterministic mock with realistic Mundari/Hindi voice content
    if (!ENV.OPENAI_API_KEY) {
      return json(res, {
        transcript: { text: 'यहाँ हमारा सरना स्थान है, सिंगबोंगा का स्थान, साल का बड़ा पेड़ है। यहाँ हाथी आते हैं, सांभर, सुस्त भालू भी देखा है। मधुमक्खी पालन भी करते हैं। पास में खनन का खतरा है।', language: 'hi' },
        extracted: {
          name: 'Hesakora Jaher Than', deity: 'Singbonga', tribe: 'Munda',
          keyFauna: ['Asian Elephant', 'Sambar', 'Sloth Bear', 'Honey Bee'],
          keyFlora: ['Sal (Shorea robusta)', 'Mahua'],
          oralHistory: 'Our Sarna sthan, the seat of Singbonga, with a large sal tree. Elephants visit, also sambar and sloth bear. We practise beekeeping here.',
          threats: 'Mining encroachment nearby',
          confidence: 0.91,
        },
        source: 'mock',
        diagnostic: '✗ OPENAI_API_KEY not set — add to .env to enable real Whisper',
      });
    }
    if (!audio) return json(res, { error: 'no audio in body' }, 400);

    try {
      const audioBuffer = Buffer.from(audio, 'base64');
      console.log(`[voice-extract] received ${(audioBuffer.length / 1024).toFixed(1)} KB`);
      const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'webm';
      const fd = new FormData();
      fd.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
      fd.append('model', ENV.OPENAI_WHISPER_MODEL || 'whisper-1');
      fd.append('response_format', 'verbose_json');
      const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${ENV.OPENAI_API_KEY}` }, body: fd,
      });
      if (!wr.ok) throw new Error(`Whisper HTTP ${wr.status}: ${(await wr.text()).slice(0,200)}`);
      const transcript = await wr.json();
      console.log(`[voice-extract] transcribed: ${transcript.text?.slice(0,100)}`);

      const prompt = `You are a field anthropologist registering a tribal sacred grove for the VANIKA NET atlas.
Extract structured data from this voice transcript (spoken in Hindi / Mundari / Ho / Santali / English).
Return ONLY a JSON object with this exact shape (no markdown, no commentary):
{
  "name": string|null,            // proposed name of the grove (in English transliteration)
  "deity": string|null,           // deity or cultural anchor (Singbonga, Marang Buru, Sarna Burhi, etc.)
  "tribe": string|null,           // Munda / Ho / Santal / Oraon etc.
  "village": string|null,         // village name if mentioned
  "keyFauna": string[],           // animal species mentioned (canonical English common names)
  "keyFlora": string[],           // plant / tree species mentioned (canonical names with sci. name if possible)
  "oralHistory": string|null,     // 1-2 sentence cultural significance summary in English
  "threats": string|null,         // threats observed (encroachment, fire, mining, hunting), comma-joined
  "confidence": number            // 0-1 overall extraction confidence
}

Transcript: """${transcript.text}"""`;

      const er = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ENV.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ENV.OPENAI_CHAT_MODEL || 'gpt-4o-mini', temperature: 0.2, max_tokens: 600,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Field anthropologist extracting tribal grove data. Return valid JSON only with the requested shape.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
      let extracted = null;
      if (er.ok) {
        const ej = await er.json();
        try { extracted = JSON.parse(ej.choices?.[0]?.message?.content || '{}'); }
        catch (e) { console.warn('[voice-extract] JSON parse failed:', e.message); }
      }
      return json(res, {
        transcript: { text: transcript.text, language: transcript.language, duration: transcript.duration },
        extracted, source: 'openai-whisper', model: ENV.OPENAI_WHISPER_MODEL || 'whisper-1',
      });
    } catch (e) {
      console.error('[voice-extract] failed:', e.message);
      return json(res, { error: e.message }, 500);
    }
  }

  // === Sacred Site AUTO-FETCH (reverse-geocode + elevation + nearby fauna + birds + weather + FWI in 1 call) ===
  if (p === '/api/sacred-site/auto-fetch' && req.method === 'GET') {
    const me = getCurrentUser(req);
    if (!me) return json(res, { error: 'auth required' }, 401);
    const lat = +q.lat, lng = +q.lng;
    if (!lat || !lng) return json(res, { error: 'lat & lng required' }, 400);

    const result = { lat, lng, fetchedAt: new Date().toISOString(), sources: {} };
    // Run in parallel — never block on one slow API
    const tasks = await Promise.allSettled([
      // 1. Reverse geocode (OpenStreetMap Nominatim — free, no key)
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`,
        { headers: { 'User-Agent': 'SARNA-NET/1.0 (sacredgrove@sarnanet.in)' } })
        .then(r => r.ok ? r.json() : null).catch(() => null),
      // 2. Elevation (Open-Elevation — free)
      fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lng}`)
        .then(r => r.ok ? r.json() : null).catch(() => null),
      // 3. Nearby fauna — GBIF (5 km radius)
      (async () => {
        const dLat = 5 / 111, dLng = 5 / (111 * Math.cos(lat * Math.PI / 180));
        const url = new URL('https://api.gbif.org/v1/occurrence/search');
        url.searchParams.set('decimalLatitude', `${lat - dLat},${lat + dLat}`);
        url.searchParams.set('decimalLongitude', `${lng - dLng},${lng + dLng}`);
        url.searchParams.set('country', 'IN');
        url.searchParams.set('hasCoordinate', 'true');
        url.searchParams.set('limit', '40');
        const r = await fetch(url.toString());
        return r.ok ? r.json() : null;
      })().catch(() => null),
      // 4. Birds (GBIF classKey=212 = Aves)
      (async () => {
        const dLat = 10 / 111, dLng = 10 / (111 * Math.cos(lat * Math.PI / 180));
        const url = new URL('https://api.gbif.org/v1/occurrence/search');
        url.searchParams.set('classKey', '212');
        url.searchParams.set('decimalLatitude', `${lat - dLat},${lat + dLat}`);
        url.searchParams.set('decimalLongitude', `${lng - dLng},${lng + dLng}`);
        url.searchParams.set('country', 'IN');
        url.searchParams.set('hasCoordinate', 'true');
        url.searchParams.set('limit', '20');
        const r = await fetch(url.toString());
        return r.ok ? r.json() : null;
      })().catch(() => null),
      // 5. Weather + Fire Weather Index — Open-Meteo
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&daily=fire_weather_index_max&timezone=auto`)
        .then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const [geo, elev, fauna, birds, weather] = tasks.map(t => t.status === 'fulfilled' ? t.value : null);

    // Reverse geocode
    if (geo?.address) {
      result.address = {
        district: geo.address.county || geo.address.state_district || geo.address.district || null,
        state: geo.address.state || null,
        country: geo.address.country || null,
        displayName: geo.display_name,
      };
      result.sources.geocode = 'openstreetmap-nominatim';
    }
    // Elevation
    if (elev?.results?.[0]) {
      result.elevation_m = elev.results[0].elevation;
      result.sources.elevation = 'open-elevation';
    }
    // Fauna (dedupe by species, prefer those with iucn category, top 15)
    if (fauna?.results) {
      const seen = new Set();
      const list = [];
      for (const r of fauna.results) {
        const name = r.species || r.scientificName;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        list.push({ name, vernacular: r.vernacularName || null, iucn: r.iucnRedListCategory || null, family: r.family || null });
        if (list.length >= 15) break;
      }
      result.fauna = list;
      result.sources.fauna = 'gbif';
    }
    // Birds
    if (birds?.results) {
      const seen = new Set();
      const list = [];
      for (const r of birds.results) {
        const name = r.species || r.scientificName;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        list.push({ name, vernacular: r.vernacularName || null, iucn: r.iucnRedListCategory || null });
        if (list.length >= 12) break;
      }
      result.birds = list;
      result.sources.birds = 'gbif-aves';
    }
    // Weather + FWI
    if (weather?.current) {
      result.weather = {
        tempC: weather.current.temperature_2m,
        humidity: weather.current.relative_humidity_2m,
        precipitation_mm: weather.current.precipitation,
        windSpeed: weather.current.wind_speed_10m,
        fwi_max_today: weather.daily?.fire_weather_index_max?.[0] || null,
      };
      result.sources.weather = 'open-meteo';
    }
    return json(res, result);
  }

  // === Sacred Site Registration workflow (custodian/forest → ZSI → MoEFCC → live) ===
  // STATUS LIFECYCLE: submitted → forest-verified (if originated by custodian, optional) → zsi-verified → moefcc-approved (live)
  if (p === '/api/sacred-site' && req.method === 'GET') {
    const me = getCurrentUser(req);
    if (!me) return json(res, { error: 'auth required' }, 401);
    const list = STATE_DB.registeredGroves || [];
    // Scope by role:
    //   - custodian: only own submissions
    //   - forest: submissions in own district
    //   - scientist + policy: everything (national)
    let scoped = list;
    if (me.role === 'custodian') scoped = list.filter(g => g.submittedByUserId === me.id);
    else if (me.role === 'forest' && me.district) scoped = list.filter(g => g.district === me.district);
    return json(res, { sites: scoped, total: scoped.length });
  }

  if (p === '/api/sacred-site' && req.method === 'POST') {
    const me = getCurrentUser(req);
    if (!me) return json(res, { error: 'auth required' }, 401);
    if (!['custodian', 'forest', 'scientist'].includes(me.role)) {
      return json(res, { error: 'only custodian / forest / scientist may register a new site' }, 403);
    }
    const body = await bodyJson(req);
    STATE_DB.registeredGroves = STATE_DB.registeredGroves || [];
    const id = 'NEW-' + Date.now().toString().slice(-7);
    const newSite = {
      id, name: (body.name || 'Unnamed Grove').trim(),
      district: (body.district || me.district || '').trim(),
      state: (body.state || me.state || 'Jharkhand').trim(),
      tribe: (body.tribe || '').trim(),
      lat: Number(body.lat) || 0,
      lng: Number(body.lng) || 0,
      areaHa: Number(body.areaHa) || 0,
      deity: (body.deity || '').trim(),
      keyFauna: Array.isArray(body.keyFauna) ? body.keyFauna : (body.keyFauna || '').split(',').map(s => s.trim()).filter(Boolean),
      keyFlora: Array.isArray(body.keyFlora) ? body.keyFlora : (body.keyFlora || '').split(',').map(s => s.trim()).filter(Boolean),
      oralHistory: (body.oralHistory || '').trim(),
      threats: (body.threats || '').trim(),
      photoData: body.photoData || null,  // base64 dataURL (optional, capped)
      audioData: body.audioData || null,  // base64 audio (optional — voice testimony)
      audioTranscript: body.audioTranscript || null,  // Whisper transcript text
      autoFetched: body.autoFetched || null,  // JSON blob from /auto-fetch (fauna/birds/weather/elevation/geocode)
      // workflow fields
      status: 'submitted',
      submittedByUserId: me.id,
      submittedByName: me.name,
      submittedByRole: me.role,
      submittedAt: new Date().toISOString(),
      forestVerifiedBy: null, forestVerifiedAt: null, forestNote: null,
      zsiVerifiedBy: null, zsiVerifiedAt: null, zsiNote: null,
      moefccApprovedBy: null, moefccApprovedAt: null, moefccNote: null,
      rejectedBy: null, rejectedAt: null, rejectionReason: null,
      auditTrail: [{ at: new Date().toISOString(), by: me.name, role: me.role, action: 'submitted', note: 'New sacred site registered' }],
    };
    STATE_DB.registeredGroves.unshift(newSite);
    await saveState();

    // Inbox cascade: route notification to next role
    // If custodian submitted → notify Forest Officer of their district + ZSI for visibility
    // If forest submitted → notify ZSI Scientist directly
    // If scientist submitted → notify MoEFCC directly
    const notifyRoles = [];
    if (me.role === 'custodian') notifyRoles.push({ toRole: 'forest', toDistrict: newSite.district }, { toRole: 'scientist' });
    else if (me.role === 'forest') notifyRoles.push({ toRole: 'scientist' });
    else if (me.role === 'scientist') notifyRoles.push({ toRole: 'policy' });

    for (const target of notifyRoles) {
      let recipients = [];
      if (target.toDistrict) recipients = USERS.filter(u => u.role === target.toRole && u.district === target.toDistrict);
      if (!recipients.length) recipients = USERS.filter(u => u.role === target.toRole);
      recipients.forEach(r => {
        INBOX.unshift({
          id: 'IN-' + Date.now() + '-' + randomBytes(3).toString('hex'),
          fromUserId: me.id, fromUserName: me.name, fromUserRole: me.role,
          toUserId: r.id, toUserName: r.name, toUserRole: r.role,
          type: 'sacred-site-registration',
          title: `New sacred site: ${newSite.name}`,
          body: `${me.name} (${me.role}) registered a new sacred grove "${newSite.name}" in ${newSite.district}. Status: ${newSite.status}. Action required.`,
          siteId: id, priority: 'normal', status: 'open',
          createdAt: new Date().toISOString(), completedAt: null, completedBy: null, completionNote: null,
          meta: { registrationId: id, registrationStatus: newSite.status },
        });
      });
    }
    if (INBOX.length > 5000) INBOX.length = 5000;
    await saveInbox();
    return json(res, { ok: true, site: newSite, notified: notifyRoles });
  }

  if (p.startsWith('/api/sacred-site/') && req.method === 'PUT') {
    const me = getCurrentUser(req);
    if (!me) return json(res, { error: 'auth required' }, 401);
    const id = p.split('/').pop();
    const body = await bodyJson(req);  // { action: 'forest-verify'|'zsi-verify'|'moefcc-approve'|'reject', note }
    STATE_DB.registeredGroves = STATE_DB.registeredGroves || [];
    const site = STATE_DB.registeredGroves.find(g => g.id === id);
    if (!site) return json(res, { error: 'site not found' }, 404);

    const action = body.action;
    const note = (body.note || '').trim();

    // Role-action validation matrix
    const valid = (
      (action === 'forest-verify' && me.role === 'forest' && site.status === 'submitted') ||
      (action === 'zsi-verify' && me.role === 'scientist' && ['submitted', 'forest-verified'].includes(site.status)) ||
      (action === 'moefcc-approve' && me.role === 'policy' && site.status === 'zsi-verified') ||
      (action === 'reject' && ['forest', 'scientist', 'policy'].includes(me.role))
    );
    if (!valid) return json(res, { error: `cannot perform ${action} as ${me.role} when status=${site.status}` }, 403);

    const stamp = new Date().toISOString();
    let nextNotify = [];
    if (action === 'forest-verify') {
      site.status = 'forest-verified';
      site.forestVerifiedBy = me.name; site.forestVerifiedAt = stamp; site.forestNote = note;
      nextNotify = [{ toRole: 'scientist' }];
    } else if (action === 'zsi-verify') {
      site.status = 'zsi-verified';
      site.zsiVerifiedBy = me.name; site.zsiVerifiedAt = stamp; site.zsiNote = note;
      nextNotify = [{ toRole: 'policy' }];
    } else if (action === 'moefcc-approve') {
      site.status = 'moefcc-approved';
      site.moefccApprovedBy = me.name; site.moefccApprovedAt = stamp; site.moefccNote = note;
      // Notify the original submitter that their site is now live
      nextNotify = [{ toUserId: site.submittedByUserId }];
    } else if (action === 'reject') {
      site.status = 'rejected';
      site.rejectedBy = me.name; site.rejectedAt = stamp; site.rejectionReason = note;
      nextNotify = [{ toUserId: site.submittedByUserId }];
    }
    site.auditTrail = site.auditTrail || [];
    site.auditTrail.push({ at: stamp, by: me.name, role: me.role, action, note });
    await saveState();

    // Inbox cascade for next step
    for (const target of nextNotify) {
      let recipients = [];
      if (target.toUserId) {
        const u = USERS.find(u => u.id === target.toUserId);
        if (u) recipients = [u];
      } else if (target.toRole) {
        recipients = USERS.filter(u => u.role === target.toRole);
      }
      recipients.forEach(r => {
        INBOX.unshift({
          id: 'IN-' + Date.now() + '-' + randomBytes(3).toString('hex'),
          fromUserId: me.id, fromUserName: me.name, fromUserRole: me.role,
          toUserId: r.id, toUserName: r.name, toUserRole: r.role,
          type: 'sacred-site-' + action,
          title: action === 'moefcc-approve'
            ? `Sacred site LIVE: ${site.name}`
            : action === 'reject'
            ? `Sacred site rejected: ${site.name}`
            : `Sacred site advanced: ${site.name}`,
          body: action === 'moefcc-approve'
            ? `MoEFCC has approved your sacred site "${site.name}". It is now live in the VANIKA NET atlas.`
            : action === 'reject'
            ? `Sacred site "${site.name}" was rejected by ${me.name} (${me.role}). Reason: ${note || '(no reason)'}.`
            : `Sacred site "${site.name}" was ${action}-ed by ${me.name}. Status is now ${site.status}. Next reviewer: ${target.toRole || '(submitter)'}.`,
          siteId: id, priority: action === 'moefcc-approve' ? 'high' : 'normal',
          status: 'open', createdAt: stamp, completedAt: null, completedBy: null, completionNote: null,
          meta: { registrationId: id, registrationStatus: site.status },
        });
      });
    }
    if (INBOX.length > 5000) INBOX.length = 5000;
    await saveInbox();
    return json(res, { ok: true, site });
  }

  // === NASA EONET — open natural events (fires, storms, volcanoes) ===
  if (p === '/api/events' && req.method === 'GET') {
    try {
      const r = await fetch('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&bbox=68,8,98,38'); // India bbox
      if (!r.ok) throw new Error('EONET ' + r.status);
      const j = await r.json();
      const events = (j.events || []).map(e => ({
        id: e.id, title: e.title,
        category: e.categories?.[0]?.title || 'Other',
        date: e.geometry?.[0]?.date,
        coords: e.geometry?.[0]?.coordinates,
        source: e.sources?.[0]?.url,
      }));
      return json(res, { events, total: events.length, source: 'nasa-eonet', fetchedAt: new Date().toISOString() });
    } catch (e) {
      return json(res, { events: [], source: 'mock', error: e.message });
    }
  }

  // === GBIF — birds filter (taxonKey 212 = Class Aves) ===
  if (p === '/api/birds' && req.method === 'GET') {
    const lat = +q.lat, lng = +q.lng, r2 = +q.radiusKm || 25;
    try {
      const dLat = r2 / 111;
      const dLng = r2 / (111 * Math.cos(lat * Math.PI / 180));
      const url = new URL('https://api.gbif.org/v1/occurrence/search');
      url.searchParams.set('classKey', '212');  // Aves
      url.searchParams.set('decimalLatitude', `${lat - dLat},${lat + dLat}`);
      url.searchParams.set('decimalLongitude', `${lng - dLng},${lng + dLng}`);
      url.searchParams.set('country', 'IN');
      url.searchParams.set('limit', '20');
      url.searchParams.set('hasCoordinate', 'true');
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error('GBIF ' + r.status);
      const j = await r.json();
      const birds = (j.results || []).map(b => ({
        key: b.key, name: b.species || b.scientificName,
        family: b.family || '?', vernacular: b.vernacularName,
        eventDate: b.eventDate, lat: b.decimalLatitude, lng: b.decimalLongitude,
        iucnRedList: b.iucnRedListCategory || null,
        basisOfRecord: b.basisOfRecord,
      }));
      return json(res, { birds, total: j.count || birds.length, source: 'gbif-aves', fetchedAt: new Date().toISOString() });
    } catch (e) {
      return json(res, { birds: [], source: 'mock', error: e.message });
    }
  }

  // === OpenAQ — air quality (v2 still public, no key) ===
  if (p === '/api/air' && req.method === 'GET') {
    const lat = +q.lat, lng = +q.lng;
    try {
      const url = `https://api.openaq.org/v2/latest?coordinates=${lat},${lng}&radius=50000&limit=5&order_by=lastUpdated&sort=desc`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('OpenAQ ' + r.status);
      const j = await r.json();
      return json(res, { stations: j.results || [], total: j.meta?.found || 0, source: 'openaq', fetchedAt: new Date().toISOString() });
    } catch (e) {
      return json(res, { stations: [], source: 'mock', error: e.message });
    }
  }

  // === INDIA CPCB AIR QUALITY (data.gov.in / OGD India) ===
  // Free with API key from data.gov.in. Without key: returns deterministic illustrative AQI for the nearest documented Indian city.
  if (p === '/api/air-india' && req.method === 'GET') {
    const lat = +q.lat, lng = +q.lng;
    const key = ENV.DATA_GOV_IN_KEY;
    try {
      if (key) {
        // Resource ID for "Real time Air Quality Index from various locations" — Live CPCB feed
        const url = `https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69?api-key=${key}&format=json&limit=80`;
        const r = await fetch(url);
        if (!r.ok) throw new Error('CPCB ' + r.status);
        const j = await r.json();
        // Filter to nearest 5 stations within ~250km
        const stations = (j.records || []).map(rec => {
          const stLat = parseFloat(rec.latitude || rec.lat || 0);
          const stLng = parseFloat(rec.longitude || rec.lng || 0);
          const distKm = Math.round(Math.abs(stLat - lat) * 111 + Math.abs(stLng - lng) * 111);
          return { ...rec, distKm };
        }).filter(s => s.distKm < 400).sort((a, b) => a.distKm - b.distKm).slice(0, 5);
        return json(res, { stations, count: stations.length, source: 'cpcb-data-gov-in', fetchedAt: new Date().toISOString() });
      }
    } catch (e) { console.warn('[cpcb] fetch failed', e.message); }
    // Deterministic fallback — based on grove's state-district documented AQI patterns
    const seed = (lat * 1000 + lng * 100) | 0;
    const mockPm25 = 30 + (Math.abs(seed) % 60);
    return json(res, {
      stations: [
        { station: 'Nearest CPCB station (illustrative)', city: 'Patna/Ranchi area', state: lat > 24 ? 'Bihar' : 'Jharkhand', pm25: mockPm25, pm10: mockPm25 + 18, no2: 22, so2: 9, co: 1.1, ozone: 31, aqi: Math.round(mockPm25 * 1.7), category: mockPm25 > 60 ? 'Poor' : mockPm25 > 35 ? 'Moderate' : 'Satisfactory', lastUpdate: new Date().toISOString(), distKm: 12 }
      ],
      count: 1, source: 'mock', note: 'Set DATA_GOV_IN_KEY in .env for live CPCB data',
      docs: 'https://data.gov.in/catalog/real-time-air-quality-index'
    });
  }

  // === IUCN Red List — species conservation status ===
  // Free token (non-commercial) from https://api.iucnredlist.org/
  if (p === '/api/iucn' && req.method === 'GET') {
    const name = (q.name || '').trim();
    if (!name) return json(res, { error: 'name required' }, 400);
    const token = ENV.IUCN_TOKEN;
    try {
      if (token) {
        const url = `https://apiv3.iucnredlist.org/api/v3/species/${encodeURIComponent(name)}?token=${token}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error('IUCN ' + r.status);
        const j = await r.json();
        const rec = (j.result || [])[0];
        if (!rec) return json(res, { name, status: null, source: 'iucn', note: 'not in IUCN database' });
        return json(res, { name: rec.scientific_name, category: rec.category, populationTrend: rec.population_trend, assessmentYear: rec.assessment_date?.slice(0,4), source: 'iucn-redlist' });
      }
    } catch (e) { console.warn('[iucn] failed', e.message); }
    // Fallback — known status for documented species
    const known = { 'Shorea robusta': 'LC', 'Madhuca longifolia': 'LC', 'Diospyros melanoxylon': 'NT', 'Schleichera oleosa': 'LC', 'Buchanania lanzan': 'LC', 'Aegle marmelos': 'NT', 'Terminalia tomentosa': 'LC', 'Ficus religiosa': 'LC', 'Ficus benghalensis': 'LC', 'Leptoptilos dubius': 'EN', 'Wallago attu': 'NT', 'Lutra perspicillata': 'VU', 'Euryale ferox': 'LC' };
    const cat = known[name] || 'NE';
    return json(res, { name, category: cat, source: 'mock', note: 'Set IUCN_TOKEN in .env for live data', docs: 'https://api.iucnredlist.org/' });
  }

  // === ISRO Bhuvan WMS tile proxy (bypasses CORS that breaks direct browser access) ===
  if (p.startsWith('/api/bhuvan-tile') && req.method === 'GET') {
    const lat = +q.lat || 0, lng = +q.lng || 0, z = +q.z || 0, x = +q.x || 0, y = +q.y || 0;
    const layer = q.layer || 'india3';
    // Convert XYZ tile to WMS bbox (Web Mercator)
    const n = Math.pow(2, z);
    const lonL = (x / n) * 360 - 180;
    const lonR = ((x+1) / n) * 360 - 180;
    const latT = Math.atan(Math.sinh(Math.PI * (1 - 2*y/n))) * 180/Math.PI;
    const latB = Math.atan(Math.sinh(Math.PI * (1 - 2*(y+1)/n))) * 180/Math.PI;
    const bbox = [lonL, latB, lonR, latT].join(',');
    const url = `https://bhuvan-vec1.nrsc.gov.in/bhuvan/wms?service=WMS&version=1.1.1&request=GetMap&layers=${encodeURIComponent(layer)}&styles=&srs=EPSG:4326&bbox=${bbox}&width=256&height=256&format=image/png&transparent=true`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'SARNA-NET/1.0' } });
      if (!r.ok) {
        res.writeHead(204); res.end(); return;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
      return;
    } catch (e) {
      res.writeHead(204); res.end(); return;
    }
  }

  // === eBird — bird observations near coordinates ===
  // Free token from https://ebird.org/api/keygen — 1000 reqs/day
  if (p === '/api/ebird' && req.method === 'GET') {
    const lat = +q.lat, lng = +q.lng, radius = +q.radiusKm || 25;
    const token = ENV.EBIRD_TOKEN;
    try {
      if (token) {
        const url = `https://api.ebird.org/v2/data/obs/geo/recent?lat=${lat}&lng=${lng}&dist=${radius}&maxResults=20&sort=date`;
        const r = await fetch(url, { headers: { 'x-ebirdapitoken': token } });
        if (!r.ok) throw new Error('eBird ' + r.status);
        const j = await r.json();
        return json(res, {
          birds: (j || []).map(b => ({ name: b.sciName, vernacular: b.comName, count: b.howMany, date: b.obsDt, location: b.locName, location_id: b.locId, lat: b.lat, lng: b.lng })),
          total: (j || []).length, source: 'ebird', fetchedAt: new Date().toISOString()
        });
      }
    } catch (e) { console.warn('[ebird] failed', e.message); }
    // Fallback — note no live data, point user to GBIF endpoint already in app
    return json(res, { birds: [], source: 'mock', note: 'Set EBIRD_TOKEN in .env for live data. Free at https://ebird.org/api/keygen', alternative: '/api/birds uses GBIF (free, no key)' });
  }

  return err(res, 404, 'API endpoint not found');
}

// ─────────────────────────────────────────────────────
//  Server
// ─────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.method.padEnd(5)} ${req.url}`);
  try {
    if (req.url.startsWith('/api/')) return await handleAPI(req, res);
    return await serveStatic(req, res);
  } catch (e) {
    console.error('Error:', e);
    err(res, 500, e.message);
  }
});

// Ensure data dir exists
import { mkdir, writeFile as fsWriteFile, stat as fsStat } from 'node:fs/promises';
try { await mkdir(join(__dirname, 'data'), { recursive: true }); } catch {}

// ============== STORY IMAGE CACHE — downloads on first boot ==============
// Each slot has multiple Wikipedia candidates. Tries each in order until one works.
const STORY_IMAGE_TARGETS = {
  'ch1-sacred-grove': ['Sacred_groves_of_India','Sacred_grove','Mawphlang_sacred_grove'],
  'ch1-sal-tree':     ['Shorea_robusta','Sal_forest'],
  'ch1-sarna':        ['Sarnaism','Sarna_(religion)','Sarna_Sthal'],
  'ch2-santhal':      ['Santal_people','Santhal_people','Santali_language'],
  'ch2-munda':        ['Munda_people','Munda_languages','Birsa_Munda'],
  'ch2-sarhul':       ['Sarhul','Karam_(festival)'],
  'ch3-saranda':      ['Saranda_Forest','Saranda_forest','West_Singhbhum_district'],
  'ch3-deforestation':['Deforestation_in_India','Forest_cover_in_India','Logging','Tropical_deforestation','Illegal_logging','Forest_dieback','Slash-and-burn'],
  'ch3-birhor':       ['Birhor_people','Birhor_language','Particularly_Vulnerable_Tribal_Groups'],
  'ch4-kabartal':     ['Kabartal_Wetland','Kanwar_Lake','Begusarai_district'],
  'ch4-bihar':        ['Bihar','Geography_of_Bihar','Patna'],
  'ch4-ahar-pyne':    ['Ahar_pyne','Ahar–Pyne_system','Magadha','Falgu_River','Gaya_district','South_Bihar','Tank_irrigation_in_India','Stepwell','Indian_irrigation','Magadh_division'],
  'ch5-sentinel':     ['Sentinel-2','Copernicus_Programme','Satellite_imagery'],
  'ch5-fra':          ['Forest_Rights_Act,_2006','Scheduled_Tribes_and_Other_Traditional_Forest_Dwellers_(Recognition_of_Forest_Rights)_Act,_2006','Tribes_of_India'],
  'ch5-carbon':       ['Carbon_credit','Carbon_offset','Emissions_trading','Climate_change_mitigation','Voluntary_carbon_market','Carbon_finance','Kyoto_Protocol','Carbon_pricing','Carbon_sequestration','Reforestation'],
  'ch6-adivasi':      ['Adivasi','Tribes_of_India','Scheduled_Tribes_in_India']
};
const STORY_IMAGE_DIR = join(__dirname, 'public', 'story-images');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchOneImage(page) {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { headers: { 'User-Agent': 'SARNA-NET/1.0 (contact: dg10911)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  // Try several URL variants for the image, falling back from highest to lowest
  const candidates = [];
  if (j.originalimage?.source) candidates.push(j.originalimage.source);
  if (j.thumbnail?.source) {
    const t = j.thumbnail.source;
    // Wikipedia thumbnail URLs look like .../thumb/.../320px-foo.jpg
    // We try several sizes — some images cap at 800 or 1024
    if (t.includes('/thumb/')) {
      for (const w of [1600, 1280, 1024, 800]) candidates.push(t.replace(/\/\d+px-/, `/${w}px-`));
    }
    candidates.push(t);
  }
  for (const url of candidates) {
    try {
      const ir = await fetch(url, { headers: { 'User-Agent': 'SARNA-NET/1.0 (contact: dg10911)' } });
      if (!ir.ok) continue;
      const buf = Buffer.from(await ir.arrayBuffer());
      const ext = (url.match(/\.(jpe?g|png|svg|webp)(?:[?#]|$)/i)?.[1] || 'jpg').toLowerCase();
      return { buf, ext: ext === 'jpeg' ? 'jpg' : ext, page, title: j.title, url };
    } catch {}
  }
  throw new Error('no usable image url');
}
async function cacheStoryImages(force = false) {
  try { await mkdir(STORY_IMAGE_DIR, { recursive: true }); } catch {}
  const manifestPath = join(STORY_IMAGE_DIR, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
  let downloaded = 0, skipped = 0, failed = 0;
  for (const [key, pages] of Object.entries(STORY_IMAGE_TARGETS)) {
    if (!force && manifest[key]) { skipped++; continue; }
    let got = false;
    for (const page of pages) {
      try {
        const { buf, ext, title, url } = await fetchOneImage(page);
        const filename = `${key}.${ext}`;
        await fsWriteFile(join(STORY_IMAGE_DIR, filename), buf);
        manifest[key] = { file: 'story-images/' + filename, page, title, sizeKB: Math.round(buf.length / 1024), source: url, cachedAt: new Date().toISOString() };
        downloaded++; got = true;
        console.log(`  · cached ${key} (${title}, ${(buf.length / 1024).toFixed(0)}KB) via ${page}`);
        await sleep(350); // throttle to avoid Wikipedia 429
        break;
      } catch (e) {
        console.log(`  · ${key} ← ${page}: ${e.message}`);
        await sleep(500); // back-off on error
      }
    }
    if (!got) {
      // Last-resort: download a deterministic Picsum image to disk so the slot is filled.
      // This guarantees the cache is never empty even if all Wikipedia attempts fail.
      try {
        const url = `https://picsum.photos/seed/sarna-${key}/1920/1080.jpg`;
        const ir = await fetch(url);
        if (ir.ok) {
          const buf = Buffer.from(await ir.arrayBuffer());
          const filename = `${key}.jpg`;
          await fsWriteFile(join(STORY_IMAGE_DIR, filename), buf);
          manifest[key] = { file: 'story-images/' + filename, page: 'picsum-fallback', title: 'Picsum stock photo', sizeKB: Math.round(buf.length / 1024), source: url, cachedAt: new Date().toISOString() };
          downloaded++;
          console.log(`  · cached ${key} (picsum stock, ${(buf.length / 1024).toFixed(0)}KB) — fallback`);
        } else {
          failed++;
        }
      } catch { failed++; }
      await sleep(250);
    }
  }
  try { await fsWriteFile(manifestPath, JSON.stringify(manifest, null, 2)); } catch {}
  console.log(`  → Story images: ${downloaded} downloaded · ${skipped} cached · ${failed} failed`);
  return manifest;
}
// Kick off image cache in background (don't block server boot)
cacheStoryImages().catch(e => console.warn('[story-images] cache failed', e.message));

server.listen(PORT, () => {
  console.log(`\n  ╔════════════════════════════════════════════════════════╗`);
  console.log(`  ║   VANIKA NET · Backend running                          ║`);
  console.log(`  ║                                                        ║`);
  console.log(`  ║   ▸ Open:    http://localhost:${PORT}                      ║`);
  console.log(`  ║   ▸ Health:  http://localhost:${PORT}/api/health           ║`);
  console.log(`  ║                                                        ║`);
  console.log(`  ║   Keys: ${Object.entries(ENV).filter(([k,v]) => v && k.includes('KEY')).length} live · ${Object.entries(ENV).filter(([k,v]) => !v && k.includes('KEY')).length} mock                              ║`);
  console.log(`  ║   Press Ctrl+C to stop                                 ║`);
  console.log(`  ╚════════════════════════════════════════════════════════╝\n`);
});
