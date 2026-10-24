// @ts-check
// Passwords (PBKDF2-SHA256) and cookie sessions. Only a hash of the session token is stored.

const enc = new TextEncoder();
const ITERATIONS = 100_000; // the Workers runtime caps PBKDF2 at 100k
const SESSION_MS = 30 * 24 * 3600 * 1000;

/** @param {ArrayBuffer | Uint8Array} buf */
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
/** @param {string} s */
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** @param {ArrayBuffer | Uint8Array} buf */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** @param {string} pw @param {Uint8Array} salt @param {number} iterations */
async function derive(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** @param {string} pw */
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(pw, salt, ITERATIONS))}`;
}

/** @param {string} pw @param {string} stored */
export async function verifyPassword(pw, stored) {
  const [, iter, salt, hash] = stored.split('$');
  const got = await derive(pw, unb64(salt), Number(iter));
  const want = unb64(hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ (want[i] ?? 0);
  return diff === 0;
}

/** @param {string} s */
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

/** @param {D1Database} db @param {string} userId */
export async function createSession(db, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + SESSION_MS).run();
  return token;
}

/** @param {Request} req */
function tokenOf(req) {
  const m = /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(req.headers.get('Cookie') ?? '');
  return m ? m[1] : null;
}

/** @param {D1Database} db @param {Request} req */
export async function deleteSession(db, req) {
  const token = tokenOf(req);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

/**
 * @param {D1Database} db @param {Request} req
 * @returns {Promise<{ id: string, username: string, games: number, wins: number } | null>}
 */
export async function userFrom(db, req) {
  const token = tokenOf(req);
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.username, u.games, u.wins FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256(token), Date.now()).first();
}

/** @param {Request} req @param {string} token  Empty token clears the cookie. */
export function sessionCookie(req, token) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  const age = token ? SESSION_MS / 1000 : 0;
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
}
