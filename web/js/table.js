// @ts-check
// The table: renders a redacted view and turns taps/drags into actions. Every card is one
// persistent element keyed by card id, so a view change just moves elements to their new
// spots and the motion comes for free.

import { moveTo } from './motion.js';

const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RATIO = 1.4; // card height / width
const GAP = 0.1; // gap between grid cards, as a fraction of card width
const PEEK_MS = 2500; // how long a power peek stays face up
const DRAW_FOCUS_MS = 1100; // how long a freshly drawn card hangs in front of you
const DOUBLE_TAP_MS = 320;

const POWER_HINT = {
  peekOwn: 'Peek: tap one of your cards',
  peekOther: "Spy: tap an opponent's card",
  swap: 'Blind swap: pick one of yours and one of theirs',
  king: 'King: pick one of yours and one of theirs to look at',
};

const POWER_NAME = { peekOwn: 'peek at own card', peekOther: "spy on someone's card", swap: 'blind swap', king: 'look & swap' };
const SLOT_NAME = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const MAX_LOG = 200;

const vibrate = (/** @type {number | number[]} */ p) => navigator.vibrate?.(p);
/** @param {unknown} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** @param {number} slot */
const slotName = (slot) => SLOT_NAME[slot] ?? `extra #${slot - 3}`;
/** @param {{ rank: number, suit: string } | null | undefined} c */
const cardTag = (c) => (c ? `<b class="cd ${c.suit === 'H' || c.suit === 'D' ? 'red' : ''}">${RANKS[c.rank]}${SUIT[/** @type {'S'} */ (c.suit)]}</b>` : '?');

/** @typedef {{ id: number, rank: number, suit: 'S' | 'H' | 'D' | 'C' }} Face */
/** @typedef {{ owner: number, slot: number }} Loc */
/** @typedef {HTMLElement & { _spot?: import('./motion.js').Spot, _face?: string }} CardEl */

export class Table {
  /**
   * @param {HTMLElement} root
   * @param {{ send: (a: object) => string | null, onMessage: (m: any) => void }} host
   * @param {{ onAgain: (() => void) | null, onExit: () => void, onHelp: () => void, exitLabel?: string }} hooks
   */
  constructor(root, host, hooks) {
    this.root = root;
    this.host = host;
    this.hooks = hooks;
    /** @type {any} */
    this.view = null;
    /** @type {{ key: string, endsAt: number, ms: number }[]} */
    this.deadlines = [];
    /** @type {Map<number, CardEl>} */
    this.els = new Map();
    /** @type {Map<string, CardEl>} */
    this.ghosts = new Map();
    /** @type {HTMLElement[]} */
    this.labels = [];
    /** @type {Map<number, { card: Face, until: number, bad?: boolean, king?: boolean }>} */
    this.reveals = new Map();
    /** @type {Map<number, { until: number, kind: 'draw' | 'peek' | 'king' | 'bad' }>} cards pulled into the spotlight */
    this.focus = new Map();
    /** @type {Map<number, number>} penalty cards that wait on the deck until the reveal is over */
    this.holdAtDeck = new Map();
    /** @type {{ id: number, at: number }} */
    this.lastTap = { id: -1, at: 0 };
    /** @type {Loc | null} card selected for throwing */
    this.sel = null;
    /** @type {{ mine?: Loc, theirs?: Loc }} picks for swap / king */
    this.picks = {};
    this.caboArmed = false;
    this.dealt = false;
    /** @type {any} */
    this.L = null;
    this.timerKey = '';
    this.revealTimer = 0;
    /** @type {boolean | null} log open? null = automatic (docked on wide screens, a one-line ticker on phones) */
    this.termPref = null;
    this.t0 = 0;

    root.classList.add('table');
    root.innerHTML = `
      <div class="deck"><div class="face back"></div><span class="count"></span></div>
      <div class="pile"></div>
      <div class="blur"></div>
      <button class="help" title="How to play">?</button>
      <button class="help left term-btn" title="Game log">&gt;_</button>
      <div class="term"><div class="term-head"><i></i><i></i><i></i><span>cabo.log</span></div><div class="term-body"></div></div>
      <div class="hud"><div class="hint"></div><div class="bar"><i></i></div></div>
      <div class="btns"></div>
      <button class="throw-btn">Throw</button>
      <div class="toasts"></div>
      <div class="overlay" hidden></div>`;
    const q = (/** @type {string} */ s) => /** @type {HTMLElement} */ (root.querySelector(s));
    this.deckEl = /** @type {CardEl} */ (q('.deck'));
    this.pileEl = /** @type {CardEl} */ (q('.pile'));
    this.hintEl = q('.hint');
    this.barEl = q('.bar');
    this.btnsEl = q('.btns');
    this.throwBtn = q('.throw-btn');
    this.toastsEl = q('.toasts');
    this.overlayEl = q('.overlay');
    this.blurEl = q('.blur');
    this.termEl = q('.term');
    this.termBody = q('.term-body');
    q('.term-btn').addEventListener('click', () => this.toggleTerm());
    this.termEl.addEventListener('click', () => { if (!this.termEl.classList.contains('docked')) this.toggleTerm(); });
    q('.help').addEventListener('click', () => this.hooks.onHelp());
    // Tapping the blurred table sends spotlit cards home early.
    this.blurEl.addEventListener('click', () => {
      const now = performance.now();
      for (const f of this.focus.values()) f.until = Math.min(f.until, now);
      for (const [id, t] of this.holdAtDeck) this.holdAtDeck.set(id, Math.min(t, now));
      this.render(false);
    });

    host.onMessage = (m) => this.receive(m);
    this.resizeObs = new ResizeObserver(() => this.render(true));
    this.resizeObs.observe(root);
    this.bindInput();
  }

  destroy() {
    this.resizeObs.disconnect();
    clearTimeout(this.revealTimer);
    this.root.replaceChildren();
  }

  // ---------- messages ----------

