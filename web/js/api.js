// @ts-check

/** @param {string} method @param {string} path @param {object} [body] */
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body && JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

/** @typedef {{ id: string, username: string, games: number, wins: number }} User */

export const api = {
  /** @returns {Promise<User | null>} */
  me: () => call('GET', '/api/me').then((d) => d.user).catch((e) => (e.status === 401 ? null : Promise.reject(e))),
  /** @param {{ username: string, email: string, password: string }} b @returns {Promise<User>} */
  signup: (b) => call('POST', '/api/signup', b).then((d) => d.user),
  /** @param {{ login: string, password: string }} b @returns {Promise<User>} */
  login: (b) => call('POST', '/api/login', b).then((d) => d.user),
  logout: () => call('POST', '/api/logout'),
  /** @returns {Promise<{ code: string, name: string, host_name: string, players: number, max_players: number }[]>} */
  rooms: () => call('GET', '/api/rooms').then((d) => d.rooms),
  /** @returns {Promise<string>} */
  createRoom: (name = '') => call('POST', '/api/rooms', { name, public: true }).then((d) => d.code),
  /** @param {string} code */
  room: (code) => call('GET', `/api/rooms/${code}`),
  /** @returns {Promise<{ username: string, games: number, wins: number }[]>} */
  leaderboard: () => call('GET', '/api/leaderboard').then((d) => d.players),
};
