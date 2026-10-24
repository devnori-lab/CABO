// @ts-check
// What each player is allowed to see. Face-down cards are sent as bare ids; only the
// discard pile, the viewer's own drawn card and the final result carry rank/suit.

import { pub } from './game.js';

/** @typedef {import('./game.js').State} State */
/** @typedef {import('./game.js').GameEvent} GameEvent */

/** @param {State} st @param {number} viewer */
export function viewFor(st, viewer) {
  const t = st.turn;
  return {
    you: viewer,
    phase: st.phase,
    settings: st.settings,
    players: st.players.map((pl) => ({ name: pl.name, slots: [...pl.slots], ready: pl.ready, skipNext: pl.skipNext })),
    deckCount: st.deck.length,
    discard: st.discard.slice(-3).map((id) => pub(st, id)),
    discardCount: st.discard.length,
    window: st.window,
    throwRights: st.throwRights,
    gives: st.gives,
    turn: t && {
      id: t.id,
      player: t.player,
      stage: t.stage,
      power: t.power && { kind: t.power.kind, looked: !!t.power.looked },
      drawn: t.drawn === null ? null : viewer === t.player ? pub(st, t.drawn) : { id: t.drawn },
    },
    turnsDone: st.turnsDone,
    cabo: st.cabo,
    result: st.result,
  };
}

/** Strip private details from an event unless the viewer is in its audience. */
/** @param {GameEvent} e @param {number} viewer @returns {GameEvent} */
export function eventFor(e, viewer) {
  const { audience, secret, ...rest } = e;
  if (!audience || audience.includes(viewer)) return { ...rest, ...secret };
  return rest;
}