  /** @param {{ events: any[], view: any, deadlines: any[] }} m */
  receive({ events, view, deadlines }) {
    const prev = this.view;
    this.view = view;
    this.deadlines = deadlines;
    const me = view.you;
    const now = performance.now();
    const name = (/** @type {number} */ p) => (p === me ? 'You' : view.players[p].name);
    if (!this.t0) this.t0 = now;
    this.logEvents(events, view);

    for (const e of events) {
      switch (e.type) {
        case 'PeekStart':
          if (e.player === me) {
            for (const c of e.cards) {
              if (!c) continue;
              this.reveals.set(c.id, { card: c, until: now + view.settings.peekMs });
              this.focus.set(c.id, { until: now + view.settings.peekMs - 250, kind: 'peek' });
            }
          }
          break;
        case 'Drew':
          if (e.player === me) this.focus.set(e.id, { until: now + DRAW_FOCUS_MS, kind: 'draw' });
          break;
        case 'Peeked':
          if (e.player === me) {
            this.reveals.set(e.card.id, { card: e.card, until: now + PEEK_MS });
            this.focus.set(e.card.id, { until: now + PEEK_MS - 250, kind: 'peek' });
          }
          break;
        case 'KingLook':
          if (e.player === me) {
            for (const c of [e.mine, e.theirs]) {
              this.reveals.set(c.id, { card: c, until: now + 60_000, king: true });
              this.focus.set(c.id, { until: now + 60_000, kind: 'king' });
            }
          }
          break;
        case 'TurnStart':
          for (const r of this.reveals.values()) if (r.king) r.until = Math.min(r.until, now + 1300);
          for (const f of this.focus.values()) if (f.kind === 'king') f.until = Math.min(f.until, now + 700);
          this.picks = {};
          this.caboArmed = false;
          if (e.player === me && prev) vibrate(15);
          break;
        case 'Revealed':
          this.reveals.set(e.card.id, { card: e.card, until: now + view.settings.revealMs, bad: true });
          // Fly to the pile, sit there under the spotlight, then go home.
          this.focus.set(e.card.id, { until: now + view.settings.revealMs - 700, kind: 'bad' });
          if (e.player === me) vibrate([50, 40, 50]);
          if (e.reason === 'late') this.toast(`${name(e.player)} ${e.player === me ? 'were' : 'was'} too late`);
          else if (e.owner === e.player && e.player !== me) this.toast(`${name(e.player)} missed — loses a turn`);
          else if (e.owner === e.player) this.toast('Wrong card — you lose a turn', 'bad');
          break;
        case 'Threw':
          if (e.player === me) vibrate(25);
          else this.toast(`${name(e.player)} threw a ${RANKS[e.card.rank]}`);
          break;
        case 'Penalty': {
          const reveal = Math.max(now, ...[...this.focus.values()].filter((f) => f.kind === 'bad').map((f) => f.until));
          this.holdAtDeck.set(e.id, reveal + 250);
          this.toast(`${name(e.player)} ${e.player === me ? 'take' : 'takes'} a penalty card`, e.player === me ? 'bad' : '');
          break;
        }
        case 'Skipped':
          this.toast(`${name(e.player)} ${e.player === me ? 'skip' : 'skips'} this turn`);
          break;
        case 'TimedOut':
          if (e.player === me) this.toast('Out of time', 'bad');
          break;
        case 'Cabo':
          this.toast(`${name(e.player)} called CABO!`, 'cabo');
          vibrate([30, 30, 80]);
          break;
        case 'Reshuffled':
          this.toast('Deck reshuffled');
          break;
        case 'GraceStart':
          this.toast('Last throws!', 'cabo');
          break;
      }
    }

    // Selection and picks only make sense while the cards are still where they were.
    if (this.sel && this.cardAt(this.sel) == null) this.sel = null;
    if (!this.canThrow()) this.sel = null;
    this.render(false);
    if (view.result && !prev?.result) setTimeout(() => this.showResult(), 900);
  }

  /** @param {object} action */
  send(action) {
    const err = this.host.send(action);
    if (err) {
      this.toast(err, 'bad');
      vibrate(40);
    }
    this.sel = null;
    this.render(false);
  }

  // ---------- derived state ----------

  get me() { return this.view.you; }
  get turn() { return this.view.turn; }
  get myTurn() { return this.view.phase === 'play' && this.turn?.player === this.me; }
  get giving() { return this.view.gives.some((/** @type {any} */ g) => g.thrower === this.me); }

  canThrow() {
    const v = this.view;
    if (v.phase !== 'play' && v.phase !== 'grace') return false;
    if (this.giving) return false;
    return !(this.myTurn && this.turn.stage !== 'draw');
  }

  caboAllowed() {
    const v = this.view;
    if (!this.myTurn || this.turn.stage !== 'draw') return false;
    return v.cabo.first === null ? v.turnsDone >= v.settings.minCaboRound * v.players.length : !v.cabo.callers.includes(this.me);
  }

  /** @param {Loc} l */
  cardAt(l) { return this.view.players[l.owner]?.slots[l.slot] ?? null; }

  /** @param {number} id @returns {Loc | 'drawn' | null} */
  locate(id) {
    const v = this.view;
    if (v.turn?.drawn?.id === id) return 'drawn';
    for (let p = 0; p < v.players.length; p++) {
      const s = v.players[p].slots.indexOf(id);
      if (s >= 0) return { owner: p, slot: s };
    }
    return null;
  }

  /** Whether tapping this card does something right now (drives the highlight). @param {Loc} l */
  isTarget(l) {
    const me = this.me;
    if (this.giving) return l.owner === me;
    if (!this.myTurn) return false;
    const t = this.turn;
    if (t.stage === 'drawn') return l.owner === me;
    if (t.stage !== 'power') return false;
    switch (t.power.kind) {
      case 'peekOwn': return l.owner === me;
      case 'peekOther': return l.owner !== me;
      case 'swap': return l.owner === me ? !this.picks.mine : !this.picks.theirs && l.owner !== this.view.cabo.first;
      case 'king': return !t.power.looked && (l.owner === me ? !this.picks.mine : !this.picks.theirs);
    }
    return false;
  }

