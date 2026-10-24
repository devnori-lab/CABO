// @ts-check
// CABO rules engine. Pure: apply(state, action) never mutates its input and does no I/O.
// Timers live outside the engine: the server dispatches *Timeout actions (see timers()).
// RULES.md is the spec; keep the two in sync.

import { newDeck, powerOf, value } from './cards.js';
import { makeRng, randInt, shuffle } from './rng.js';

/** @typedef {import('./cards.js').Card} Card */
/** @typedef {import('./cards.js').PowerKind} PowerKind */

/**
 * @typedef {{ name: string, slots: (number | null)[], ready: boolean, skipNext: boolean }} Player
 * @typedef {{ kind: PowerKind, looked?: { slot: number, owner: number, ownerSlot: number, ids: number[] } }} Power
 * @typedef {{ id: number, player: number, stage: 'draw' | 'drawn' | 'power', drawn: number | null, power: Power | null }} Turn
 * @typedef {{ rank: number, claimedBy: number | null }} ThrowWindow
 * @typedef {{ holder: number, owner: number, slot: number, id: number }} ThrowRight
 * @typedef {{ thrower: number, owner: number, slot: number }} PendingGive
 * @typedef {{ scores: number[], winners: number[], hands: ({ id: number } & Card | null)[][] }} Result
 * @typedef {{
 *   settings: typeof DEFAULT_SETTINGS,
 *   rng: number[],
 *   phase: 'shuffle' | 'peek' | 'play' | 'grace' | 'ended',
 *   players: Player[],
 *   cards: Record<number, Card>,
 *   nextId: number,
 *   deck: Card[],
 *   discard: number[],
 *   starter: number,
 *   turn: Turn | null,
 *   turnSeq: number,
 *   turnsDone: number,
 *   window: ThrowWindow | null,
 *   throwRights: ThrowRight[],
 *   gives: PendingGive[],
 *   cabo: { first: number | null, endAfter: number | null, callers: number[] },
 *   result: Result | null,
 * }} State
 * @typedef {{ type: string, audience?: number[], secret?: object, [k: string]: any }} GameEvent
 * @typedef {{ type: string, player?: number, [k: string]: any }} Action
 */

export const DEFAULT_SETTINGS = {
  minCaboRound: 1,
  turnMs: 30_000,
  shuffleMs: 10_000,
  peekMs: 5_000,
  revealMs: 3_000,
  giveMs: 8_000,
  graceMs: 3_000,
};

export class RuleError extends Error {}

/** @param {string} msg @returns {never} */
const fail = (msg) => {
  throw new RuleError(msg);
};

/**
 * @param {{ players: { name: string }[], settings?: Partial<typeof DEFAULT_SETTINGS>, seed: number | number[] }} opts
 * @returns {State}
 */
export function createGame({ players, settings = {}, seed }) {
  if (players.length < 2 || players.length > 6) fail('need 2–6 players');
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!(s.minCaboRound >= 1)) fail('minCaboRound must be ≥ 1');
  const rng = makeRng(seed);
  /** @type {State} */
  const st = {
    settings: s,
    rng,
    phase: 'shuffle',
    players: players.map((p) => ({ name: p.name, slots: [], ready: false, skipNext: false })),
    cards: {},
    nextId: 1,
    deck: shuffle(newDeck(), rng),
    discard: [],
    starter: randInt(rng, players.length),
    turn: null,
    turnSeq: 0,
    turnsDone: 0,
    window: null,
    throwRights: [],
    gives: [],
    cabo: { first: null, endAfter: null, callers: [] },
    result: null,
  };
  for (let i = 0; i < 4; i++) for (const p of st.players) p.slots.push(takeFromDeck(st, []));
  return st;
}

/**
 * @param {State} state
 * @param {Action} action
 * @returns {{ state: State, events: GameEvent[], error?: undefined } | { error: string }}
 */
export function apply(state, action) {
  const st = structuredClone(state);
  /** @type {GameEvent[]} */
  const ev = [];
  try {
    handle(st, action, ev);
  } catch (e) {
    if (e instanceof RuleError) return { error: e.message };
    throw e;
  }
  return { state: st, events: ev };
}

