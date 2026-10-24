import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, apply, timers } from '../engine/game.js';
import { value, powerOf } from '../engine/cards.js';
import { viewFor, eventFor } from '../engine/view.js';
import { randomAction, Bot } from '../engine/bots.js';
import { makeRng, next, randInt } from '../engine/rng.js';

// ---------- helpers ----------

function act(st, action) {
  const r = apply(st, action);
  if (r.error) throw new Error(`${action.type}: ${r.error}`);
  return r;
}
const rejects = (st, action, re) => assert.match(apply(st, action).error ?? '(no error)', re);

function started(n = 3, settings = {}, seed = 1) {
  let st = createGame({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}` })), settings, seed });
  st = act(st, { type: 'shuffleTimeout' }).state;
  return act(st, { type: 'peekTimeout' }).state;
}

/** Make the card at (p, slot) a given rank by trading it with one from the deck (or elsewhere). */
function rig(st, p, slot, rank, suit) {
  const id = st.players[p].slots[slot];
  const want = (c) => c.rank === rank && (!suit || c.suit === suit);
  if (want(st.cards[id])) return;
  const i = st.deck.findIndex(want);
  if (i >= 0) {
    [st.cards[id], st.deck[i]] = [st.deck[i], st.cards[id]];
    return;
  }
  const other = Object.keys(st.cards).find((k) => want(st.cards[k]));
  assert.ok(other, `no ${rank}${suit ?? ''} anywhere`);
  [st.cards[id], st.cards[other]] = [st.cards[other], st.cards[id]];
}
/** Put a given rank on top of the deck. */
function rigTop(st, rank, suit) {
  const want = (c) => c.rank === rank && (!suit || c.suit === suit);
  const i = st.deck.findIndex(want);
  if (i >= 0) {
    st.deck.push(st.deck.splice(i, 1)[0]);
    return;
  }
  const other = Object.keys(st.cards).find((k) => want(st.cards[k]));
  assert.ok(other, `no ${rank}${suit ?? ''} anywhere`);
  [st.cards[other], st.deck[st.deck.length - 1]] = [st.deck.at(-1), st.cards[other]];
}
/** Make the top discard a given rank and reopen its throw window. */
function rigDiscard(st, rank) {
  const id = st.discard.at(-1);
  const i = st.deck.findIndex((c) => c.rank === rank);
  [st.cards[id], st.deck[i]] = [st.deck[i], st.cards[id]];
  st.window = { rank, claimedBy: null };
  st.throwRights = [];
}
/** Current player draws a no-power card and discards it. */
function pass(st) {
  const p = st.turn.player;
  const rank = [2, 3, 4, 5, 6, 1].find((r) => st.deck.some((c) => c.rank === r));
  rigTop(st, rank);
  st = act(st, { type: 'draw', player: p }).state;
  return act(st, { type: 'discard', player: p }).state;
}
const types = (events) => events.map((e) => e.type);
const others = (st, p) => [(p + 1) % st.players.length, (p + 2) % st.players.length];

function countCards(st) {
  const inSlots = st.players.flatMap((p) => p.slots).filter((id) => id !== null);
  const ids = [...inSlots, ...st.discard, ...(st.turn?.drawn != null ? [st.turn.drawn] : [])];
  assert.equal(new Set(ids).size, ids.length, 'duplicate card id');
  assert.equal(ids.length + st.deck.length, 52, 'cards not conserved');
  assert.equal(Object.keys(st.cards).length, ids.length, 'cards map out of sync');
}

// ---------- cards ----------

test('card values and powers', () => {
  assert.equal(value({ rank: 13, suit: 'H' }), -1);
  assert.equal(value({ rank: 13, suit: 'S' }), 13);
  assert.equal(value({ rank: 12, suit: 'D' }), 12);
  assert.equal(value({ rank: 1, suit: 'C' }), 1);
  assert.equal(powerOf({ rank: 13, suit: 'D' }), null);
  assert.equal(powerOf({ rank: 13, suit: 'C' }), 'king');
  assert.equal(powerOf({ rank: 8, suit: 'C' }), 'peekOwn');
  assert.equal(powerOf({ rank: 10, suit: 'C' }), 'peekOther');
  assert.equal(powerOf({ rank: 11, suit: 'C' }), 'swap');
  assert.equal(powerOf({ rank: 6, suit: 'C' }), null);
});

// ---------- setup ----------

test('setup: deal, shuffle, private bottom-row peek, flip, first turn', () => {
  let st = createGame({ players: [{ name: 'a' }, { name: 'b' }], seed: 7 });
  assert.equal(st.phase, 'shuffle');
  assert.ok(st.players.every((p) => p.slots.length === 4));
  st = act(st, { type: 'shuffle', player: 0 }).state;
  st = act(st, { type: 'ready', player: 0 }).state;
  rejects(st, { type: 'shuffle', player: 0 }, /already ready/);
  const r = act(st, { type: 'ready', player: 1 });
  assert.equal(r.state.phase, 'peek');
  const peeks = r.events.filter((e) => e.type === 'PeekStart');
  assert.equal(peeks.length, 2);
  // Player 0 sees their own bottom row, and nothing of player 1's.
  const mine = eventFor(peeks[0], 0), theirs = eventFor(peeks[1], 0);
  assert.equal(mine.cards.length, 2);
  assert.equal(mine.cards[0].id, r.state.players[0].slots[2]);
  assert.equal(theirs.cards, undefined);
  st = act(r.state, { type: 'peekTimeout' }).state;
  assert.equal(st.phase, 'play');
  assert.equal(st.discard.length, 1);
  assert.equal(st.window.rank, st.cards[st.discard[0]].rank);
  assert.equal(st.turn.player, st.starter);
  countCards(st);
});

// ---------- turns ----------

test('replace puts the old card on the discard pile and opens a window', () => {
  let st = started();
  const p = st.turn.player;
  rig(st, p, 0, 9);
  rigTop(st, 3);
  st = act(st, { type: 'draw', player: p }).state;
  const drawn = st.turn.drawn;
  const r = act(st, { type: 'replace', player: p, slot: 0 });
  assert.equal(r.state.players[p].slots[0], drawn);
  assert.equal(r.state.cards[r.state.discard.at(-1)].rank, 9);
  assert.deepEqual(r.state.window, { rank: 9, claimedBy: null });
  assert.equal(r.state.turn.player, (p + 1) % 3);
});

test('powers only trigger when the drawn card is discarded', () => {
  let st = started();
  const p = st.turn.player;
  rig(st, p, 0, 7);
  st = act(st, { type: 'draw', player: p }).state;
  const r = act(st, { type: 'replace', player: p, slot: 0 }); // 7 discarded via replace
  assert.ok(!types(r.events).includes('PowerStart'));
});

test('7/8 peek own card, privately', () => {
  let st = started();
  const p = st.turn.player, [o] = others(st, p);
  rigTop(st, 7);
  st = act(st, { type: 'draw', player: p }).state;
  st = act(st, { type: 'discard', player: p }).state;
  assert.equal(st.turn.stage, 'power');
  rejects(st, { type: 'peek', player: p, owner: o, slot: 0 }, /your own/);
  const r = act(st, { type: 'peek', player: p, owner: p, slot: 1 });
  const ev = r.events.find((e) => e.type === 'Peeked');
  assert.equal(eventFor(ev, p).card.id, st.players[p].slots[1]);
  assert.equal(eventFor(ev, o).card, undefined);
});

test('J/Q blind swap must be own card with an opponent card', () => {
  let st = started();
  const p = st.turn.player, [o] = others(st, p);
  rigTop(st, 11);
  st = act(st, { type: 'draw', player: p }).state;
  st = act(st, { type: 'discard', player: p }).state;
  rejects(st, { type: 'swap', player: p, slot: 0, owner: p, ownerSlot: 1 }, /opponent/);
  const [mine, theirs] = [st.players[p].slots[0], st.players[o].slots[3]];
  const r = act(st, { type: 'swap', player: p, slot: 0, owner: o, ownerSlot: 3 });
  assert.equal(r.state.players[p].slots[0], theirs);
  assert.equal(r.state.players[o].slots[3], mine);
  assert.ok(r.events.every((e) => !e.secret), 'blind swap reveals nothing');
});

test('black K: look at both, then optionally swap; red K has no power', () => {
  let st = started();
  const p = st.turn.player, [o] = others(st, p);
  rigTop(st, 13, 'S');
  st = act(st, { type: 'draw', player: p }).state;
  st = act(st, { type: 'discard', player: p }).state;
  rejects(st, { type: 'kingSwap', player: p, swap: true }, /look first/);
  const r = act(st, { type: 'kingLook', player: p, slot: 0, owner: o, ownerSlot: 0 });
  const seen = eventFor(r.events[0], p);
  assert.equal(seen.mine.id, st.players[p].slots[0]);
  assert.equal(seen.theirs.id, st.players[o].slots[0]);
  const s2 = act(r.state, { type: 'kingSwap', player: p, swap: true }).state;
  assert.equal(s2.players[p].slots[0], st.players[o].slots[0]);

  let st2 = started();
  const q = st2.turn.player;
  rigTop(st2, 13, 'H');
  st2 = act(st2, { type: 'draw', player: q }).state;
  const r2 = act(st2, { type: 'discard', player: q });
  assert.ok(!types(r2.events).includes('PowerStart'));
});

test('turn timeout auto-draws and discards without using the power', () => {
  let st = started();
  const p = st.turn.player;
  rigTop(st, 9);
  const r = act(st, { type: 'turnTimeout', turnId: st.turn.id });
  assert.ok(!types(r.events).includes('PowerStart'));
  assert.equal(r.state.cards[r.state.discard.at(-1)].rank, 9);
  assert.equal(r.state.turn.player, (p + 1) % 3);
  rejects(r.state, { type: 'turnTimeout', turnId: st.turn.id }, /stale/);
});

// ---------- throwing ----------

test('correct own throw; second matching throw is late, revealed, and gives the first thrower a throw right', () => {
  let st = started();
  const p = st.turn.player, [a, b] = others(st, p);
  rigDiscard(st, 5);
  rig(st, a, 0, 5);
  rig(st, b, 1, 5);
  st = act(st, { type: 'throw', player: a, owner: a, slot: 0 }).state;
  assert.equal(st.players[a].slots[0], null);
  assert.equal(st.window.claimedBy, a);

  const lateId = st.players[b].slots[1];
  const r = act(st, { type: 'throw', player: b, owner: b, slot: 1 });
  assert.equal(r.events[0].reason, 'late');
  assert.equal(r.state.players[b].slots[1], lateId, 'card goes back');
  assert.equal(r.state.players[b].skipNext, false, 'late throw is not punished');
  assert.deepEqual(r.state.throwRights, [{ holder: a, owner: b, slot: 1, id: lateId }]);
  st = r.state;

  // A third player trying to throw the revealed card is a wrong throw: penalty card.
  const before = st.players[p].slots.length;
  const r3 = act(st, { type: 'throw', player: p, owner: b, slot: 1 });
  assert.equal(r3.events[0].reason, 'wrong');
  assert.equal(r3.state.players[p].slots.filter((s) => s !== null).length, before + 1);

  // The right holder throws it and must give one of their cards back.
  const r4 = act(st, { type: 'throw', player: a, owner: b, slot: 1 });
  assert.equal(r4.state.players[b].slots[1], null);
  assert.deepEqual(r4.state.gives, [{ thrower: a, owner: b, slot: 1 }]);
  rejects(r4.state, { type: 'throw', player: a, owner: a, slot: 1 }, /give a card first/);
  const given = r4.state.players[a].slots[2];
  const r5 = act(r4.state, { type: 'give', player: a, slot: 2 });
  assert.equal(r5.state.players[b].slots[1], given);
  assert.equal(r5.state.players[a].slots[2], null);
  countCards(r5.state);
});

test('the window claimer may throw more cards of the same rank, own or others', () => {
  let st = started();
  const p = st.turn.player, [a, b] = others(st, p);
  rigDiscard(st, 5);
  rig(st, a, 0, 5, 'S');
  rig(st, a, 1, 5, 'H');
  rig(st, b, 2, 5, 'D');
  st = act(st, { type: 'throw', player: a, owner: a, slot: 0 }).state;
  const r = act(st, { type: 'throw', player: a, owner: a, slot: 1 });
  assert.deepEqual(types(r.events), ['Threw'], 'second own card is not late');
  assert.equal(r.state.players[a].slots[1], null);
  // And another player's matching card, with a give.
  const r2 = act(r.state, { type: 'throw', player: a, owner: b, slot: 2 });
  assert.deepEqual(types(r2.events), ['Threw', 'GiveStart']);
  // Anyone else is still late, and the claimer still gets the throw right.
  rig(r2.state, p, 3, 5, 'C');
  const r3 = act(r2.state, { type: 'throw', player: p, owner: p, slot: 3 });
  assert.equal(r3.events[0].reason, 'late');
  // A wrong card from the claimer is still punished.
  const r4 = act(r.state, { type: 'throw', player: a, owner: a, slot: 2 });
  if (r.state.cards[r.state.players[a].slots[2]].rank !== 5) assert.equal(r4.events[0].reason, 'wrong');
  countCards(r2.state);
});

test("correct throw of another player's card, then give", () => {
  let st = started();
  const p = st.turn.player, [a, b] = others(st, p);
  rigDiscard(st, 4);
  rig(st, b, 3, 4);
  const r = act(st, { type: 'throw', player: a, owner: b, slot: 3 });
  assert.equal(r.state.players[b].slots[3], null);
  assert.ok(!types(r.events).includes('Penalty'));
  // Timeout gives the first card automatically.
  const firstCard = r.state.players[a].slots[0];
  const r2 = act(r.state, { type: 'giveTimeout', player: a });
  assert.equal(r2.state.players[b].slots[3], firstCard);
});

test("wrong throw of another player's card: revealed, returned, thrower takes a penalty", () => {
  let st = started();
  const p = st.turn.player, [a, b] = others(st, p);
  rigDiscard(st, 4);
  rig(st, b, 0, 6);
  const id = st.players[b].slots[0];
  const r = act(st, { type: 'throw', player: a, owner: b, slot: 0 });
  assert.deepEqual(types(r.events), ['Revealed', 'Penalty']);
  assert.equal(r.events[0].card.rank, 6, 'revealed to everyone');
  assert.equal(r.state.players[b].slots[0], id);
  assert.equal(r.state.players[a].slots.length, 5);
  countCards(r.state);
});

test('wrong own throw before drawing forfeits the turn', () => {
  let st = started();
  const p = st.turn.player;
  rigDiscard(st, 4);
  rig(st, p, 0, 6);
  const r = act(st, { type: 'throw', player: p, owner: p, slot: 0 });
  assert.deepEqual(types(r.events).slice(0, 2), ['Revealed', 'Forfeit']);
  assert.equal(r.state.turn.player, (p + 1) % 3);
  assert.equal(r.state.players[p].slots.length, 4, 'no penalty card');
});

test('wrong own throw out of turn skips your next turn', () => {
  let st = started();
  const p = st.turn.player, [a] = others(st, p);
  rigDiscard(st, 4);
  rig(st, a, 0, 6);
  st = act(st, { type: 'throw', player: a, owner: a, slot: 0 }).state;
  assert.equal(st.players[a].skipNext, true);
  st = pass(st); // p's turn ends; a's turn starts and is skipped immediately
  assert.equal(st.turn.player, (a + 1) % 3, 'a was skipped');
  assert.equal(st.players[a].skipNext, false);
});

test('cannot throw while holding a drawn card or using a power', () => {
  let st = started();
  const p = st.turn.player;
  rigDiscard(st, 4);
  rig(st, p, 0, 4);
  rigTop(st, 7);
  st = act(st, { type: 'draw', player: p }).state;
  rejects(st, { type: 'throw', player: p, owner: p, slot: 0 }, /holding/);
  st = act(st, { type: 'discard', player: p }).state;
  rejects(st, { type: 'throw', player: p, owner: p, slot: 0 }, /holding/);
});

test('others can throw during your turn, even mid-power', () => {
  let st = started();
  const p = st.turn.player, [a] = others(st, p);
  rigTop(st, 7);
  rig(st, a, 0, 7);
  st = act(st, { type: 'draw', player: p }).state;
  st = act(st, { type: 'discard', player: p }).state;
  const r = act(st, { type: 'throw', player: a, owner: a, slot: 0 });
  assert.equal(r.events[0].type, 'Threw');
  assert.equal(r.state.turn.stage, 'power');
});

test('empty slots stay put; penalties fill the first gap', () => {
  let st = started();
  const p = st.turn.player, [a, b] = others(st, p);
  rigDiscard(st, 4);
  rig(st, a, 1, 4);
  st = act(st, { type: 'throw', player: a, owner: a, slot: 1 }).state;
  assert.equal(st.players[a].slots.length, 4);
  assert.equal(st.players[a].slots[1], null);
  rig(st, b, 0, 9);
  const r = act(st, { type: 'throw', player: a, owner: b, slot: 0 });
  assert.notEqual(r.state.players[a].slots[1], null, 'penalty went into the gap');
});

// ---------- CABO ----------

test('CABO: not before round 1, locks the caller, ends after the player before the caller', () => {
  let st = started(3);
  const c = st.turn.player;
  rejects(st, { type: 'cabo', player: c }, /too early/);
  st = pass(pass(pass(st)));
  assert.equal(st.turn.player, c);
  st = act(st, { type: 'cabo', player: c }).state;
  rejects(st, { type: 'cabo', player: c }, /already/);
  st = pass(st); // caller still plays their turn
  const [x, y] = [(c + 1) % 3, (c + 2) % 3];

  // Locked: nobody else can throw or swap the caller's cards.
  rigDiscard(st, 4);
  rig(st, c, 0, 4);
  rejects(st, { type: 'throw', player: x, owner: c, slot: 0 }, /locked/);
  rigTop(st, 12);
  st = act(st, { type: 'draw', player: x }).state;
  st = act(st, { type: 'discard', player: x }).state;
  rejects(st, { type: 'swap', player: x, slot: 0, owner: c, ownerSlot: 0 }, /locked/);
  st = act(st, { type: 'skipPower', player: x }).state;

  // Counter-CABO on y's final turn.
  st = act(st, { type: 'cabo', player: y }).state;
  assert.deepEqual(st.cabo.callers, [c, y]);
  st = pass(st);
  assert.equal(st.phase, 'grace');
  st = act(st, { type: 'graceTimeout' }).state;
  assert.equal(st.phase, 'ended');
  assert.ok(st.result);
});

test('minCaboRound setting', () => {
  let st = started(2, { minCaboRound: 2 });
  st = pass(pass(st));
  rejects(st, { type: 'cabo', player: st.turn.player }, /too early/);
  st = pass(pass(st));
  act(st, { type: 'cabo', player: st.turn.player });
  assert.throws(() => createGame({ players: [{ name: 'a' }, { name: 'b' }], settings: { minCaboRound: 0 }, seed: 1 }));
});

// ---------- scoring ----------

function endWith(hands, callers) {
  let st = started(hands.length);
  st.phase = 'grace';
  st.turn = null;
  st.cabo = { first: callers[0] ?? null, endAfter: null, callers };
  hands.forEach((ranks, p) => {
    ranks.forEach((rank, s) => rig(st, p, s, rank[0], rank[1]));
    st.players[p].slots = st.players[p].slots.map((id, s) => (s < ranks.length ? id : null));
  });
  return act(st, { type: 'graceTimeout' }).state.result;
}

test('scoring: lowest sum wins, red K is -1', () => {
  const r = endWith([[[1, 'S'], [2, 'S']], [[13, 'H'], [3, 'S']], [[5, 'S']]], [0]);
  assert.deepEqual(r.scores, [3, 2, 5]);
  assert.deepEqual(r.winners, [1], 'a lower non-caller beats the caller');
});

test('scoring: ties go to the last caller among the tied', () => {
  const r = endWith([[[3, 'S']], [[3, 'H']], [[3, 'D']]], [0, 2]);
  assert.deepEqual(r.winners, [2]);
  const r2 = endWith([[[3, 'S']], [[3, 'H']], [[9, 'D']]], [0]);
  assert.deepEqual(r2.winners, [0], 'caller beats a tied non-caller');
});

test('scoring: tie with no caller among the tied is a shared win', () => {
  const r = endWith([[[9, 'S']], [[3, 'H']], [[3, 'D']], [[9, 'C']]], [3]);
  assert.deepEqual(r.winners, [1, 2]);
});

// ---------- views ----------

test('views never leak hidden cards', () => {
  let st = started();
  const p = st.turn.player, [o] = others(st, p);
  st = act(st, { type: 'draw', player: p }).state;
  const mine = viewFor(st, p), theirs = viewFor(st, o);
  assert.ok(mine.turn.drawn.rank);
  assert.equal(theirs.turn.drawn.rank, undefined);
  const json = JSON.stringify(theirs);
  assert.ok(!json.includes('"deck"') && !json.includes('"rng"') && !json.includes('"cards"'));
  for (const pl of theirs.players) for (const s of pl.slots) assert.ok(s === null || typeof s === 'number');
});

test('reshuffled cards get fresh ids', () => {
  let st = started(2);
  const seenIds = new Set(st.discard);
  // Empty the deck into the discard pile.
  while (st.deck.length) {
    const id = st.nextId++;
    st.cards[id] = st.deck.pop();
    st.discard.push(id);
    seenIds.add(id);
  }
  const p = st.turn.player;
  const r = act(st, { type: 'draw', player: p });
  assert.ok(types(r.events).includes('Reshuffled'));
  assert.ok(!seenIds.has(r.state.turn.drawn));
  countCards(r.state);
});

test('timers', () => {
  const st = started();
  assert.deepEqual(timers(st).map((t) => t.key), [`turn:${st.turn.id}`]);
});

// ---------- fuzz ----------

test('fuzz: random bots always finish, cards are conserved, views stay redacted', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const rng = makeRng(seed * 7919);
    const n = 2 + (seed % 5);
    let st = createGame({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}` })), seed });
    let steps = 0;
    while (st.phase !== 'ended') {
      assert.ok(++steps < 50_000, `seed ${seed} did not finish`);
      const r = apply(st, randomAction(st, rng));
      if (r.error) continue;
      st = r.state;
      if (st.phase !== 'shuffle' && st.phase !== 'peek') countCards(st);
      if (steps % 25 === 0) {
        for (let v = 0; v < n; v++) {
          const view = viewFor(st, v);
          for (const pl of view.players) for (const s of pl.slots) assert.ok(s === null || typeof s === 'number');
          if (view.turn?.drawn && view.turn.player !== v) assert.equal(view.turn.drawn.rank, undefined);
          for (const e of r.events) if (e.audience && !e.audience.includes(v)) assert.equal(eventFor(e, v).card, undefined);
        }
      }
    }
    assert.equal(st.result.scores.length, n);
  }
});

