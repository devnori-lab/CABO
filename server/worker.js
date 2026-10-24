// @ts-check
// HTTP entry point: accounts, room listing, and the WebSocket hand-off to each room's
// Durable Object. Everything else is the static site.

import { createSession, deleteSession, hashPassword, sessionCookie, userFrom, verifyPassword } from './auth.js';

export { Room } from './room.js';

/** @typedef {{ DB: D1Database, ROOMS: DurableObjectNamespace, ASSETS: Fetcher }} Env */

class HttpError extends Error {
  /** @param {number} status @param {string} msg */
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

/** @param {any} body @param {number} [status] @param {HeadersInit} [headers] */
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const LISTING_FRESH_MS = 10 * 60 * 1000;

export default {
  /** @param {Request} req @param {Env} env */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      // Cookies authenticate us, so refuse requests started by other sites.
      const origin = req.headers.get('Origin');
      if (origin && new URL(origin).host !== url.host) throw new HttpError(403, 'bad origin');
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
};

/** @param {Request} req */
async function body(req) {
  try {
    return /** @type {Record<string, any>} */ (await req.json());
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

/** @param {Request} req @param {Env} env */
async function requireUser(req, env) {
  const user = await userFrom(env.DB, req);
  if (!user) throw new HttpError(401, 'Please log in');
  return user;
}

/** @param {Request} req @param {Env} env @param {URL} url */
async function route(req, env, url) {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/signup' && method === 'POST') {
    const { username = '', email = '', password = '' } = await body(req);
    if (!USERNAME.test(username)) throw new HttpError(400, 'Username: 3–16 letters, numbers or _');
    if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      throw new HttpError(400, 'Password must be at least 8 characters');
    }
    const taken = await env.DB.prepare('SELECT username, email FROM users WHERE username = ? OR email = ?')
      .bind(username, email).first();
    if (taken) {
      throw new HttpError(409, String(taken.username).toLowerCase() === username.toLowerCase() ? 'That username is taken' : 'That email already has an account');
    }
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, username, email, pass, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, username, email, await hashPassword(password), Date.now()).run();
    const token = await createSession(env.DB, id);
    return json({ user: { id, username, games: 0, wins: 0 } }, 200, { 'Set-Cookie': sessionCookie(req, token) });
  }

  if (path === '/api/login' && method === 'POST') {
    const { login = '', password = '' } = await body(req);
    /** @type {any} */
    const row = await env.DB.prepare('SELECT id, username, pass, games, wins FROM users WHERE username = ? OR email = ?')
      .bind(String(login).trim(), String(login).trim()).first();
    if (!row || !(await verifyPassword(String(password), row.pass))) throw new HttpError(401, 'Wrong username or password');
    const token = await createSession(env.DB, row.id);
    const { pass, ...user } = row;
    return json({ user }, 200, { 'Set-Cookie': sessionCookie(req, token) });
  }

  if (path === '/api/logout' && method === 'POST') {
    await deleteSession(env.DB, req);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '') });
  }

  if (path === '/api/me' && method === 'GET') {
    return json({ user: await requireUser(req, env) });
  }

  if (path === '/api/leaderboard' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT username, games, wins FROM users WHERE games > 0 ORDER BY wins DESC, games ASC LIMIT 10').all();
    return json({ players: results });
  }

  if (path === '/api/rooms' && method === 'GET') {
    await requireUser(req, env);
    const { results } = await env.DB.prepare(
      `SELECT code, name, host_name, players, max_players FROM rooms
       WHERE status = 'open' AND public = 1 AND players < max_players AND updated_at > ?
       ORDER BY updated_at DESC LIMIT 30`,
    ).bind(Date.now() - LISTING_FRESH_MS).all();
    return json({ rooms: results });
  }

  if (path === '/api/rooms' && method === 'POST') {
    const user = await requireUser(req, env);
    const { name = '', public: isPublic = true } = await body(req);
    const roomName = String(name).trim().slice(0, 32) || `${user.username}'s table`;
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const res = await stub.fetch('https://room/init', {
        method: 'POST',
        body: JSON.stringify({ code, name: roomName, public: !!isPublic, host: { id: user.id, name: user.username } }),
      });
      if (res.status === 409) continue; // code in use
      if (!res.ok) throw new HttpError(500, 'Could not create room');
      return json({ code });
    }
    throw new HttpError(503, 'Could not find a free room code, try again');
  }

  const m = /^\/api\/rooms\/([A-Z]{4})(\/ws)?$/.exec(path);
  if (m) {
    const user = await requireUser(req, env);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    if (m[2]) {
      if (req.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'expected websocket');
      // The room trusts these headers, so build them here rather than passing the client's.
      const headers = new Headers({ Upgrade: 'websocket', 'X-User-Id': user.id, 'X-User-Name': user.username });
      return stub.fetch('https://room/ws', { headers });
    }
    if (method === 'GET') return stub.fetch('https://room/info', { headers: { 'X-User-Id': user.id } });
  }

  throw new HttpError(404, 'not found');
}