/** @param {State} st @param {Action} a @param {GameEvent[]} ev */
function handle(st, a, ev) {
  const n = st.players.length;
  if (a.player !== undefined && !(Number.isInteger(a.player) && a.player >= 0 && a.player < n)) fail('bad player');
  const p = /** @type {number} */ (a.player);

  switch (a.type) {
    // ---- setup ----
    case 'shuffle': {
      if (st.phase !== 'shuffle') fail('not shuffling');
      if (st.players[p].ready) fail('already ready');
      shuffle(st.players[p].slots, st.rng);
      ev.push({ type: 'Shuffled', player: p, slots: [...st.players[p].slots] });
      return;
    }
    case 'ready': {
      if (st.phase !== 'shuffle') fail('not shuffling');
      st.players[p].ready = true;
      ev.push({ type: 'Ready', player: p });
      if (st.players.every((pl) => pl.ready)) startPeek(st, ev);
      return;
    }
    case 'shuffleTimeout': {
      if (st.phase !== 'shuffle') fail('stale timeout');
      startPeek(st, ev);
      return;
    }
    case 'peekTimeout': {
      if (st.phase !== 'peek') fail('stale timeout');
      st.phase = 'play';
      const id = /** @type {number} */ (takeFromDeck(st, ev));
      st.discard.push(id);
      openWindow(st, id);
      ev.push({ type: 'Flipped', card: pub(st, id) });
      beginTurn(st, ev, st.starter);
      return;
    }

    // ---- turn ----
    case 'cabo': {
      const t = requireTurn(st, p, 'draw');
      if (st.cabo.callers.includes(p)) fail('already called');
      if (st.cabo.first === null) {
        if (st.turnsDone < st.settings.minCaboRound * n) fail('too early to call CABO');
        st.cabo.first = p;
        st.cabo.endAfter = (p - 1 + n) % n;
      }
      st.cabo.callers.push(p);
      ev.push({ type: 'Cabo', player: p, first: st.cabo.first === p, turnId: t.id });
      return;
    }
    case 'draw': {
      const t = requireTurn(st, p, 'draw');
      const id = takeFromDeck(st, ev);
      if (id === null) {
        ev.push({ type: 'DeckEmpty' });
        endTurn(st, ev);
        return;
      }
      t.drawn = id;
      t.stage = 'drawn';
      ev.push({ type: 'Drew', player: p, id, audience: [p], secret: { card: pub(st, id) } });
      return;
    }
    case 'replace': {
      const t = requireTurn(st, p, 'drawn');
      const slots = st.players[p].slots;
      const old = slots[a.slot];
      if (old == null) fail('empty slot');
      slots[a.slot] = t.drawn;
      st.discard.push(old);
      openWindow(st, old);
      ev.push({ type: 'Replaced', player: p, slot: a.slot, id: t.drawn, card: pub(st, old) });
      endTurn(st, ev);
      return;
    }
    case 'discard': {
      const t = requireTurn(st, p, 'drawn');
      const id = /** @type {number} */ (t.drawn);
      t.drawn = null;
      st.discard.push(id);
      openWindow(st, id);
      ev.push({ type: 'Discarded', player: p, card: pub(st, id) });
      const kind = powerOf(st.cards[id]);
      if (kind && hasPowerTarget(st, p, kind)) {
        t.stage = 'power';
        t.power = { kind };
        ev.push({ type: 'PowerStart', player: p, kind });
      } else {
        endTurn(st, ev);
      }
      return;
    }
    case 'peek': {
      const t = requireTurn(st, p, 'power');
      const kind = t.power?.kind;
      if (kind === 'peekOwn' && a.owner !== p) fail('peek one of your own cards');
      if (kind === 'peekOther' && a.owner === p) fail("peek an opponent's card");
      if (kind !== 'peekOwn' && kind !== 'peekOther') fail('wrong power');
      const id = cardAt(st, a.owner, a.slot);
      ev.push({ type: 'Peeked', player: p, owner: a.owner, slot: a.slot, audience: [p], secret: { card: pub(st, id) } });
      endTurn(st, ev);
      return;
    }
    case 'swap': {
      const t = requireTurn(st, p, 'power');
      if (t.power?.kind !== 'swap') fail('wrong power');
      checkSwapTarget(st, p, a.owner);
      cardAt(st, p, a.slot);
      cardAt(st, a.owner, a.ownerSlot);
      swapCards(st, p, a.slot, a.owner, a.ownerSlot, ev);
      endTurn(st, ev);
      return;
    }
    case 'kingLook': {
      const t = requireTurn(st, p, 'power');
      if (t.power?.kind !== 'king' || t.power.looked) fail('wrong power');
      if (a.owner === p) fail("pick an opponent's card");
      const mine = cardAt(st, p, a.slot);
      const theirs = cardAt(st, a.owner, a.ownerSlot);
      t.power.looked = { slot: a.slot, owner: a.owner, ownerSlot: a.ownerSlot, ids: [mine, theirs] };
      ev.push({
        type: 'KingLook', player: p, slot: a.slot, owner: a.owner, ownerSlot: a.ownerSlot,
        audience: [p], secret: { mine: pub(st, mine), theirs: pub(st, theirs) },
      });
      return;
    }
    case 'kingSwap': {
      const t = requireTurn(st, p, 'power');
      const look = t.power?.looked;
      if (t.power?.kind !== 'king' || !look) fail('look first');
      if (a.swap) {
        checkSwapTarget(st, p, look.owner);
        // Either card may have been thrown away while we were deciding.
        const intact = st.players[p].slots[look.slot] === look.ids[0]
          && st.players[look.owner].slots[look.ownerSlot] === look.ids[1];
        if (!intact) fail('those cards have moved');
        swapCards(st, p, look.slot, look.owner, look.ownerSlot, ev);
      }
      endTurn(st, ev);
      return;
    }
    case 'skipPower': {
      requireTurn(st, p, 'power');
      endTurn(st, ev);
      return;
    }
    case 'turnTimeout': {
      const t = st.turn;
      if (st.phase !== 'play' || !t || t.id !== a.turnId) fail('stale timeout');
      ev.push({ type: 'TimedOut', player: t.player });
      if (t.stage === 'draw') t.drawn = takeFromDeck(st, ev);
      if (t.drawn !== null) {
        const id = t.drawn;
        t.drawn = null;
        st.discard.push(id);
        openWindow(st, id);
        ev.push({ type: 'Discarded', player: t.player, card: pub(st, id), auto: true });
      }
      endTurn(st, ev);
      return;
    }

    // ---- throwing ----
    case 'throw': {
      throwCard(st, p, a.owner, a.slot, ev);
      return;
    }
    case 'give': {
      const g = st.gives.find((g) => g.thrower === p);
      if (!g) fail('nothing to give');
      cardAt(st, p, a.slot);
      give(st, g, a.slot, ev);
      return;
    }
    case 'giveTimeout': {
      const g = st.gives.find((g) => g.thrower === p);
      if (!g) fail('stale timeout');
      autoGive(st, g, ev);
      return;
    }
    case 'graceTimeout': {
      if (st.phase !== 'grace') fail('stale timeout');
      for (const g of [...st.gives]) autoGive(st, g, ev);
      st.phase = 'ended';
      st.result = score(st);
      ev.push({ type: 'GameOver', result: st.result });
      return;
    }
    default:
      fail(`unknown action ${a.type}`);
  }
}

