// @ts-check
// One Durable Object per room. It is the single authority for the lobby and the game:
// it holds the hidden state, runs engine timers and bots off one alarm, and sends each
// socket only its own redacted view. Messages are handled one at a time, so the first
// throw to arrive is the first throw that counts.

import { DurableObject } from 'cloudflare:workers';
import { createGame, apply, timers } from '../engine/game.js';
import { viewFor, eventFor } from '../engine/view.js';
import { Bot, BOT_DELAY } from '../engine/bots.js';
import { makeRng } from '../engine/rng.js';

const BOT_NAMES = ['Mira', 'Juno', 'Otto', 'Pia', 'Rex', 'Zed'];
const MAX_CHAT = 40;

/**
 * @typedef {{ id: string, name: string, bot: boolean }} Member
 * @typedef {{ maxPlayers: number, turnSeconds: number, minCaboRound: number }} RoomSettings
 * @typedef {{
 *   code: string, name: string, public: boolean, hostId: string, members: Member[],
 *   settings: RoomSettings, status: 'waiting' | 'playing' | 'ended', gameNo: number,
 *   chat: { from: string, text: string, at: number }[],
 * }} RoomState
 * @typedef {{ key: string, at: number, ms: number, action: any }} Scheduled
 * @typedef {{ state: import('../engine/game.js').State, seats: string[], bots: any[], schedule: Scheduled[] }} GameRecord
 */

const SETTING_CHOICES = {
  maxPlayers: [2, 3, 4, 5, 6],
  turnSeconds: [15, 30, 45, 60],
  minCaboRound: [1, 2, 3],
};