  // ---------- layout ----------

  layout() {
    const v = this.view;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const n = v.players.length, me = v.you;
    const opps = Array.from({ length: n - 1 }, (_, k) => (me + k + 1) % n);
    const pad = 10;
    const rowsOf = (/** @type {number} */ p) => Math.max(2, Math.ceil(v.players[p].slots.length / 2));
    const oppRows = Math.max(2, ...opps.map(rowsOf));
    const twoRows = opps.length > 3 && H > W;
    const topH = H * (twoRows ? 0.36 : 0.27);
    const meH = H * 0.39;
    const myRows = rowsOf(me);

    const cw = Math.min(W * 0.25, (meH - 40) / (myRows * (RATIO + GAP)), 140);
    const ch = cw * RATIO;

    const perRow = twoRows ? Math.ceil(opps.length / 2) : opps.length;
    const zoneW = (W - pad * 2) / perRow;
    const zoneH = topH / (twoRows ? 2 : 1);
    const ow = Math.min((zoneW - 16) / (2 + GAP), (zoneH - 34) / (oppRows * (RATIO + GAP)), cw * 0.75);

    /** @type {Map<number, { cx: number, top: number, w: number, flip?: number }>} */
    const zones = new Map();
    opps.forEach((p, i) => {
      const row = twoRows && i >= perRow ? 1 : 0;
      const inRow = row ? opps.length - perRow : perRow;
      const col = row ? i - perRow : i;
      const cx = pad + zoneW * (col + 0.5) + ((perRow - inRow) * zoneW) / 2;
      // Opponents face you: their bottom row (the one they peeked) is the row farthest from you.
      zones.set(p, { cx, top: pad + row * zoneH + 26, w: ow, flip: oppRows });
    });
    const myTop = H - pad - myRows * ch * (1 + GAP / RATIO) - 4;
    zones.set(me, { cx: W / 2, top: myTop, w: cw });

    const mid = H - meH - topH;
    const cs = Math.min(0.85, (mid * 0.62) / ch);
    const pileY = topH + mid * 0.42;
    const dx = cw * cs * 1.25;
    return {
      W, H, cw, ch, zones, cs, topH,
      deck: { cx: W / 2 - dx, cy: pileY },
      pile: { cx: W / 2, cy: pileY },
      hand: { cx: W / 2 + dx, cy: pileY },
      hudY: topH + mid * 0.86,
    };
  }

  /** Card spot from a center point and a scale. */
  /** @param {number} cx @param {number} cy @param {number} s @param {number} [r] @param {number} [z] */
  spot(cx, cy, s, r = 0, z = 1) {
    const L = this.L;
    return { x: cx - L.cw / 2, y: cy - L.ch / 2, s, r, z };
  }

  /** @param {number} p @param {number} slot */
  slotCenter(p, slot) {
    const z = this.L.zones.get(p);
    const h = z.w * RATIO, g = z.w * GAP;
    const row = z.flip ? z.flip - 1 - Math.floor(slot / 2) : Math.floor(slot / 2);
    return {
      cx: z.cx + ((slot % 2) - 0.5) * (z.w + g),
      cy: z.top + row * (h + g) + h / 2,
      w: z.w,
      h,
    };
  }

  /** @param {number} p */
  handSpot(p) {
    const L = this.L;
    if (p === this.me) return this.spot(L.hand.cx, L.hand.cy, L.cs, 0, 400);
    const z = L.zones.get(p);
    return this.spot(z.cx, z.top + z.w * RATIO * (z.flip ? z.flip - 0.45 : 0.55), (z.w / L.cw) * 1.15, 8, 400);
  }

  // ---------- render ----------