// ---------- throwing ----------

/** @param {State} st @param {number} p @param {number} ownerIdx @param {number} slot @param {GameEvent[]} ev */
function throwCard(st, p, ownerIdx, slot, ev) {
  if (st.phase !== 'play' && st.phase !== 'grace') fail('cannot throw now');
  if (st.gives.some((g) => g.thrower === p)) fail('give a card first');
  if (st.turn && st.turn.player === p && st.turn.stage !== 'draw') fail('cannot throw while holding a drawn card');
  const id = cardAt(st, ownerIdx, slot);
  const card = st.cards[id];
  const win = /** @type {ThrowWindow} */ (st.window);
  const matches = card.rank === win.rank;
  // The first correct thrower claims the window and may keep throwing cards of that rank.
  const mayClaim = win.claimedBy === null || win.claimedBy === p;

  if (ownerIdx === p) {
    if (matches && mayClaim) {
      win.claimedBy = p;
      moveToDiscard(st, p, slot, id);
      ev.push({ type: 'Threw', player: p, owner: p, slot, card: pub(st, id) });
    } else if (matches) {
      // Late: someone else claimed this window. The claimer may now throw this revealed card.
      st.throwRights.push({ holder: /** @type {number} */ (win.claimedBy), owner: p, slot, id });
      ev.push({ type: 'Revealed', player: p, owner: p, slot, card: pub(st, id), reason: 'late' });
    } else {
      ev.push({ type: 'Revealed', player: p, owner: p, slot, card: pub(st, id), reason: 'wrong' });
      if (st.turn && st.turn.player === p) {
        ev.push({ type: 'Forfeit', player: p });
        endTurn(st, ev);
      } else {
        st.players[p].skipNext = true;
      }
    }
    return;
  }

  if (ownerIdx === st.cabo.first) fail("CABO caller's cards are locked");
  const ri = st.throwRights.findIndex((r) => r.holder === p && r.owner === ownerIdx && r.slot === slot && r.id === id);
  if (ri >= 0 || (matches && mayClaim)) {
    if (ri >= 0) st.throwRights.splice(ri, 1);
    else win.claimedBy = p;
    moveToDiscard(st, ownerIdx, slot, id);
    ev.push({ type: 'Threw', player: p, owner: ownerIdx, slot, card: pub(st, id) });
    if (st.players[p].slots.some((s) => s !== null)) {
      st.gives.push({ thrower: p, owner: ownerIdx, slot });
      ev.push({ type: 'GiveStart', player: p, owner: ownerIdx, slot });
    }
  } else {
    ev.push({ type: 'Revealed', player: p, owner: ownerIdx, slot, card: pub(st, id), reason: 'wrong' });
    penalty(st, p, ev);
  }
}

