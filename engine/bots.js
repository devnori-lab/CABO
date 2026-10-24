// @ts-check
// Random bots. Not smart: they pick plausible actions (some illegal) so fuzz tests can
// hammer the engine, and so the local table has opponents before real AI exists.

import { next, randInt } from './rng.js';

/** @typedef {import('./game.js').State} State */
/** @typedef {import('./game.js').Action} Action */

/** @param {State} st @param {number[]} rng @returns {Action | null} */
export function randomAction(st, rng) {
  const n = st.players.length;
  const any = () => randInt(rng, n);
  const slotOf = (/** @type {number} */ p) => randInt(rng, Math.max(1, st.players[p].slots.length));
  const throwAny = () => {
    const player = any();
    const owner = next(rng) < 0.6 ? player : any();
    return { type: 'throw', player, owner, slot: slotOf(owner) };
  };

  switch (st.phase) {
    case 'shuffle': {
      const r = next(rng);
      if (r < 0.2) return { type: 'shuffleTimeout' };
      return { type: r < 0.6 ? 'shuffle' : 'ready', player: any() };
    }
    case 'peek':
      return { type: 'peekTimeout' };
    case 'grace':
      return next(rng) < 0.3 ? { type: 'graceTimeout' } : throwAny();
    case 'ended':
      return null;
  }

  const r = next(rng);
  if (st.gives.length && r < 0.3) {
    const g = st.gives[randInt(rng, st.gives.length)];
    return r < 0.05 ? { type: 'giveTimeout', player: g.thrower } : { type: 'give', player: g.thrower, slot: slotOf(g.thrower) };
  }
  if (r < 0.45) return throwAny();
  const t = /** @type {NonNullable<State['turn']>} */ (st.turn);
  if (r < 0.48) return { type: 'turnTimeout', turnId: t.id };

  const p = t.player;
  if (t.stage === 'draw') return { type: next(rng) < 0.08 ? 'cabo' : 'draw', player: p };
  if (t.stage === 'drawn') {
    return next(rng) < 0.5 ? { type: 'discard', player: p } : { type: 'replace', player: p, slot: slotOf(p) };
  }
  if (next(rng) < 0.05) return { type: 'skipPower', player: p };
  let o = any();
  while (o === p) o = any();
  switch (/** @type {NonNullable<typeof t.power>} */ (t.power).kind) {
    case 'peekOwn':
      return { type: 'peek', player: p, owner: p, slot: slotOf(p) };
    case 'peekOther':
      return { type: 'peek', player: p, owner: o, slot: slotOf(o) };
    case 'swap':
      return { type: 'swap', player: p, slot: slotOf(p), owner: o, ownerSlot: slotOf(o) };
    case 'king':
      if (t.power?.looked) return { type: 'kingSwap', player: p, swap: next(rng) < 0.5 };
      return { type: 'kingLook', player: p, slot: slotOf(p), owner: o, ownerSlot: slotOf(o) };
  }
  return null;
}

// ---------- playing bot ----------

/** @typedef {ReturnType<typeof import('./view.js').viewFor>} View */
/** @typedef {{ action: Action, kind: 'setup' | 'turn' | 'react' | 'give' }} Plan */

const UNKNOWN = 6.5; // average card value

/** Human-ish delays per kind of bot move, in ms: [min, max]. */
export const BOT_DELAY = { setup: [900, 3500], turn: [700, 1500], react: [650, 2300], give: [600, 1400] };

/**
 * A bot that plays from one seat's point of view: it only sees that seat's redacted view
 * and events, so it can sit at an online table without cheating. It remembers cards by id
 * and sometimes forgets or misremembers, so it makes human-looking mistakes.
 */
export class Bot {
  /** @param {number} seat @param {{ rng: number[], memory?: number, confusion?: number, caboAt?: number }} opts */
  constructor(seat, { rng, memory = 0.85, confusion = 0.04, caboAt = 5 }) {
    this.seat = seat;
    this.rng = rng;
    this.memory = memory;
    this.confusion = confusion;
    this.caboAt = caboAt;
    /** @type {Map<number, { rank: number, suit: string }>} */
    this.known = new Map();
    /** @type {{ mine: number, theirs: number } | null} */
    this.kingLook = null;
  }