  /** @param {boolean} instant */
  render(instant) {
    const v = this.view;
    if (!v || !this.root.clientWidth) return;
    const L = (this.L = this.layout());
    this.root.style.setProperty('--cw', `${L.cw}px`);
    const now = performance.now();
    const ms = instant ? 0 : undefined;
    const me = v.you;
    /** @type {Set<number>} */
    const seen = new Set();
    /** @type {Set<string>} */
    const ghostSeen = new Set();

    for (const [id, r] of this.reveals) if (r.until <= now) this.reveals.delete(id);
    for (const [id, f] of this.focus) if (f.until <= now) this.focus.delete(id);
    for (const [id, t] of this.holdAtDeck) if (t <= now) this.holdAtDeck.delete(id);
    const spots = this.spotlight();
    this.blurEl.classList.toggle('on', spots.size > 0);
    // Someone else's mistake must never block your own taps; only your draws/peeks can be dismissed.
    this.blurEl.classList.toggle('catch', [...this.focus.values()].some((f) => f.kind !== 'bad'));

    moveTo(this.deckEl, this.spot(L.deck.cx, L.deck.cy, L.cs, 0, 2), { ms: 0 });
    moveTo(this.pileEl, this.spot(L.pile.cx, L.pile.cy, L.cs, 0, 2), { ms: 0 });
    /** @type {HTMLElement} */ (this.deckEl.querySelector('.count')).textContent = String(v.deckCount);
    this.deckEl.classList.toggle('target', this.myTurn && this.turn.stage === 'draw');
    this.pileEl.classList.toggle('target', this.myTurn && this.turn.stage === 'drawn');

    // Hands. The first render deals the cards one by one.
    const dealing = !this.dealt;
    this.dealt = true;
    v.players.forEach((/** @type {any} */ pl, /** @type {number} */ p) => {
      pl.slots.forEach((/** @type {number | null} */ id, /** @type {number} */ s) => {
        const c = this.slotCenter(p, s);
        const sp = this.spot(c.cx, c.cy, c.w / L.cw, 0, 10 + s);
        if (id == null) {
          this.ghost(`${p}:${s}`, sp);
          ghostSeen.add(`${p}:${s}`);
          return;
        }
        seen.add(id);
        const face = v.result ? v.result.hands[p][s] : this.reveals.get(id)?.card ?? null;
        const loc = { owner: p, slot: s };
        const el = this.card(id, face);
        el.classList.toggle('focus', spots.has(id));
        if (spots.has(id) || this.holdAtDeck.has(id)) {
          el.classList.toggle('bad', !!this.reveals.get(id)?.bad);
          el.classList.remove('sel', 'target', 'peek');
          moveTo(el, spots.get(id) ?? { ...this.deckEl._spot, z: 3 }, { ms, lift: spots.has(id) });
          return;
        }
        el.classList.toggle('bad', !!this.reveals.get(id)?.bad);
        el.classList.toggle('peek', !!this.reveals.get(id) && !this.reveals.get(id)?.bad);
        el.classList.toggle('sel', this.isSel(loc));
        el.classList.toggle('target', this.isTarget(loc));
        el.classList.toggle('locked', p === v.cabo.first);
        moveTo(el, sp, { ms, delay: dealing ? (s * v.players.length + ((p - me + v.players.length) % v.players.length)) * 45 : 0 });
      });
    });

    // The card being held this turn.
    const drawn = v.turn?.drawn;
    if (drawn) {
      seen.add(drawn.id);
      const el = this.card(drawn.id, drawn.rank ? drawn : null);
      el.classList.remove('bad', 'peek', 'sel', 'target', 'locked');
      el.classList.toggle('held', v.turn.player === me && !spots.has(drawn.id));
      el.classList.toggle('focus', spots.has(drawn.id));
      moveTo(el, spots.get(drawn.id) ?? this.handSpot(v.turn.player), { ms });
    }

    // Discard pile: the top few cards, each with a little tilt.
    v.discard.forEach((/** @type {Face} */ c, /** @type {number} */ i) => {
      seen.add(c.id);
      const el = this.card(c.id, c);
      el.classList.remove('bad', 'peek', 'sel', 'target', 'locked', 'held', 'focus');
      const tilt = ((c.id * 37) % 15) - 7;
      moveTo(el, this.spot(L.pile.cx, L.pile.cy, L.cs, tilt, 100 + i), { ms });
    });

    for (const [id, el] of this.els) {
      if (seen.has(id)) continue;
      this.els.delete(id);
      // Buried under the pile, or shuffled back into the deck.
      setTimeout(() => el.remove(), 500);
    }
    for (const [k, el] of this.ghosts) {
      if (ghostSeen.has(k)) continue;
      el.remove();
      this.ghosts.delete(k);
    }

    this.renderLabels();
    this.renderHud();
    this.renderTerm();

    clearTimeout(this.revealTimer);
    const nextExpiry = Math.min(
      ...[...this.reveals.values()].map((r) => r.until),
      ...[...this.focus.values()].map((f) => f.until),
      ...this.holdAtDeck.values(),
    );
    if (Number.isFinite(nextExpiry)) this.revealTimer = window.setTimeout(() => this.render(false), nextExpiry - now + 10);
  }

  /**
   * Where spotlit cards go: your own draws and peeks come big to the middle of the screen;
   * wrongly thrown cards sit enlarged on the pile.
   */
  spotlight() {
    const L = this.L;
    /** @type {Map<number, import('./motion.js').Spot>} */
    const out = new Map();
    const near = [...this.focus].filter(([, f]) => f.kind !== 'bad').map(([id]) => id);
    const bad = [...this.focus].filter(([, f]) => f.kind === 'bad').map(([id]) => id);
    const big = Math.min((L.W * 0.4) / L.cw, (L.H * 0.34) / L.ch, 2.6);
    const gapX = L.cw * big * 1.08;
    near.forEach((id, i) => {
      const cy = Math.max(L.ch * big * 0.5 + 12, Math.min(L.H * 0.46, L.hudY - 26 - (L.ch * big) / 2));
      out.set(id, this.spot(L.W / 2 + (i - (near.length - 1) / 2) * gapX, cy, big, 0, 1800 + i));
    });
    const pileBig = Math.min(L.cs * 1.7, (L.H * 0.3) / L.ch);
    bad.forEach((id, i) => {
      const off = (i - (bad.length - 1) / 2) * L.cw * pileBig * 0.7;
      out.set(id, this.spot(L.pile.cx + off, L.pile.cy, pileBig, (i % 2 ? 4 : -4), 1800 + near.length + i));
    });
    return out;
  }

  /** @param {Loc} l */
  isSel(l) {
    const eq = (/** @type {Loc | undefined | null} */ a) => !!a && a.owner === l.owner && a.slot === l.slot;
    return eq(this.sel) || eq(this.picks.mine) || eq(this.picks.theirs);
  }

  /** Get or create the element for a card id and set which face shows. */
  /** @param {number} id @param {Face | null} face */
  card(id, face) {
    let el = this.els.get(id);
    if (!el) {
      el = /** @type {CardEl} */ (document.createElement('div'));
      el.className = 'card';
      el.dataset.id = String(id);
      el.innerHTML = '<div class="wob"><div class="inner"><div class="face back"></div><div class="face front"></div></div></div>';
      this.root.appendChild(el);
      this.els.set(id, el);
      // New cards always come off the deck.
      if (this.deckEl._spot) moveTo(el, { ...this.deckEl._spot, z: 3 }, { ms: 0 });
    }
    if (face) {
      const key = `${face.rank}${face.suit}`;
      if (el._face !== key) {
        el._face = key;
        const red = face.suit === 'H' || face.suit === 'D';
        const front = /** @type {HTMLElement} */ (el.querySelector('.front'));
        front.className = `face front ${red ? 'red' : ''}`;
        const r = RANKS[face.rank], s = SUIT[face.suit];
        const big = face.rank > 10 ? `<b class="court">${r}</b>` : `<b>${s}</b>`;
        const minus = face.rank === 13 && red ? '<em>−1</em>' : '';
        front.innerHTML = `<span class="tl">${r}<i>${s}</i></span>${big}<span class="br">${r}<i>${s}</i></span>${minus}`;
      }
    }
    el.classList.toggle('up', !!face);
    return el;
  }

