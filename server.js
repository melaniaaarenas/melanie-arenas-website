'use strict';
// Portfolio server: serves the public site and a password-protected editor at /admin.
// No dependencies, only Node built-ins. Start with: npm start
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyPassword } = require('./lib/password');

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 22) {
  console.error(`This site needs Node.js 22 or newer (found ${process.versions.node}). On Ubuntu, install Node 22 from NodeSource or nvm.`);
  process.exit(1);
}

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; /* .env is optional */ }

const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const SEED_FILE = path.join(ROOT, 'content.seed.json');
const CONFIG_FILE = path.join(ROOT, 'config', 'admin.json');

const PORT = Number(process.env.PORT) || 3000;
// Listen on localhost only by default, so the app is reachable only through nginx.
const HOST = process.env.HOST || '127.0.0.1';
// TRUST_PROXY=1: trust X-Forwarded-* / X-Real-IP headers, but only from a proxy on this same machine (nginx).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// COOKIE_SECURE: "auto" (default) marks the session cookie Secure only when the visitor is on HTTPS,
// so login works over plain HTTP now and automatically gets the Secure flag once HTTPS is on.
// "1" = always Secure (HTTPS only), "0" = never.
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
const HSTS_SECONDS = 180 * 24 * 60 * 60;

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;      // stay logged in for 8 hours
const MAX_FAILS = 5;                             // failed logins allowed...
const FAIL_WINDOW_MS = 15 * 60 * 1000;           // ...within 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000;               // then locked for 15 minutes
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const IMG_SRC_RE = /^\/(?:uploads\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)|img\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)|photo\.png)$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// ---------------------------------------------------------------- content

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(CONTENT_FILE)) fs.copyFileSync(SEED_FILE, CONTENT_FILE);
let content = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
let saveQueue = Promise.resolve();

function referencedUploads(obj) {
  return new Set([...JSON.stringify(obj).matchAll(/\/uploads\/([a-f0-9]{32}\.(?:jpg|png|webp|gif))/g)].map((m) => m[1]));
}

function saveContent(next) {
  // .catch first so one failed save (e.g. disk full) doesn't block every later save
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const before = referencedUploads(content);
    const tmp = CONTENT_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
    await fsp.copyFile(CONTENT_FILE, CONTENT_FILE + '.bak').catch(() => {});
    await fsp.rename(tmp, CONTENT_FILE);
    content = next;
    // Photos you removed are deleted from disk right away.
    const after = referencedUploads(next);
    for (const name of before) {
      if (!after.has(name)) await fsp.unlink(path.join(UPLOAD_DIR, name)).catch(() => {});
    }
  });
  return saveQueue;
}

// Uploads that were never saved into the site are cleaned up after a day.
async function sweepUnusedUploads() {
  const used = referencedUploads(content);
  const files = await fsp.readdir(UPLOAD_DIR).catch(() => []);
  for (const name of files) {
    if (used.has(name)) continue;
    const full = path.join(UPLOAD_DIR, name);
    const st = await fsp.stat(full).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) await fsp.unlink(full).catch(() => {});
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function clean(value, depth = 0) {
  if (depth > 8) throw httpError(400, 'Content is nested too deeply.');
  if (typeof value === 'string') {
    if (value.length > 10000) throw httpError(400, 'One of the text fields is too long.');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw httpError(400, 'A list is too long.');
    return value.map((v) => clean(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k) || !/^[A-Za-z0-9_]{1,40}$/.test(k)) throw httpError(400, 'Invalid field name.');
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  throw httpError(400, 'Invalid value in content.');
}

function validateContent(raw) {
  const c = clean(raw);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  for (const key of ['hero', 'about', 'education', 'experience', 'projects', 'skills', 'photos', 'contact']) {
    if (!isObj(c[key])) throw httpError(400, `Missing section: ${key}`);
  }
  const lists = [[c.experience, 'jobs'], [c.projects, 'items'], [c.skills, 'groups'], [c.photos, 'categories']];
  for (const [obj, key] of lists) if (!Array.isArray(obj[key])) throw httpError(400, `${key} must be a list.`);
  if (c.hero.photo && !IMG_SRC_RE.test(c.hero.photo)) throw httpError(400, 'Invalid profile photo.');
  for (const cat of c.photos.categories) {
    if (!isObj(cat) || !Array.isArray(cat.photos)) throw httpError(400, 'Invalid photo category.');
    for (const p of cat.photos) {
      if (!isObj(p) || typeof p.src !== 'string' || !IMG_SRC_RE.test(p.src)) throw httpError(400, 'Invalid photo.');
    }
  }
  return c;
}

// ---------------------------------------------------------------- auth

function getPasswordHash() {
  if (process.env.ADMIN_PASSWORD_HASH) return process.env.ADMIN_PASSWORD_HASH;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).passwordHash || null; } catch { return null; }
}