/** @param {State} st @param {PendingGive} g @param {number} slot @param {GameEvent[]} ev */
function give(st, g, slot, ev) {
  const from = st.players[g.thrower].slots;
  const id = /** @type {number} */ (from[slot]);
  from[slot] = null;
  const toSlot = place(st.players[g.owner].slots, id, g.slot);
  st.gives.splice(st.gives.indexOf(g), 1);
  // Moving a card invalidates any throw right that pointed at it.
  st.throwRights = st.throwRights.filter((r) => r.id !== id);
  ev.push({ type: 'Gave', player: g.thrower, slot, owner: g.owner, ownerSlot: toSlot, id });
}

/** @param {State} st @param {PendingGive} g @param {GameEvent[]} ev */
function autoGive(st, g, ev) {
  const slot = st.players[g.thrower].slots.findIndex((s) => s !== null);
  if (slot < 0) {
    st.gives.splice(st.gives.indexOf(g), 1);
    return;
  }
  give(st, g, slot, ev);
}

// ---------- helpers ----------

/** @param {State} st @param {GameEvent[]} ev */
function startPeek(st, ev) {
  st.phase = 'peek';
  st.players.forEach((pl, i) => {
    const cards = [2, 3].map((s) => (pl.slots[s] == null ? null : pub(st, /** @type {number} */ (pl.slots[s]))));
    ev.push({ type: 'PeekStart', player: i, slots: [2, 3], audience: [i], secret: { cards } });
  });
}

/** @param {State} st @param {GameEvent[]} ev @param {number} p */
function beginTurn(st, ev, p) {
  st.turn = { id: ++st.turnSeq, player: p, stage: 'draw', drawn: null, power: null };
  ev.push({ type: 'TurnStart', player: p, turnId: st.turn.id });
  if (st.players[p].skipNext) {
    st.players[p].skipNext = false;
    ev.push({ type: 'Skipped', player: p });
    endTurn(st, ev);
  }
}

/** @param {State} st @param {GameEvent[]} ev */
function endTurn(st, ev) {
  const p = /** @type {Turn} */ (st.turn).player;
  st.turnsDone++;
  if (st.cabo.first !== null && p === st.cabo.endAfter) {
    st.phase = 'grace';
    st.turn = null;
    ev.push({ type: 'GraceStart' });
    return;
  }
  beginTurn(st, ev, (p + 1) % st.players.length);
}

/** @param {State} st @param {number} p @param {Turn['stage']} stage */
function requireTurn(st, p, stage) {
  if (st.phase !== 'play' || !st.turn) fail('not in play');
  if (st.turn.player !== p) fail('not your turn');
  if (st.turn.stage !== stage) fail(`not allowed during ${st.turn.stage}`);
  if (st.gives.some((g) => g.thrower === p)) fail('give a card first');
  return st.turn;
}

/** @param {State} st @param {number} p @param {number} owner */
function checkSwapTarget(st, p, owner) {
  if (owner === p) fail("pick an opponent's card");
  if (owner === st.cabo.first) fail("CABO caller's cards are locked");
}

/** @param {State} st @param {number} ownerIdx @param {number} slot */
function cardAt(st, ownerIdx, slot) {
  const id = st.players[ownerIdx]?.slots[slot];
  if (id == null) fail('no card there');
  return id;
}

/** @param {State} st @param {number} p @param {PowerKind} kind */
function hasPowerTarget(st, p, kind) {
  const has = (/** @type {number} */ i) => st.players[i].slots.some((s) => s !== null);
  const opponents = st.players.map((_, i) => i).filter((i) => i !== p);
  if (kind === 'peekOwn') return has(p);
  if (kind === 'peekOther') return opponents.some(has);
  if (kind === 'king') return has(p) && opponents.some(has);
  return has(p) && opponents.some((i) => i !== st.cabo.first && has(i));
}