  toJSON() {
    const { seat, rng, memory, confusion, caboAt, kingLook } = this;
    return { seat, rng, memory, confusion, caboAt, kingLook, known: [...this.known] };
  }

  /** @param {ReturnType<Bot['toJSON']>} j */
  static fromJSON(j) {
    const b = new Bot(j.seat, j);
    b.known = new Map(j.known);
    b.kingLook = j.kingLook;
    return b;
  }

  /** @param {{ id: number, rank: number, suit: string } | null | undefined} c @param {boolean} own */
  learn(c, own) {
    if (!c) return;
    if (next(this.rng) > (own ? Math.max(this.memory, 0.95) : this.memory)) return;
    let rank = c.rank;
    if (next(this.rng) < this.confusion) rank = Math.min(13, Math.max(1, rank + (next(this.rng) < 0.5 ? -1 : 1)));
    this.known.set(c.id, { rank, suit: c.suit });
  }

  /** @param {GameEvent} e redacted for this seat */
  observe(e) {
    const me = this.seat;
    switch (e.type) {
      case 'PeekStart': if (e.player === me) for (const c of e.cards ?? []) this.learn(c, true); break;
      case 'Drew': if (e.player === me) this.learn(e.card, true); break;
      case 'Peeked': if (e.player === me) this.learn(e.card, e.owner === me); break;
      case 'KingLook':
        if (e.player === me) {
          this.learn(e.mine, true);
          this.learn(e.theirs, false);
          this.kingLook = { mine: e.mine.id, theirs: e.theirs.id };
        }
        break;
      case 'Revealed': this.learn(e.card, e.owner === me); break;
    }
  }

  /** @param {number | null} id */
  est(id) {
    if (id == null) return -Infinity;
    const c = this.known.get(id);
    if (!c) return UNKNOWN;
    return c.rank === 13 && (c.suit === 'H' || c.suit === 'D') ? -1 : c.rank;
  }