const sessions = new Map(); // token -> expiry time

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function fromTrustedProxy(req) {
  return TRUST_PROXY && LOOPBACK.has(req.socket.remoteAddress);
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  if (!fromTrustedProxy(req)) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function secureCookie(req) {
  if (COOKIE_SECURE === '1' || COOKIE_SECURE === 'true') return true;
  if (COOKIE_SECURE === '0' || COOKIE_SECURE === 'false') return false;
  return isHttps(req);
}

// "__Host-" cookies must be Secure, so the name depends on whether this request is HTTPS.
function cookieName(req) {
  return secureCookie(req) ? '__Host-sid' : 'sid';
}

function getSession(req) {
  const token = parseCookies(req)[cookieName(req)];
  if (!token) return null;
  const expires = sessions.get(token);
  if (!expires) return null;
  if (expires < Date.now()) { sessions.delete(token); return null; }
  return token;
}

function sessionCookie(req, token, maxAgeSeconds) {
  return [
    `${cookieName(req)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`,
    secureCookie(req) ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

const attempts = new Map(); // ip -> { count, first, lockedUntil }

// The visitor's real IP (used for the login lockout). Behind nginx, use the address nginx itself
// observed: X-Real-IP, or the LAST X-Forwarded-For entry. Earlier entries can be faked by the client.
function clientIp(req) {
  if (fromTrustedProxy(req)) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function lockRemaining(ip) {
  const a = attempts.get(ip);
  return a && a.lockedUntil > Date.now() ? a.lockedUntil - Date.now() : 0;
}

function recordFailure(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.first > FAIL_WINDOW_MS) a = { count: 0, first: now, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILS) a.lockedUntil = now + LOCKOUT_MS;
  attempts.set(ip, a);
  return Math.max(0, MAX_FAILS - a.count);
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, a] of attempts) if (a.lockedUntil < now && now - a.first > FAIL_WINDOW_MS) attempts.delete(ip);
  sweepUnusedUploads();
}, 60 * 60 * 1000).unref();

// Blocks cross-site requests: the custom header can only be sent by our own pages' fetch() calls.
function isSameOrigin(req) {
  if (req.headers['x-requested-with'] !== 'fetch') return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin) {
    const host = (fromTrustedProxy(req) && req.headers['x-forwarded-host']) || req.headers.host;
    try { if (new URL(origin).host !== host) return false; } catch { return false; }
  }
  return true;
}

// ---------------------------------------------------------------- helpers

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...BASE_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) { req.resume(); return reject(httpError(413, 'That file is too large.')); }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'That file is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw httpError(400, 'Invalid JSON.'); }
}

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function safeJsonForHtml(obj) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  return JSON.stringify(obj).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
}

function csp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

async function renderPage(res, file, { admin }) {
  const nonce = crypto.randomBytes(16).toString('base64');
  let html = await fsp.readFile(path.join(PUBLIC_DIR, file), 'utf8');
  html = html
    .replaceAll('{{NONCE}}', nonce)
    .replace('{{ADMIN}}', admin ? '1' : '0')
    .replace('{{DATA}}', () => safeJsonForHtml(content));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp(nonce),
    ...BASE_HEADERS,
  });
  res.end(html);
}