test('playing bots finish games using only their own views, with few rejected moves', () => {
  let rejected = 0, applied = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rng = makeRng(seed * 104729);
    const n = 2 + (seed % 5);
    let st = createGame({ players: Array.from({ length: n }, (_, i) => ({ name: `B${i}` })), seed });
    const bots = Array.from({ length: n }, (_, i) => new Bot(i, { rng: makeRng(seed * 31 + i) }));
    let steps = 0;
    while (st.phase !== 'ended') {
      assert.ok(++steps < 5_000, `seed ${seed} stalled in ${st.phase}`);
      const plans = bots.flatMap((b) => b.plan(viewFor(st, b.seat)));
      // Take a bot move half the time, otherwise let a timer fire (as if bots were slow).
      const timer = timers(st)[0];
      const action = plans.length && (!timer || next(rng) < 0.5) ? plans[randInt(rng, plans.length)].action : timer?.action;
      assert.ok(action, `seed ${seed}: nothing to do in ${st.phase}`);
      const r = apply(st, action);
      if (r.error) { rejected++; if (process.env.DEBUG) console.log(st.phase, st.turn?.stage, JSON.stringify(action), r.error); continue; }
      applied++;
      st = r.state;
      for (const e of r.events) for (const b of bots) b.observe(eventFor(e, b.seat));
      if (st.phase !== 'shuffle' && st.phase !== 'peek') countCards(st);
    }
  }
  assert.ok(rejected / applied < 0.02, `${rejected} rejected of ${applied}`);
});