/** @param {State} st @param {number} a @param {number} sa @param {number} b @param {number} sb @param {GameEvent[]} ev */
function swapCards(st, a, sa, b, sb, ev) {
  const A = st.players[a].slots, B = st.players[b].slots;
  [A[sa], B[sb]] = [B[sb], A[sa]];
  ev.push({ type: 'Swapped', player: a, slot: sa, owner: b, ownerSlot: sb });
}

/** @param {State} st @param {number} id */
function openWindow(st, id) {
  st.window = { rank: st.cards[id].rank, claimedBy: null };
  st.throwRights = [];
}

/** @param {State} st @param {number} ownerIdx @param {number} slot @param {number} id */
function moveToDiscard(st, ownerIdx, slot, id) {
  st.players[ownerIdx].slots[slot] = null;
  st.discard.push(id);
  st.throwRights = st.throwRights.filter((r) => r.id !== id);
}

/** @param {State} st @param {number} p @param {GameEvent[]} ev */
function penalty(st, p, ev) {
  const id = takeFromDeck(st, ev);
  if (id === null) return;
  const slot = place(st.players[p].slots, id);
  ev.push({ type: 'Penalty', player: p, slot, id });
}

/** Put a card into `preferred` if empty, else the first gap, else a new slot. Returns the slot used. */
function place(/** @type {(number|null)[]} */ slots, /** @type {number} */ id, preferred = -1) {
  let slot = preferred >= 0 && slots[preferred] === null ? preferred : slots.indexOf(null);
  if (slot < 0) slot = slots.length;
  slots[slot] = id;
  return slot;
}

/**
 * Cards get a fresh id each time they leave the deck. Ids are handed to clients, so an id
 * must never let anyone recognise a card they saw before it was reshuffled.
 * @param {State} st @param {GameEvent[]} ev @returns {number | null}
 */
function takeFromDeck(st, ev) {
  if (st.deck.length === 0) reshuffle(st, ev);
  const card = st.deck.pop();
  if (!card) return null;
  const id = st.nextId++;
  st.cards[id] = card;
  return id;
}

/** @param {State} st @param {GameEvent[]} ev */
function reshuffle(st, ev) {
  const top = st.discard.pop();
  for (const id of st.discard) {
    st.deck.push(st.cards[id]);
    delete st.cards[id];
  }
  st.discard = top === undefined ? [] : [top];
  shuffle(st.deck, st.rng);
  ev.push({ type: 'Reshuffled', deckCount: st.deck.length });
}

/** @param {State} st @param {number} id */
export const pub = (st, id) => ({ id, ...st.cards[id] });

/** @param {State} st @returns {Result} */
function score(st) {
  const scores = st.players.map((pl) => pl.slots.reduce((sum, id) => sum + (id == null ? 0 : value(st.cards[id])), 0));
  const min = Math.min(...scores);
  const tied = scores.flatMap((s, i) => (s === min ? [i] : []));
  // A tied caller beats every tied non-caller; among tied callers the last one wins.
  // With no caller in the tie, everyone tied shares the win.
  const tiedCallers = st.cabo.callers.filter((c) => tied.includes(c));
  const winners = tiedCallers.length ? [tiedCallers[tiedCallers.length - 1]] : tied;
  const hands = st.players.map((pl) => pl.slots.map((id) => (id == null ? null : pub(st, id))));
  return { scores, winners, hands };
}

/**
 * Timers the server should be running for this state. `key` changes whenever the timer
 * should restart, so the server can diff old vs new keys.
 * @param {State} st @returns {{ key: string, ms: number, action: Action }[]}
 */
export function timers(st) {
  const s = st.settings;
  /** @type {{ key: string, ms: number, action: Action }[]} */
  const out = [];
  if (st.phase === 'shuffle') out.push({ key: 'shuffle', ms: s.shuffleMs, action: { type: 'shuffleTimeout' } });
  if (st.phase === 'peek') out.push({ key: 'peek', ms: s.peekMs, action: { type: 'peekTimeout' } });
  if (st.phase === 'play' && st.turn) {
    out.push({ key: `turn:${st.turn.id}`, ms: s.turnMs, action: { type: 'turnTimeout', turnId: st.turn.id } });
  }
  if (st.phase === 'grace') out.push({ key: 'grace', ms: s.graceMs, action: { type: 'graceTimeout' } });
  for (const g of st.gives) {
    out.push({ key: `give:${g.thrower}:${g.owner}:${g.slot}`, ms: s.giveMs, action: { type: 'giveTimeout', player: g.thrower } });
  }
  return out;
}
