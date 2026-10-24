// @ts-check
// A room: the waiting lobby (players, settings, chat) and, once the host starts, the table.

import { RoomConn } from '../net.js';
import { Table } from '../table.js';
import { showHowTo } from '../howto.js';
import { $, esc, seg, toast } from '../ui.js';

/**
 * @param {HTMLElement} root  the menu container
 * @param {HTMLElement} tableEl
 * @param {{ code: string, user: import('../api.js').User, go: (path: string) => void }} opts
 */
export function roomScreen(root, tableEl, { code, user, go }) {
  /** @type {any} */
  let room = null;
  /** @type {Table | null} */
  let table = null;
  let tableGame = -1;
  /** @type {{ send: (a: object) => null, onMessage: (m: any) => void }} */
  const adapter = { send: (action) => { conn.send({ t: 'act', action }); return null; }, onMessage: () => {} };
  const isHost = () => room?.hostId === user.id;

  root.innerHTML = `
    <main class="screen room">
      <header class="top">
        <button class="plain sm" data-a="leave">← Leave</button>
        <div class="title"><b class="rname">Room</b><span class="muted status">Connecting…</span></div>
        <button class="plain sm round" data-a="help">?</button>
      </header>
      <section class="panel codecard">
        <span class="muted">Room code</span>
        <div class="code">${esc(code)}</div>
        <button data-a="invite">Copy invite link</button>
      </section>
      <section class="panel">
        <div class="row-h"><h3>Players <span class="count muted"></span></h3><button class="sm" data-a="bot" hidden>+ Add bot</button></div>
        <ul class="members"></ul>
      </section>
      <section class="panel settings"></section>
      <section class="panel chat">
        <h3>Chat</h3>
        <ul class="lines"></ul>
        <form class="say"><input name="text" maxlength="200" placeholder="Say something…" autocomplete="off"><button type="submit">Send</button></form>
      </section>
      <footer class="sticky"><button class="primary wide" data-a="start" hidden>Start game</button><p class="waiting muted" hidden>Waiting for the host to start…</p></footer>
    </main>`;

  const conn = new RoomConn(code, onMessage, (s) => {
    $(root, '.status').textContent = s === 'open' ? 'Connected' : 'Reconnecting…';
    if (s === 'reconnecting') table?.toast('Reconnecting…', 'bad');
  });

  if (!sessionStorage.getItem('cabo.howto')) {
    try { sessionStorage.setItem('cabo.howto', '1'); } catch {}
    showHowTo();
  }

  /** @param {any} msg */
  function onMessage(msg) {
    switch (msg.t) {
      case 'room':
        room = msg.room;
        if (room.status === 'waiting') hideTable();
        renderLobby();
        break;
      case 'game':
        if (!table || msg.gameNo !== tableGame) showTable(msg.gameNo);
        adapter.onMessage({
          events: msg.events,
          view: msg.view,
          deadlines: msg.deadlines.map((/** @type {any} */ d) => ({ key: d.key, ms: d.ms, endsAt: performance.now() + d.endsIn })),
        });
        break;
      case 'chat':
        if (room) {
          room.chat = [...room.chat, msg.line].slice(-40);
          renderChat();
        }
        if (table && msg.line.from !== user.username) table.toast(`${msg.line.from}: ${msg.line.text}`);
        break;
      case 'error':
        if (table) table.toast(msg.msg, 'bad');
        else toast(msg.msg, 'bad');
        break;
      case 'refused':
        toast(msg.msg, 'bad');
        go('/');
        break;
      case 'kicked':
        toast('The host removed you from the room', 'bad');
        go('/');
        break;
    }
  }

  /** @param {number} gameNo */
  function showTable(gameNo) {
    table?.destroy();
    tableGame = gameNo;
    root.hidden = true;
    tableEl.hidden = false;
    table = new Table(tableEl, adapter, {
      get onAgain() { return isHost() ? () => conn.send({ t: 'start' }) : null; },
      onExit: leave,
      onHelp: () => showHowTo(),
      exitLabel: 'Leave',
    });
  }

  function hideTable() {
    if (!table) return;
    table.destroy();
    table = null;
    tableGame = -1;
    tableEl.hidden = true;
    root.hidden = false;
  }

  function leave() {
    conn.send({ t: 'leave' });
    go('/');
  }

  function renderLobby() {
    const host = isHost();
    $(root, '.rname').textContent = room.name;
    $(root, '.count').textContent = `${room.members.length}/${room.settings.maxPlayers}`;
    $(root, '.members').innerHTML = room.members.map((/** @type {any} */ m) => `
      <li>
        <span class="dot ${m.online ? 'on' : ''}"></span>
        <span class="who">${esc(m.name)}${m.bot ? ' <small>bot</small>' : ''}${m.id === room.hostId ? ' <small class="hostb">host</small>' : ''}${m.id === user.id ? ' <small>you</small>' : ''}</span>
        ${host && m.id !== user.id ? `<button class="sm plain" data-kick="${esc(m.id)}">Remove</button>` : ''}
      </li>`).join('');
    const full = room.members.length >= room.settings.maxPlayers;
    const bot = $(root, '[data-a=bot]');
    bot.hidden = !host;
    bot.disabled = full;

    const s = room.settings;
    $(root, '.settings').innerHTML = `
      <h3>Settings ${host ? '' : '<span class="muted">(host decides)</span>'}</h3>
      <div class="setting"><span>Max players</span>${seg('maxPlayers', [2, 3, 4, 5, 6], s.maxPlayers, !host)}</div>
      <div class="setting"><span>Turn timer</span>${seg('turnSeconds', [15, 30, 45, 60], s.turnSeconds, !host, (v) => `${v}s`)}</div>
      <div class="setting"><span>Earliest CABO</span>${seg('minCaboRound', [1, 2, 3], s.minCaboRound, !host, (v) => `round ${v + 1}`)}</div>
      <div class="setting"><span>Listed in open rooms</span>${seg('public', ['yes', 'no'], room.public ? 'yes' : 'no', !host)}</div>`;

    const start = $(root, '[data-a=start]');
    start.hidden = !host;
    start.disabled = room.members.length < 2;
    start.textContent = room.members.length < 2 ? 'Need 2+ players (invite or add a bot)' : 'Start game';
    $(root, '.waiting').hidden = host;
    renderChat();
  }

  function renderChat() {
    const box = $(root, '.lines');
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
    box.innerHTML = room.chat.length
      ? room.chat.map((/** @type {any} */ l) => `<li><b>${esc(l.from)}</b> ${esc(l.text)}</li>`).join('')
      : '<li class="empty">Say hi 👋</li>';
    if (stick) box.scrollTop = box.scrollHeight;
  }

  // ---------- lobby input ----------

  $(root, '[data-a=leave]').addEventListener('click', leave);
  $(root, '[data-a=help]').addEventListener('click', () => showHowTo());
  $(root, '[data-a=bot]').addEventListener('click', () => conn.send({ t: 'addBot' }));
  $(root, '[data-a=start]').addEventListener('click', () => conn.send({ t: 'start' }));
  $(root, '[data-a=invite]').addEventListener('click', async () => {
    const url = `${location.origin}/r/${code}`;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Play CABO with me', url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      }
    } catch {}
  });
  $(root, '.members').addEventListener('click', (/** @type {any} */ e) => {
    const id = e.target.closest('[data-kick]')?.dataset.kick;
    if (id) conn.send({ t: 'kick', id });
  });
  $(root, '.settings').addEventListener('click', (/** @type {any} */ e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || !isHost()) return;
    const name = b.closest('.seg').dataset.name;
    if (name === 'public') conn.send({ t: 'settings', public: b.dataset.v === 'yes' });
    else conn.send({ t: 'settings', settings: { [name]: Number(b.dataset.v) } });
  });
  $(root, '.say').addEventListener('submit', (/** @type {Event} */ e) => {
    e.preventDefault();
    const input = $(root, '.say input');
    if (!input.value.trim()) return;
    conn.send({ t: 'chat', text: input.value });
    input.value = '';
  });

  return () => {
    conn.close();
    hideTable();
  };
}
