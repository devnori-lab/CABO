// @ts-check
import { api } from '../api.js';
import { $, esc, seg, toast } from '../ui.js';

/**
 * @param {HTMLElement} root
 * @param {{ user: import('../api.js').User, go: (path: string) => void, onLogout: () => void }} opts
 */
export function homeScreen(root, { user, go, onLogout }) {
  let bots = Number(localStorage.getItem('cabo.bots') ?? 3) || 3;
  root.innerHTML = `
    <main class="screen home">
      <header class="top">
        <div class="logo sm">CABO</div>
        <div class="me"><b>${esc(user.username)}</b><span>${user.wins} wins · ${user.games} games</span></div>
        <button class="plain sm" data-a="logout">Log out</button>
      </header>
      <section class="panel hero">
        <h2>Play with friends</h2>
        <button class="primary wide" data-a="create">Create a room</button>
        <form class="join"><input name="code" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off" spellcheck="false"><button type="submit">Join</button></form>
      </section>
      <section class="panel">
        <div class="row-h"><h3>Open rooms</h3><span class="live">live</span></div>
        <ul class="rooms"><li class="empty">Looking…</li></ul>
      </section>
      <section class="panel">
        <h3>Practice vs bots</h3>
        <div class="practice"><span class="muted">Opponents</span><div class="bots"></div><button data-a="practice">Play</button></div>
      </section>
      <section class="panel">
        <h3>Top players</h3>
        <ol class="board"><li class="empty">—</li></ol>
      </section>
      <button class="panel creator-link" data-a="creator">
        <span class="avatar sm">A</span>
        <span><b>Creator's corner</b><span class="muted">Who made CABO and how it's built</span></span>
        <span class="chev">→</span>
      </button>
    </main>`;

  const renderBots = () => { $(root, '.bots').innerHTML = seg('bots', [1, 2, 3, 4, 5], bots); };
  renderBots();
  $(root, '.bots').addEventListener('click', (/** @type {any} */ e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    bots = Number(v);
    try { localStorage.setItem('cabo.bots', String(bots)); } catch {}
    renderBots();
  });
  $(root, '[data-a=practice]').addEventListener('click', () => go(`/practice?bots=${bots}`));
  $(root, '[data-a=creator]').addEventListener('click', () => go('/creator'));
  $(root, '[data-a=logout]').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    onLogout();
  });
  $(root, '[data-a=create]').addEventListener('click', async (/** @type {any} */ e) => {
    e.target.disabled = true;
    try {
      go(`/r/${await api.createRoom()}`);
    } catch (/** @type {any} */ ex) {
      toast(ex.message, 'bad');
      e.target.disabled = false;
    }
  });
  const codeInput = $(root, 'input[name=code]');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $(root, '.join').addEventListener('submit', (/** @type {Event} */ e) => {
    e.preventDefault();
    if (codeInput.value.length === 4) go(`/r/${codeInput.value}`);
    else toast('Room codes have 4 letters', 'bad');
  });

  let alive = true;
  const loadRooms = async () => {
    try {
      const rooms = await api.rooms();
      if (!alive) return;
      $(root, '.rooms').innerHTML = rooms.length
        ? rooms.map((r) => `<li><div><b>${esc(r.name)}</b><span class="muted">${esc(r.host_name)} · ${r.players}/${r.max_players}</span></div><button data-code="${r.code}">Join</button></li>`).join('')
        : '<li class="empty">No open rooms right now. Create one and invite friends!</li>';
    } catch {}
  };
  $(root, '.rooms').addEventListener('click', (/** @type {any} */ e) => {
    const code = e.target.closest('button')?.dataset.code;
    if (code) go(`/r/${code}`);
  });
  loadRooms();
  const poll = setInterval(loadRooms, 4000);
  api.leaderboard().then((list) => {
    if (!alive) return;
    $(root, '.board').innerHTML = list.length
      ? list.map((p) => `<li><span>${esc(p.username)}</span><span class="muted">${p.wins} wins · ${p.games} games</span></li>`).join('')
      : '<li class="empty">No games played yet</li>';
  }).catch(() => {});

  return () => {
    alive = false;
    clearInterval(poll);
  };
}
