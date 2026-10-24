// @ts-check
// Router: /            home (or log in)
//         /r/CODE      a room
//         /practice    a local game against bots (no account needed)
//         /creator     about the creator and the tech stack

import { api } from './api.js';
import { LocalHost } from './local.js';
import { Table } from './table.js';
import { showHowTo } from './howto.js';
import { authScreen } from './screens/auth.js';
import { homeScreen } from './screens/home.js';
import { roomScreen } from './screens/room.js';
import { creatorScreen } from './screens/creator.js';
import { toast } from './ui.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const tableEl = /** @type {HTMLElement} */ (document.getElementById('table'));

/** @type {import('./api.js').User | null | undefined} undefined = not checked yet */
let user;
/** @type {(() => void) | null} */
let cleanup = null;
/** @type {any} */
let wakeLock = null;

/** @param {string} path @param {boolean} [replace] */
function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}
window.addEventListener('popstate', () => route());

function keepAwake() {
  /** @type {any} */ (navigator).wakeLock?.request('screen').then((/** @type {any} */ l) => { wakeLock = l; }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !tableEl.hidden) keepAwake();
});

async function route() {
  cleanup?.();
  cleanup = null;
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  app.hidden = false;
  tableEl.hidden = true;
  const path = location.pathname;

  if (path === '/creator') {
    cleanup = creatorScreen(app, { go });
    return;
  }
  if (path === '/practice') {
    cleanup = practice(Number(new URLSearchParams(location.search).get('bots')) || 3);
    return;
  }

  if (user === undefined) {
    try {
      user = await api.me();
    } catch {
      user = null;
      toast('Cannot reach the server', 'bad');
    }
  }
  if (!user) {
    cleanup = authScreen(app, { go, onDone: (u) => { user = u; route(); } });
    return;
  }

  const room = /^\/r\/([A-Za-z]{4})$/.exec(path);
  if (room) {
    keepAwake();
    cleanup = roomScreen(app, tableEl, { code: room[1].toUpperCase(), user, go });
    return;
  }
  if (path !== '/') return go('/', true);
  // Refresh stats each time we come home.
  api.me().then((u) => { if (u) user = u; }).catch(() => {});
  cleanup = homeScreen(app, { user, go, onLogout: () => { user = null; go('/'); } });
}

/** @param {number} bots */
function practice(bots) {
  /** @type {{ host: LocalHost, table: Table } | null} */
  let game = null;
  const exit = () => go('/');
  const start = () => {
    stop();
    app.hidden = true;
    tableEl.hidden = false;
    keepAwake();
    const host = new LocalHost({ bots, name: user?.username ?? 'You' });
    const table = new Table(tableEl, host, { onAgain: start, onExit: exit, onHelp: () => showHowTo() });
    game = { host, table };
    host.start();
  };
  const stop = () => {
    game?.host.stop();
    game?.table.destroy();
    game = null;
  };
  app.innerHTML = '';
  showHowTo({ button: 'Start game', onClose: start });
  return () => {
    stop();
    wakeLock?.release().catch(() => {});
  };
}

route();
