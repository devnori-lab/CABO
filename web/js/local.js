// @ts-check
// Runs a whole table in the browser: engine, timers and bots. It speaks the same
// messages as the online server will ({ events, view, deadlines }), so the table UI
// doesn't care which one it's talking to.

import { createGame, apply, timers } from '../../engine/game.js';
import { viewFor, eventFor } from '../../engine/view.js';
import { Bot, BOT_DELAY as DELAY } from '../../engine/bots.js';
import { makeRng } from '../../engine/rng.js';

const BOT_NAMES = ['Mira', 'Juno', 'Otto', 'Pia', 'Rex'];

export class LocalHost {
  /** @param {{ name?: string, bots?: number, settings?: object, seed?: number }} opts */
  constructor({ name = 'You', bots = 3, settings = {}, seed = crypto.getRandomValues(new Uint32Array(1))[0] } = {}) {
    const players = [{ name }, ...BOT_NAMES.slice(0, bots).map((n) => ({ name: n }))];
    this.state = createGame({ players, settings, seed });
    this.rng = makeRng(seed ^ 0x5bd1e995);
    this.bots = players.slice(1).map((_, i) => new Bot(i + 1, { rng: makeRng(seed + i + 1) }));
    this.me = 0;
    /** @type {Map<string, { handle: number, endsAt: number }>} */
    this.timers = new Map();
    /** @type {Map<number, Map<string, number>>} bot seat -> action key -> timeout */
    this.botPlans = new Map(this.bots.map((b) => [b.seat, new Map()]));
    /** @type {(msg: { events: any[], view: any, deadlines: { key: string, endsAt: number, ms: number }[] }) => void} */
    this.onMessage = () => {};
    this.stopped = false;
  }

  start() {
    this.sync([]);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t.handle);
    for (const plans of this.botPlans.values()) for (const h of plans.values()) clearTimeout(h);
  }

  /** An action from the human player. Returns an error message if the engine refused it. */
  /** @param {object} action */
  send(action) {
    return this.dispatch({ ...action, player: this.me });
  }

  /** @param {any} action */
  dispatch(action) {
    if (this.stopped) return 'stopped';
    const r = apply(this.state, action);
    if (r.error) return r.error;
    this.state = r.state;
    this.sync(r.events);
    return null;
  }

  /** @param {any[]} events */
  sync(events) {
    const st = this.state;
    for (const b of this.bots) for (const e of events) b.observe(eventFor(e, b.seat));

    const wanted = new Map(timers(st).map((t) => [t.key, t]));
    for (const [key, t] of this.timers) {
      if (!wanted.has(key)) {
        clearTimeout(t.handle);
        this.timers.delete(key);
      }
    }
    for (const [key, t] of wanted) {
      if (this.timers.has(key)) continue;
      const handle = window.setTimeout(() => {
        this.timers.delete(key);
        this.dispatch(t.action);
      }, t.ms);
      this.timers.set(key, { handle, endsAt: performance.now() + t.ms });
    }

    const deadlines = [...this.timers].map(([key, t]) => ({ key, endsAt: t.endsAt, ms: /** @type {any} */ (wanted.get(key)).ms }));
    this.onMessage({ events: events.map((e) => eventFor(e, this.me)), view: viewFor(st, this.me), deadlines });
    this.planBots();
  }

  planBots() {
    for (const bot of this.bots) {
      const plans = /** @type {Map<string, number>} */ (this.botPlans.get(bot.seat));
      const next = new Map(bot.plan(viewFor(this.state, bot.seat)).map((p) => [JSON.stringify(p.action), p]));
      for (const [key, h] of plans) {
        if (!next.has(key)) {
          clearTimeout(h);
          plans.delete(key);
        }
      }
      for (const [key, p] of next) {
        if (plans.has(key)) continue;
        const [lo, hi] = DELAY[p.kind];
        const ms = lo + Math.random() * (hi - lo);
        plans.set(key, window.setTimeout(() => {
          plans.delete(key);
          // A refused move (e.g. someone threw first) means re-plan from the current state.
          if (this.dispatch(p.action)) this.planBots();
        }, ms));
      }
    }
  }
}