async function serveFile(req, res, baseDir, relPath, cacheControl) {
  const full = path.normalize(path.join(baseDir, relPath));
  if (!full.startsWith(baseDir + path.sep)) return sendText(res, 404, 'Not found');
  const type = MIME[path.extname(full).toLowerCase()];
  if (!type) return sendText(res, 404, 'Not found');
  const st = await fsp.stat(full).catch(() => null);
  if (!st || !st.isFile()) return sendText(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cacheControl, ...BASE_HEADERS });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------- routes

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const wait = lockRemaining(ip);
  if (wait) {
    return sendJson(res, 429, { error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).` },
      { 'Retry-After': String(Math.ceil(wait / 1000)) });
  }
  const body = await readJson(req, 8 * 1024);
  const password = typeof body.password === 'string' ? body.password : '';
  const hash = getPasswordHash();
  if (!hash) return sendJson(res, 503, { error: 'The admin password has not been set up yet. Run: npm run set-password' });

  const ok = password.length > 0 && password.length <= 1024 && (await verifyPassword(password, hash));
  if (!ok) {
    const left = recordFailure(ip);
    await sleep(600);
    if (left === 0) return sendJson(res, 429, { error: `Too many failed attempts. Try again in ${LOCKOUT_MS / 60000} minutes.` });
    return sendJson(res, 401, { error: `Incorrect password. ${left} attempt${left === 1 ? '' : 's'} left before a ${LOCKOUT_MS / 60000}-minute lockout.` });
  }

  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL_MS / 1000) });
}

function handleLogout(req, res) {
  const token = getSession(req);
  if (token) sessions.delete(token);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return sendText(res, 400, 'Bad request'); }
  const method = req.method;

  if (pathname.startsWith('/api/')) {
    if (method !== 'GET' && !isSameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (pathname === '/api/login' && method === 'POST') return handleLogin(req, res);
    if (pathname === '/api/logout' && method === 'POST') return handleLogout(req, res);
    if (pathname === '/api/session' && method === 'GET') return sendJson(res, 200, { admin: !!getSession(req) });
    if (pathname === '/api/content' && method === 'GET') return sendJson(res, 200, content);

    // Everything below requires a logged-in admin.
    if (!getSession(req)) return sendJson(res, 401, { error: 'Please log in again.' });

    if (pathname === '/api/content' && method === 'PUT') {
      const next = validateContent(await readJson(req, MAX_JSON_BYTES));
      await saveContent(next);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/upload' && method === 'POST') {
      const buf = await readBody(req, MAX_UPLOAD_BYTES);
      const ext = sniffImage(buf);
      if (!ext) return sendJson(res, 415, { error: 'Please upload a JPG, PNG, WebP, or GIF image.' });
      const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
      return sendJson(res, 201, { src: `/uploads/${name}` });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');

  const admin = !!getSession(req);
  if (pathname === '/' || pathname === '/index.html') return renderPage(res, 'index.html', { admin });
  if (pathname === '/admin' || pathname === '/admin/') return renderPage(res, admin ? 'admin.html' : 'login.html', { admin });
  if (pathname.startsWith('/uploads/')) {
    return serveFile(req, res, UPLOAD_DIR, pathname.slice('/uploads/'.length), 'public, max-age=31536000, immutable');
  }
  // Page templates are only reachable through the routes above; dotfiles are never served.
  if (/\.html$/i.test(pathname) || pathname.split('/').some((s) => s.startsWith('.'))) return sendText(res, 404, 'Not found');
  return serveFile(req, res, PUBLIC_DIR, pathname, 'public, max-age=3600');
}

const server = http.createServer(async (req, res) => {
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', `max-age=${HSTS_SECONDS}`);
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Portfolio running at http://${shown}:${PORT}  (admin: /admin)`);
  console.log(`  data dir:       ${DATA_DIR}`);
  console.log(`  trust proxy:    ${TRUST_PROXY ? 'yes (nginx on this machine)' : 'no'}`);
  console.log(`  secure cookie:  ${COOKIE_SECURE === 'auto' ? 'auto (Secure on HTTPS requests)' : COOKIE_SECURE}`);
  console.log(`  password from:  ${process.env.ADMIN_PASSWORD_HASH ? 'ADMIN_PASSWORD_HASH env var' : fs.existsSync(CONFIG_FILE) ? 'config/admin.json' : 'NOT SET'}`);
  if (!getPasswordHash()) console.log('\n⚠  No admin password yet. Run:  npm run set-password\n');
});

// pm2 stops/restarts with SIGINT: finish any save in progress before exiting.
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close();
  saveQueue.catch(() => {}).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