  /** Outline marking an empty slot, so players can still see where their cards are. */
  /** @param {string} key @param {import('./motion.js').Spot} sp */
  ghost(key, sp) {
    let el = this.ghosts.get(key);
    if (!el) {
      el = /** @type {CardEl} */ (document.createElement('div'));
      el.className = 'ghost';
      this.root.prepend(el);
      this.ghosts.set(key, el);
    }
    moveTo(el, { ...sp, z: 0 }, { ms: 0 });
  }

  renderLabels() {
    const v = this.view, L = this.L, me = v.you;
    while (this.labels.length < v.players.length) {
      const el = document.createElement('div');
      el.className = 'label';
      el.innerHTML = '<span class="name"></span><span class="badges"></span><i class="clock"></i>';
      this.root.appendChild(el);
      this.labels.push(el);
    }
    const turnDeadline = this.deadlines.find((d) => d.key.startsWith('turn:'));
    v.players.forEach((/** @type {any} */ pl, /** @type {number} */ p) => {
      const el = this.labels[p];
      const z = L.zones.get(p);
      const nm = /** @type {HTMLElement} */ (el.querySelector('.name'));
      const score = v.result ? ` · ${v.result.scores[p]}` : '';
      nm.textContent = (p === me ? 'You' : pl.name) + score;
      const badges = [];
      if (v.cabo.first === p) badges.push('<b class="cabo">CABO 🔒</b>');
      else if (v.cabo.callers.includes(p)) badges.push('<b class="cabo">CABO</b>');
      if (pl.skipNext) badges.push('<b>skip</b>');
      if (v.phase === 'shuffle' && pl.ready) badges.push('<b>ready</b>');
      if (v.result?.winners.includes(p)) badges.push('<b class="win">winner</b>');
      /** @type {HTMLElement} */ (el.querySelector('.badges')).innerHTML = badges.join('');
      const active = v.phase === 'play' && v.turn?.player === p;
      el.classList.toggle('active', active);
      el.classList.toggle('me', p === me);
      el.style.left = `${z.cx}px`;
      el.style.top = `${z.top - 6}px`;
      const clock = /** @type {HTMLElement} */ (el.querySelector('.clock'));
      if (active && turnDeadline) this.runClock(clock, turnDeadline, `${p}:${turnDeadline.key}`);
      else if (!active) clock.getAnimations().forEach((a) => a.cancel());
    });
  }

  /** Shrink a bar from the time left to zero. Restarts only when `key` changes. */
  /** @param {HTMLElement} el @param {{ endsAt: number, ms: number }} d @param {string} key */
  runClock(el, d, key) {
    if (el.dataset.key === key && el.getAnimations().length) return;
    el.dataset.key = key;
    el.getAnimations().forEach((a) => a.cancel());
    const left = Math.max(0, d.endsAt - performance.now());
    el.animate([{ transform: `scaleX(${left / d.ms})` }, { transform: 'scaleX(0)' }], { duration: left, fill: 'forwards' });
  }

  renderHud() {
    const v = this.view, L = this.L, me = v.you, t = v.turn;
    const hud = /** @type {HTMLElement} */ (this.hintEl.parentElement);
    hud.style.top = `${L.hudY}px`;
    // Action buttons sit right of the pile, where the drawn card goes; it's never there while buttons show.
    this.btnsEl.style.left = `${L.hand.cx}px`;
    this.btnsEl.style.top = `${L.hand.cy}px`;

    let hint = '';
    /** @type {[string, () => void, string?][]} */
    const btns = [];
    const name = (/** @type {number} */ p) => v.players[p].name;

    if (v.phase === 'shuffle') {
      hint = v.players[me].ready ? 'Waiting for the others…' : 'Shuffle your cards if you like, then tap Ready';
      if (!v.players[me].ready) {
        btns.push(['Shuffle', () => this.send({ type: 'shuffle' })]);
        btns.push(['Ready', () => this.send({ type: 'ready' }), 'primary']);
      }
    } else if (v.phase === 'peek') {
      hint = 'Memorize your bottom two cards';
    } else if (v.phase === 'grace') {
      hint = 'Last chance to throw!';
    } else if (v.phase === 'ended') {
      hint = 'Game over';
      if (this.overlayEl.hidden) btns.push(['Results', () => this.showResult(), 'primary']);
    } else if (this.giving) {
      hint = 'Pick one of your cards to give';
    } else if (this.myTurn) {
      if (t.stage === 'draw') {
        hint = 'Your turn: tap the deck';
        if (this.caboAllowed()) {
          btns.push([this.caboArmed ? 'Sure? CABO!' : 'CABO', () => {
            if (!this.caboArmed) { this.caboArmed = true; this.render(false); return; }
            this.caboArmed = false;
            this.send({ type: 'cabo' });
          }, 'cabo']);
        }
      } else if (t.stage === 'drawn') {
        hint = 'Tap one of your cards to swap it in, or the pile to discard';
      } else {
        const k = t.power.kind;
        hint = k === 'king' && t.power.looked ? 'Swap these two cards?' : POWER_HINT[/** @type {keyof POWER_HINT} */ (k)];
        if (k === 'king' && t.power.looked) {
          btns.push(['Keep', () => this.send({ type: 'kingSwap', swap: false })]);
          btns.push(['Swap', () => this.send({ type: 'kingSwap', swap: true }), 'primary']);
        } else {
          btns.push(['Skip', () => this.send({ type: 'skipPower' })]);
        }
      }
    } else if (t) {
      hint = `${name(t.player)}'s turn`;
      if (t.stage === 'power') hint += ` — using ${t.power.kind === 'king' ? 'the King' : 'a power'}`;
    }
    if (v.players[me].skipNext && v.phase === 'play') hint += ' · you skip your next turn';
    this.hintEl.textContent = hint;

    const sig = btns.map((b) => b[0] + (b[2] ?? '')).join('|');
    if (this.btnsEl.dataset.sig !== sig) {
      this.btnsEl.dataset.sig = sig;
      this.btnsEl.replaceChildren(...btns.map(([label, fn, cls]) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (cls) b.className = cls;
        b.onclick = fn;
        return b;
      }));
    } else {
      [...this.btnsEl.children].forEach((b, i) => { /** @type {HTMLButtonElement} */ (b).onclick = btns[i][1]; });
    }

