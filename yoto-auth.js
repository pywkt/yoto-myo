/**
 * yoto-auth.js — shared OAuth2 (Authorization Code + PKCE) login for the Yoto API.
 *
 * Exports getAccessToken({ reset }) which reuses the cached refresh token in
 * .yoto-token.json, or opens a browser for a one-time sign-in. Also exports api()
 * for authenticated calls against https://api.yotoplay.com.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env; use the shell env */ }

const API = 'https://api.yotoplay.com';
const LOGIN = 'https://login.yotoplay.com';
const REDIRECT_PORT = 8787;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
// Scopes must also be ticked on the client at https://dashboard.yoto.dev.
const SCOPE = [
  'user:content:manage',   // create / update MYO playlists, upload audio
  'user:icons:manage',     // upload 16x16 icons
  'family:devices:view',   // list players
  'family:devices:control',// send player commands (used for linking a card)
  'offline_access',        // refresh tokens
].join(' ');
const CLIENT_ID = process.env.YOTO_CLIENT_ID;
const TOKEN_FILE = path.join(__dirname, '.yoto-token.json');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const log = (...a) => console.log(...a);

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* user can paste the URL */ }
}

function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveToken(obj) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

async function refreshAccessToken(refresh_token) {
  const res = await fetch(`${LOGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  saveToken({ refresh_token: data.refresh_token || refresh_token, scope: data.scope }); // refresh tokens rotate
  return data.access_token;
}

function waitForCallbackCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font:16px system-ui;padding:3rem;text-align:center">' +
        '<h2>Login complete</h2><p>You can close this tab and return to the terminal.</p></body></html>');
      server.close();
      const err = u.searchParams.get('error');
      if (err) return reject(new Error(`${err}: ${u.searchParams.get('error_description') || ''}`));
      if (u.searchParams.get('state') !== expectedState) return reject(new Error('OAuth state mismatch'));
      resolve(u.searchParams.get('code'));
    });
    server.on('error', reject);
    server.listen(REDIRECT_PORT, '127.0.0.1');
  });
}

async function browserLogin() {
  const code_verifier = b64url(crypto.randomBytes(32));
  const code_challenge = b64url(crypto.createHash('sha256').update(code_verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const authUrl = new URL(`${LOGIN}/authorize`);
  authUrl.search = new URLSearchParams({
    audience: API,
    scope: SCOPE,
    response_type: 'code',
    client_id: CLIENT_ID,
    code_challenge,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    state,
  }).toString();

  const codePromise = waitForCallbackCode(state);
  log('\nOpening your browser to sign in to Yoto…');
  log('If it does not open, paste this URL into a browser:\n\n' + authUrl.toString() + '\n');
  openBrowser(authUrl.toString());

  const code = await codePromise;
  const res = await fetch(`${LOGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code_verifier,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  saveToken({ refresh_token: data.refresh_token, scope: data.scope });
  return data.access_token;
}

/** Returns a bearer access token, signing in via the browser if needed. */
async function getAccessToken({ reset = false } = {}) {
  if (!CLIENT_ID) {
    throw new Error('YOTO_CLIENT_ID is not set.\n  Create a public client at https://dashboard.yoto.dev with redirect URL\n  ' +
      REDIRECT_URI + ', then copy .env.example to .env and fill in the client ID.');
  }
  if (reset) { try { fs.unlinkSync(TOKEN_FILE); } catch { /* nothing to reset */ } }
  const saved = loadToken();
  if (saved?.refresh_token) {
    const tok = await refreshAccessToken(saved.refresh_token);
    if (tok) { log('✓ Reused saved Yoto login'); return tok; }
    log('Saved login expired, signing in again…');
  }
  return browserLogin();
}

/** Authenticated JSON call. Throws with the response body on non-2xx. */
async function api(token, method, p, body, extraHeaders = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} failed: HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

/**
 * Prompt on the terminal. One shared readline interface; answers that arrive before a
 * question is asked are queued, so piped input (printf 'a\nb\n' | node ...) works too.
 */
let rl = null;
const pending = [];   // lines received with no question waiting
const waiting = [];   // resolvers for questions with no line yet
function ensureRl() {
  if (rl) return;
  rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => { if (waiting.length) waiting.shift()(line); else pending.push(line); });
  rl.on('close', () => { rl = null; while (waiting.length) waiting.shift()(''); });
}
function ask(question) {
  ensureRl();
  process.stdout.write(question);
  if (pending.length) return Promise.resolve(pending.shift().trim());
  if (!rl) return Promise.resolve('');
  return new Promise((resolve) => waiting.push((line) => resolve(line.trim())));
}
/** Close the prompt so the process can exit. */
function closePrompt() { if (rl) { rl.close(); rl = null; } }

module.exports = { API, LOGIN, REDIRECT_URI, SCOPE, getAccessToken, api, ask, closePrompt };