export class Room extends DurableObject {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {RoomState | null} */
    this.room = null;
    /** @type {GameRecord | null} */
    this.game = null;
    /** @type {Bot[]} */
    this.bots = [];
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) ?? null;
      this.game = (await ctx.storage.get('game')) ?? null;
      this.bots = this.game ? this.game.bots.map((b) => Bot.fromJSON(b)) : [];
    });
  }

  // ---------- HTTP (from the Worker only) ----------

  /** @param {Request} req */
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') {
      if (this.room) return new Response('taken', { status: 409 });
      const { code, name, public: isPublic, host } = await req.json();
      this.room = {
        code, name, public: isPublic, hostId: host.id,
        members: [{ id: host.id, name: host.name, bot: false }],
        settings: { maxPlayers: 6, turnSeconds: 30, minCaboRound: 1 },
        status: 'waiting', gameNo: 0, chat: [],
      };
      await this.persist();
      return new Response('ok');
    }

    if (!this.room) return Response.json({ error: 'No room with that code' }, { status: 404 });
    const room = this.room;
    const userId = req.headers.get('X-User-Id') ?? '';

    if (url.pathname === '/info') {
      const member = room.members.some((m) => m.id === userId);
      return Response.json({ code: room.code, name: room.name, status: room.status, players: room.members.length, max: room.settings.maxPlayers, member });
    }

    if (url.pathname === '/ws') {
      const name = req.headers.get('X-User-Name') ?? '?';
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [userId]);
      server.serializeAttachment({ userId });

      const isMember = room.members.some((m) => m.id === userId);
      const refuse = !isMember && (room.status === 'playing' ? 'That game has already started'
        : room.members.length >= room.settings.maxPlayers ? 'That room is full' : null);
      if (refuse) {
        server.send(JSON.stringify({ t: 'refused', msg: refuse }));
        server.close(4000, 'refused');
        return new Response(null, { status: 101, webSocket: client });
      }
      if (!isMember) room.members.push({ id: userId, name, bot: false });
      await this.persist();
      this.broadcastRoom();
      if (this.game) this.sendGame(server, []);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  // ---------- sockets ----------

  /** @param {WebSocket} ws @param {string | ArrayBuffer} raw */
  async webSocketMessage(ws, raw) {
    const room = this.room;
    if (!room || typeof raw !== 'string' || raw.length > 4000) return;
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { userId } = ws.deserializeAttachment();
    const isHost = userId === room.hostId;
    const err = (/** @type {string} */ m) => ws.send(JSON.stringify({ t: 'error', msg: m }));

    switch (msg.t) {
      case 'act': {
        if (!this.game || room.status === 'waiting') return;
        const seat = this.game.seats.indexOf(userId);
        if (seat < 0 || typeof msg.action !== 'object') return;
        const e = this.dispatch({ ...msg.action, player: seat });
        if (e) err(e);
        await this.persist();
        return;
      }
      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 200);
        const me = room.members.find((m) => m.id === userId);
        if (!text || !me) return;
        const line = { from: me.name, text, at: Date.now() };
        room.chat = [...room.chat, line].slice(-MAX_CHAT);
        this.broadcast({ t: 'chat', line });
        await this.persist();
        return;
      }
      case 'settings': {
        if (!isHost || room.status !== 'waiting') return err('Only the host can change settings');
        for (const [k, choices] of Object.entries(SETTING_CHOICES)) {
          if (choices.includes(msg.settings?.[k])) /** @type {any} */ (room.settings)[k] = msg.settings[k];
        }
        if (room.settings.maxPlayers < room.members.length) room.settings.maxPlayers = room.members.length;
        if (typeof msg.public === 'boolean') room.public = msg.public;
        break;
      }
      case 'addBot': {
        if (!isHost || room.status === 'playing') return;
        if (room.members.length >= room.settings.maxPlayers) return err('The room is full');
        const used = new Set(room.members.map((m) => m.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${room.members.length}`;
        room.members.push({ id: `bot:${crypto.randomUUID()}`, name, bot: true });
        break;
      }
      case 'kick': {
        if (!isHost || room.status === 'playing' || msg.id === userId) return;
        room.members = room.members.filter((m) => m.id !== msg.id);
        for (const s of this.ctx.getWebSockets(msg.id)) {
          s.send(JSON.stringify({ t: 'kicked' }));
          s.close(4001, 'kicked');
        }
        break;
      }
      case 'leave': {
        this.removeMember(userId);
        ws.close(4002, 'left');
        break;
      }
      case 'start': {
        if (!isHost) return err('Only the host can start');
        if (room.status === 'playing') return;
        // Players who have gone away don't get dealt in.
        room.members = room.members.filter((m) => m.bot || this.online(m.id));
        if (room.members.length < 2) return err('Need at least 2 players (add a bot?)');
        this.startGame();
        break;
      }
      default:
        return;
    }
    await this.persist();
    this.broadcastRoom();
  }

  /** @param {WebSocket} ws */
  async webSocketClose(ws) {
    const room = this.room;
    if (!room) return;
    const { userId } = ws.deserializeAttachment();
    // A player who closes the tab before the game starts gives up their seat.
    if (room.status !== 'playing' && !this.online(userId, ws)) this.removeMember(userId);
    await this.persist();
    this.broadcastRoom();
  }

  async webSocketError(/** @type {WebSocket} */ ws) {
    await this.webSocketClose(ws);
  }

  /** @param {string} userId @param {WebSocket} [closing] */
  online(userId, closing) {
    return this.ctx.getWebSockets(userId).some((s) => s !== closing && s.readyState === WebSocket.OPEN);
  }

  /** @param {string} userId */
  removeMember(userId) {
    const room = /** @type {RoomState} */ (this.room);
    if (room.status === 'playing') return; // the seat stays; timers play it
    room.members = room.members.filter((m) => m.id !== userId);
    if (room.hostId === userId) {
      const next = room.members.find((m) => !m.bot);
      if (next) room.hostId = next.id;
    }
  }

  // ---------- game ----------

  startGame() {
    const room = /** @type {RoomState} */ (this.room);
    const seed = crypto.getRandomValues(new Uint32Array(4));
    const state = createGame({
      players: room.members.map((m) => ({ name: m.name })),
      settings: { turnMs: room.settings.turnSeconds * 1000, minCaboRound: room.settings.minCaboRound },
      seed: [...seed],
    });
    this.game = { state, seats: room.members.map((m) => m.id), bots: [], schedule: [] };
    this.bots = room.members.flatMap((m, seat) => (m.bot ? [new Bot(seat, { rng: makeRng(seed[0] + seat) })] : []));
    room.status = 'playing';
    room.gameNo++;
    this.reschedule();
    this.broadcastGame([]);
  }

  /** Apply an action from a player, a timer or a bot. Returns an error message if refused. */
  /** @param {any} action */
  dispatch(action) {
    const game = this.game;
    const room = /** @type {RoomState} */ (this.room);
    if (!game) return 'no game';
    const r = apply(game.state, action);
    if (r.error) return r.error;
    game.state = r.state;
    for (const b of this.bots) for (const e of r.events) b.observe(eventFor(e, b.seat));
    const over = r.events.find((e) => e.type === 'GameOver');
    if (over) {
      room.status = 'ended';
      this.ctx.waitUntil(this.recordStats(over.result));
    }
    this.reschedule();
    this.broadcastGame(r.events);
    if (over) this.broadcastRoom();
    return null;
  }

  /** Rebuild the timer + bot schedule from the current state, keeping deadlines that still apply. */
  reschedule() {
    const game = this.game;
    if (!game) return;
    const now = Date.now();
    const old = new Map(game.schedule.map((s) => [s.key, s]));
    /** @type {Scheduled[]} */
    const next = [];
    for (const t of timers(game.state)) {
      next.push(old.get(t.key) ?? { key: t.key, at: now + t.ms, ms: t.ms, action: t.action });
    }
    for (const bot of this.bots) {
      for (const p of bot.plan(viewFor(game.state, bot.seat))) {
        const key = `bot:${bot.seat}:${JSON.stringify(p.action)}`;
        const [lo, hi] = BOT_DELAY[p.kind];
        const ms = lo + Math.random() * (hi - lo);
        next.push(old.get(key) ?? { key, at: now + ms, ms, action: p.action });
      }
    }
    game.schedule = next;
  }

  async alarm() {
    const now = Date.now();
    for (let guard = 0; this.game && guard < 50; guard++) {
      const due = this.game.schedule.filter((s) => s.at <= now + 15).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.game.schedule = this.game.schedule.filter((s) => s !== due);
      // A refused bot move just means the moment passed; the next reschedule re-plans.
      if (this.dispatch(due.action)) this.reschedule();
    }
    await this.persist();
  }

  /** @param {import('../engine/game.js').Result} result */
  async recordStats(result) {
    const game = /** @type {GameRecord} */ (this.game);
    const room = /** @type {RoomState} */ (this.room);
    const stmts = game.seats.flatMap((id, seat) => {
      if (room.members.find((m) => m.id === id)?.bot ?? id.startsWith('bot:')) return [];
      const win = result.winners.includes(seat) ? 1 : 0;
      return [this.env.DB.prepare('UPDATE users SET games = games + 1, wins = wins + ? WHERE id = ?').bind(win, id)];
    });
    if (stmts.length) await this.env.DB.batch(stmts);
  }

  // ---------- persistence ----------

  async persist() {
    const room = this.room;
    if (!room) return;
    if (this.game) this.game.bots = this.bots.map((b) => b.toJSON());
    await this.ctx.storage.put({ room, game: this.game });
    const next = this.game?.schedule.reduce((m, s) => Math.min(m, s.at), Infinity) ?? Infinity;
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();

    const humansOnline = room.members.some((m) => !m.bot && this.online(m.id));
    const status = !humansOnline ? 'empty' : room.status === 'playing' ? 'playing' : 'open';
    this.ctx.waitUntil(
      this.env.DB.prepare(
        `INSERT INTO rooms (code, name, host_name, public, status, players, max_players, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(code) DO UPDATE SET name = ?2, host_name = ?3, public = ?4, status = ?5, players = ?6, max_players = ?7, updated_at = ?8`,
      ).bind(
        room.code, room.name, room.members.find((m) => m.id === room.hostId)?.name ?? '?', room.public ? 1 : 0,
        status, room.members.length, room.settings.maxPlayers, Date.now(),
      ).run().catch((/** @type {any} */ e) => console.error('listing update failed', e)),
    );
  }

  // ---------- sending ----------

  /** @param {any} msg */
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }

  broadcastRoom() {
    const room = this.room;
    if (!room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const { userId } = ws.deserializeAttachment();
      if (!room.members.some((m) => m.id === userId)) continue;
      const payload = {
        t: 'room',
        you: userId,
        room: {
          code: room.code, name: room.name, public: room.public, hostId: room.hostId,
          settings: room.settings, status: room.status, gameNo: room.gameNo, chat: room.chat,
          members: room.members.map((m) => ({ ...m, online: m.bot || this.online(m.id) })),
        },
      };
      try { ws.send(JSON.stringify(payload)); } catch {}
    }
  }

  /** @param {any[]} events */
  broadcastGame(events) {
    for (const ws of this.ctx.getWebSockets()) this.sendGame(ws, events);
  }

  /** @param {WebSocket} ws @param {any[]} events */
  sendGame(ws, events) {
    const game = this.game;
    if (!game) return;
    const { userId } = ws.deserializeAttachment();
    const seat = game.seats.indexOf(userId);
    if (seat < 0) return;
    const now = Date.now();
    const deadlines = game.schedule
      .filter((s) => !s.key.startsWith('bot:'))
      .map((s) => ({ key: s.key, endsIn: s.at - now, ms: s.ms }));
    const msg = {
      t: 'game',
      gameNo: /** @type {RoomState} */ (this.room).gameNo,
      events: events.map((e) => eventFor(e, seat)),
      view: viewFor(game.state, seat),
      deadlines,
    };
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}