    // My most urgent clock: giving, then my turn, then the phase timers.
    const mine = this.deadlines.find((d) => d.key.startsWith(`give:${me}:`))
      ?? (this.myTurn ? this.deadlines.find((d) => d.key.startsWith('turn:')) : undefined)
      ?? this.deadlines.find((d) => ['shuffle', 'peek', 'grace'].includes(d.key));
    this.barEl.hidden = !mine;
    if (mine) this.runClock(/** @type {HTMLElement} */ (this.barEl.firstElementChild), mine, mine.key);

    // Floating Throw button above the selected card.
    if (this.sel && this.canThrow()) {
      const c = this.slotCenter(this.sel.owner, this.sel.slot);
      this.throwBtn.style.left = `${c.cx}px`;
      this.throwBtn.style.top = `${c.cy - c.h / 2 - 10}px`;
      this.throwBtn.classList.add('show');
    } else {
      this.throwBtn.classList.remove('show');
    }
  }

  // ---------- input ----------

  bindInput() {
    const root = this.root;
    /** @type {{ x: number, y: number, el: CardEl | null, kind: string, id: number, drag: boolean, pid: number } | null} */
    let down = null;

    const local = (/** @type {PointerEvent} */ e) => {
      const r = root.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    root.addEventListener('pointerdown', (e) => {
      if (!this.view || e.button > 0) return;
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest('button, .overlay, .term')) return;
      const card = /** @type {CardEl | null} */ (t.closest('.card'));
      const kind = card ? 'card' : t.closest('.deck') ? 'deck' : t.closest('.pile') ? 'pile' : 'felt';
      const { x, y } = local(e);
      down = { x, y, el: card, kind, id: card ? Number(card.dataset.id) : -1, drag: false, pid: e.pointerId };
    });

    root.addEventListener('pointermove', (e) => {
      if (!down || down.pid !== e.pointerId || !down.el) return;
      const { x, y } = local(e);
      if (!down.drag) {
        if (Math.hypot(x - down.x, y - down.y) < 10 || !this.draggable(down.id)) return;
        down.drag = true;
        root.setPointerCapture(e.pointerId);
        down.el.classList.add('dragging');
      }
      const L = this.L;
      const s = (down.el._spot?.s ?? 1) < L.cs ? L.cs : (down.el._spot?.s ?? 1);
      moveTo(down.el, this.spot(x, y - L.ch * 0.25, s, 0, 2000), { ms: 0 });
      this.pileEl.classList.toggle('hover', this.overPile(x, y));
    });

    const up = (/** @type {PointerEvent} */ e) => {
      if (!down || down.pid !== e.pointerId) return;
      const d = down;
      down = null;
      if (d.drag && d.el) {
        d.el.classList.remove('dragging');
        this.pileEl.classList.remove('hover');
        const { x, y } = local(e);
        this.drop(d.id, x, y);
        return;
      }
      if (e.type === 'pointercancel') return;
      this.tap(d.kind, d.id);
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);

    this.throwBtn.addEventListener('click', () => {
      if (this.sel) this.send({ type: 'throw', owner: this.sel.owner, slot: this.sel.slot });
    });
  }

  /** @param {number} x @param {number} y */
  overPile(x, y) {
    const L = this.L;
    return Math.abs(x - L.pile.cx) < L.cw * L.cs * 0.9 && Math.abs(y - L.pile.cy) < L.ch * L.cs * 0.8;
  }

  /** @param {number} id */
  draggable(id) {
    const loc = this.locate(id);
    if (loc === 'drawn') return this.myTurn && this.turn.stage === 'drawn';
    return !!loc && this.canThrow();
  }

  /** @param {number} id @param {number} x @param {number} y */
  drop(id, x, y) {
    const loc = this.locate(id);
    if (loc === 'drawn') {
      if (this.overPile(x, y)) return this.send({ type: 'discard' });
      const me = this.me;
      const slot = this.view.players[me].slots.findIndex((/** @type {any} */ c, /** @type {number} */ s) => {
        if (c == null) return false;
        const sc = this.slotCenter(me, s);
        return Math.abs(x - sc.cx) < sc.w / 2 && Math.abs(y - sc.cy) < sc.h / 2;
      });
      if (slot >= 0) return this.send({ type: 'replace', slot });
    } else if (loc && this.overPile(x, y)) {
      return this.send({ type: 'throw', owner: loc.owner, slot: loc.slot });
    }
    this.render(false); // fly back
  }

  /** @param {string} kind @param {number} id */
  tap(kind, id) {
    const v = this.view, me = v.you, t = v.turn;
    if (this.overlayEl.hidden === false) return;
    if (kind === 'deck') {
      if (this.myTurn && t.stage === 'draw') this.send({ type: 'draw' });
      return;
    }
    if (kind === 'pile' || (kind === 'card' && v.discard.some((/** @type {Face} */ c) => c.id === id))) {
      if (this.myTurn && t.stage === 'drawn') this.send({ type: 'discard' });
      else if (this.sel) this.send({ type: 'throw', owner: this.sel.owner, slot: this.sel.slot });
      return;
    }
    if (kind !== 'card') {
      if (this.sel) { this.sel = null; this.render(false); }
      return;
    }
    const loc = this.locate(id);
    if (!loc || loc === 'drawn') return;

    if (this.giving) {
      if (loc.owner === me) this.send({ type: 'give', slot: loc.slot });
      return;
    }
    if (this.myTurn && t.stage === 'drawn') {
      if (loc.owner === me) this.send({ type: 'replace', slot: loc.slot });
      return;
    }
    if (this.myTurn && t.stage === 'power') return this.powerTap(loc);
    if (this.canThrow()) {
      const now = performance.now();
      const double = this.lastTap.id === id && now - this.lastTap.at < DOUBLE_TAP_MS;
      this.lastTap = { id, at: double ? 0 : now };
      if (double) return this.send({ type: 'throw', owner: loc.owner, slot: loc.slot });
      this.sel = this.isSel(loc) ? null : loc;
      vibrate(8);
      this.render(false);
    }
  }

  /** @param {Loc} loc */
  powerTap(loc) {
    const me = this.me, power = this.turn.power;
    switch (power.kind) {
      case 'peekOwn':
        if (loc.owner === me) this.send({ type: 'peek', owner: me, slot: loc.slot });
        return;
      case 'peekOther':
        if (loc.owner !== me) this.send({ type: 'peek', owner: loc.owner, slot: loc.slot });
        return;
      case 'swap':
      case 'king': {
        if (power.looked) return;
        if (loc.owner === me) this.picks.mine = this.isSel(loc) ? undefined : loc;
        else this.picks.theirs = this.isSel(loc) ? undefined : loc;
        const { mine, theirs } = this.picks;
        if (mine && theirs) {
          this.picks = {};
          const a = { slot: mine.slot, owner: theirs.owner, ownerSlot: theirs.slot };
          this.send(power.kind === 'swap' ? { type: 'swap', ...a } : { type: 'kingLook', ...a });
        } else {
          vibrate(8);
          this.render(false);
        }
      }
    }
  }

  // ---------- log ----------

  /** Turn engine events into lines for the log terminal, from this player's point of view. */
  /** @param {any[]} events @param {any} v */
  logEvents(events, v) {
    const me = v.you;
    const nm = (/** @type {number} */ p) => `<span class="nm">${p === me ? 'You' : esc(v.players[p].name)}</span>`;
    const vb = (/** @type {number} */ p, /** @type {string} */ you, /** @type {string} */ they) => (p === me ? you : they);
    /** whose card, from the actor's view */
    const of = (/** @type {number} */ actor, /** @type {number} */ owner) => (owner === actor ? (actor === me ? 'your' : 'own') : `${nm(owner)}'s`);
    const ok = '<span class="ok">✓</span>', no = '<span class="no">✗</span>';
    /** @type {[string, string?][]} */
    const out = [];
    for (const e of events) {
      const p = e.player;
      switch (e.type) {
        case 'Flipped': out.push([`pile starts with ${cardTag(e.card)}`, 'dim']); break;
        case 'PeekStart': if (p === me && e.cards) out.push([`you peeked your bottom row: ${e.cards.map(cardTag).join(' ')}`]); break;
        case 'TurnStart': out.push([`── ${p === me ? 'your' : `${esc(v.players[p].name)}'s`} turn ──`, 'dim']); break;
        case 'Cabo': out.push([`${nm(p)} called <span class="cabo">${e.first ? 'CABO!' : 'counter-CABO'}</span>`]); break;
        case 'Drew': out.push([p === me && e.card ? `you drew ${cardTag(e.card)}` : `${nm(p)} drew a card`, 'dim']); break;
        case 'Replaced': out.push([`${nm(p)} swapped a card into ${of(p, p)} ${slotName(e.slot)} → ${cardTag(e.card)} to the pile`]); break;
        case 'Discarded': out.push([`${nm(p)} discarded ${cardTag(e.card)}${e.auto ? ' (time ran out)' : ''}`]); break;
        case 'PowerStart': out.push([`  power: ${POWER_NAME[/** @type {keyof POWER_NAME} */ (e.kind)]}`, 'dim']); break;
        case 'Peeked':
          out.push([`${nm(p)} peeked at ${of(p, e.owner)} ${slotName(e.slot)}${e.card ? `: ${cardTag(e.card)}` : ''}`]);
          break;
        case 'KingLook':
          out.push([e.mine
            ? `you looked: your ${slotName(e.slot)} is ${cardTag(e.mine)}, ${nm(e.owner)}'s ${slotName(e.ownerSlot)} is ${cardTag(e.theirs)}`
            : `${nm(p)} looked at own ${slotName(e.slot)} and ${of(p, e.owner)} ${slotName(e.ownerSlot)}`]);
          break;
        case 'Swapped': out.push([`${nm(p)} swapped ${of(p, p)} ${slotName(e.slot)} ⇄ ${of(p, e.owner)} ${slotName(e.ownerSlot)}`]); break;
        case 'Threw':
          out.push([e.owner === p
            ? `${nm(p)} threw ${cardTag(e.card)} ${ok}`
            : `${nm(p)} threw ${of(p, e.owner)} ${cardTag(e.card)} ${ok} → ${vb(p, 'you owe', 'owes')} ${nm(e.owner)} a card`]);
          break;
        case 'Revealed': {
          const rank = v.window?.rank;
          const holder = v.window?.claimedBy;
          const card = `${e.owner === p ? '' : `${of(p, e.owner)} `}${cardTag(e.card)}`;
          if (e.card.rank === rank) {
            const tail = e.owner === p
              ? (holder != null && holder !== p ? ` — only ${nm(holder)} may throw it now` : '')
              : ` → ${vb(p, 'you take', 'takes')} a penalty card`;
            out.push([`${nm(p)} ${vb(p, 'were', 'was')} too late with ${card} ${no}${tail}`, 'bad']);
          } else {
            const why = rank ? `not a ${RANKS[rank]}` : 'wrong card';
            const cost = e.owner === p ? ` → ${vb(p, 'you lose', 'loses')} a turn` : ` → ${vb(p, 'you take', 'takes')} a penalty card`;
            out.push([`${nm(p)} threw ${card} ${no} ${why}${cost}`, 'bad']);
          }
          break;
        }
        case 'Penalty': out.push([`${nm(p)} ${vb(p, 'take', 'takes')} a penalty card (${slotName(e.slot)})`, 'bad']); break;
        case 'Forfeit': out.push([`${nm(p)} ${vb(p, 'lose', 'loses')} the rest of the turn`, 'bad']); break;
        case 'Skipped': out.push([`${nm(p)} ${vb(p, 'skip', 'skips')} this turn (earlier wrong throw)`, 'bad']); break;
        case 'Gave': out.push([`${nm(p)} gave ${nm(e.owner)} a card → ${e.owner === me ? 'your' : `${nm(e.owner)}'s`} ${slotName(e.ownerSlot)}`]); break;
        case 'TimedOut': out.push([`${nm(p)} ran out of time`, 'bad']); break;
        case 'DeckEmpty': out.push(['the deck is empty', 'dim']); break;
        case 'Reshuffled': out.push([`pile reshuffled into the deck (${e.deckCount} cards)`, 'dim']); break;
        case 'GraceStart': out.push(['last throws…', 'cabo']); break;
        case 'GameOver': {
          const r = e.result;
          out.push([`game over · ${r.winners.map((/** @type {number} */ w) => `${nm(w)} (${r.scores[w]})`).join(' & ')} ${r.winners.length > 1 || r.winners[0] === me ? 'win' : 'wins'}`, 'cabo']);
          break;
        }
      }
    }
    if (!out.length) return;
    const secs = Math.floor((performance.now() - this.t0) / 1000);
    const stamp = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    const frag = document.createDocumentFragment();
    for (const [html, cls] of out) {
      const li = document.createElement('div');
      li.className = `ln ${cls ?? ''}`;
      li.innerHTML = `<span class="ts">${stamp}</span>${html}`;
      frag.appendChild(li);
    }
    this.termBody.appendChild(frag);
    while (this.termBody.childElementCount > MAX_LOG) this.termBody.firstElementChild?.remove();
    this.termBody.scrollTop = this.termBody.scrollHeight;
  }

  toggleTerm() {
    this.termPref = !this.termOpen();
    this.render(false);
  }

  termDocked() { return this.L.W >= 900 && this.L.W > this.L.H * 1.2; }
  termOpen() { return this.termPref ?? this.termDocked(); }

  /** Docked at the side on wide screens; on phones a one-line ticker that expands on tap. */
  renderTerm() {
    const L = this.L, el = this.termEl, docked = this.termDocked(), open = this.termOpen();
    el.classList.toggle('docked', docked);
    el.classList.toggle('open', open);
    el.classList.toggle('tick', !docked && !open);
    el.hidden = docked && !open;
    const st = el.style;
    if (docked) {
      st.left = '12px';
      st.right = '';
      st.top = `${L.topH + 8}px`;
      st.width = `${Math.max(220, Math.min(360, L.W / 2 - L.cw * 1.3 - 36))}px`;
      st.height = `${L.H - L.topH - 20}px`;
    } else if (open) {
      st.left = '8px';
      st.right = '8px';
      st.width = '';
      st.top = `${L.topH + 2}px`;
      st.height = `${Math.max(120, L.hudY - 34 - L.topH)}px`;
    } else {
      st.left = '52px';
      st.right = '52px';
      st.width = '';
      st.top = `${L.topH + 2}px`;
      st.height = '';
    }
    const scroll = this.termBody;
    if (open || !docked) scroll.scrollTop = scroll.scrollHeight;
    this.toastsEl.style.top = `${L.topH + (!docked && !open ? 32 : 4)}px`;
  }

  // ---------- feedback ----------

  /** @param {string} text @param {string} [cls] */
  toast(text, cls = '') {
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.textContent = text;
    this.toastsEl.appendChild(el);
    while (this.toastsEl.children.length > 3) this.toastsEl.firstElementChild?.remove();
    el.animate(
      [{ opacity: 0, transform: 'translateY(8px) scale(.96)' }, { opacity: 1, transform: 'none', offset: 0.12 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }],
      { duration: cls === 'cabo' ? 2600 : 2000, easing: 'ease-out' },
    ).onfinish = () => el.remove();
  }

  showResult() {
    const v = this.view, r = v.result, me = v.you;
    const order = r.scores.map((/** @type {number} */ s, /** @type {number} */ p) => ({ s, p })).sort((/** @type {any} */ a, /** @type {any} */ b) => a.s - b.s);
    const iWon = r.winners.includes(me);
    const shared = r.winners.length > 1;
    this.overlayEl.innerHTML = `
      <div class="result">
        <h2>${iWon ? (shared ? 'Shared win!' : 'You win!') : `${r.winners.map((/** @type {number} */ p) => v.players[p].name).join(' & ')} ${shared ? 'win' : 'wins'}`}</h2>
        <ol>${order.map(({ s, p }) => `<li class="${r.winners.includes(p) ? 'win' : ''}"><span>${p === me ? 'You' : v.players[p].name}${v.cabo.callers.includes(p) ? ' <small>CABO</small>' : ''}</span><b>${s}</b></li>`).join('')}</ol>
        <div class="row"><button data-a="exit">${this.hooks.exitLabel ?? 'Menu'}</button>${this.hooks.onAgain ? '<button class="primary" data-a="again">Play again</button>' : '<button disabled>Waiting for host…</button>'}</div>
      </div>`;
    this.overlayEl.hidden = false;
    this.overlayEl.querySelector('[data-a=again]')?.addEventListener('click', () => this.hooks.onAgain?.());
    this.overlayEl.querySelector('[data-a=exit]')?.addEventListener('click', () => this.hooks.onExit());
    this.overlayEl.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlayEl) this.overlayEl.hidden = true; // peek at the revealed hands
    }, { once: true });
  }
}