  /** What this bot wants to do now, given its view. The host adds human-like delays. */
  /** @param {View} v @returns {Plan[]} */
  plan(v) {
    const me = this.seat;
    const p = me;
    const mySlots = v.players[me].slots;
    const filled = (/** @type {number} */ o) => v.players[o].slots.flatMap((id, s) => (id == null ? [] : [{ id, s }]));
    const opponents = v.players.map((_, i) => i).filter((i) => i !== me);
    const pick = /** @template T @param {T[]} a */ (a) => a[randInt(this.rng, a.length)];

    if (v.phase === 'shuffle') return v.players[me].ready ? [] : [{ action: { type: 'ready', player: p }, kind: 'setup' }];
    if (v.phase !== 'play' && v.phase !== 'grace') return [];

    if (v.gives.some((g) => g.thrower === me)) {
      const worst = this.worst(filled(me));
      return worst ? [{ action: { type: 'give', player: p, slot: worst.s }, kind: 'give' }] : [];
    }

    /** @type {Plan[]} */
    const out = [];
    const t = v.turn;
    const holding = t && t.player === me && t.stage !== 'draw';
    if (!holding && v.window) {
      const right = v.throwRights.find((r) => r.holder === me);
      const mayClaim = v.window.claimedBy === null || v.window.claimedBy === me;
      const rank = v.window.rank;
      const matchMine = filled(me).filter(({ id }) => this.known.get(id)?.rank === rank);
      const matchTheirs = opponents
        .filter((o) => o !== v.cabo.first)
        .flatMap((o) => filled(o).filter(({ id }) => this.known.get(id)?.rank === rank).map((x) => ({ ...x, o })));
      if (right) out.push({ action: { type: 'throw', player: p, owner: right.owner, slot: right.slot }, kind: 'react' });
      else if (mayClaim && matchMine.length) {
        out.push({ action: { type: 'throw', player: p, owner: me, slot: pick(matchMine).s }, kind: 'react' });
      } else if (mayClaim && matchTheirs.length) {
        const m = pick(matchTheirs);
        out.push({ action: { type: 'throw', player: p, owner: m.o, slot: m.s }, kind: 'react' });
      }
    }

    if (v.phase !== 'play' || !t || t.player !== me) return out;
    const n = v.players.length;

    if (t.stage === 'draw') {
      const mine = filled(me);
      const unknown = mine.filter(({ id }) => !this.known.has(id)).length;
      const sum = mine.reduce((a, { id }) => a + this.est(id), 0);
      const allowed = v.cabo.first === null ? v.turnsDone >= v.settings.minCaboRound * n : !v.cabo.callers.includes(me);
      if (allowed && unknown <= 1 && sum <= this.caboAt) out.push({ action: { type: 'cabo', player: p }, kind: 'turn' });
      else out.push({ action: { type: 'draw', player: p }, kind: 'turn' });
      return out;
    }

    if (t.stage === 'drawn') {
      const d = /** @type {{ id: number, rank: number, suit: string }} */ (t.drawn);
      this.known.set(d.id, { rank: d.rank, suit: d.suit });
      const dv = this.est(d.id);
      const worst = this.worst(filled(me));
      if (worst && dv < this.est(worst.id) - 1) out.push({ action: { type: 'replace', player: p, slot: worst.s }, kind: 'turn' });
      else out.push({ action: { type: 'discard', player: p }, kind: 'turn' });
      return out;
    }

    // Power.
    const skip = { action: { type: 'skipPower', player: p }, kind: /** @type {const} */ ('turn') };
    const theirs = opponents.flatMap((o) => filled(o).map((x) => ({ ...x, o })));
    const swappable = theirs.filter((x) => x.o !== v.cabo.first);
    const unknownOf = (/** @type {{ id: number }[]} */ a) => a.filter(({ id }) => !this.known.has(id));
    const lowest = (/** @type {typeof theirs} */ a) => a.filter(({ id }) => this.known.has(id)).sort((x, y) => this.est(x.id) - this.est(y.id))[0];
    const worst = this.worst(filled(me));
    const power = /** @type {NonNullable<typeof t.power>} */ (t.power);

    switch (power.kind) {
      case 'peekOwn': {
        const u = unknownOf(filled(me));
        out.push(u.length ? { action: { type: 'peek', player: p, owner: me, slot: pick(u).s }, kind: 'turn' } : skip);
        break;
      }
      case 'peekOther': {
        const u = unknownOf(theirs);
        if (!u.length) { out.push(skip); break; }
        const x = pick(u);
        out.push({ action: { type: 'peek', player: p, owner: x.o, slot: x.s }, kind: 'turn' });
        break;
      }
      case 'swap': {
        if (!worst || !swappable.length) { out.push(skip); break; }
        const w = this.est(worst.id);
        const low = lowest(swappable);
        const target = low && this.est(low.id) < w - 2 ? low : w >= 9 && this.known.has(worst.id) ? pick(unknownOf(swappable)) : undefined;
        out.push(target
          ? { action: { type: 'swap', player: p, slot: worst.s, owner: target.o, ownerSlot: target.s }, kind: 'turn' }
          : skip);
        break;
      }
      case 'king': {
        if (power.looked) {
          const look = this.kingLook;
          const lockedOwner = theirs.find((x) => x.id === look?.theirs)?.o === v.cabo.first;
          const intact = look && mySlots.includes(look.mine) && theirs.some((x) => x.id === look.theirs);
          const better = intact && !lockedOwner && this.est(look.theirs) < this.est(look.mine);
          out.push({ action: { type: 'kingSwap', player: p, swap: !!better }, kind: 'turn' });
          break;
        }
        if (!worst || !theirs.length) { out.push(skip); break; }
        const pool = swappable.length ? swappable : theirs;
        const target = lowest(pool) ?? pick(pool);
        out.push({ action: { type: 'kingLook', player: p, slot: worst.s, owner: target.o, ownerSlot: target.s }, kind: 'turn' });
        break;
      }
    }
    return out;
  }

  /** Highest-value card we hold; unknown cards count as average. @param {{ id: number, s: number }[]} mine */
  worst(mine) {
    let best = null;
    for (const x of mine) if (!best || this.est(x.id) > this.est(best.id)) best = x;
    return best;
  }
}
