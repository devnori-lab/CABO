# CABO Online: Build Plan

## Stack (no framework, all free tier)

| Layer | Choice | Why |
|---|---|---|
| Language | Plain JavaScript (ES modules), with JSDoc comments and `// @ts-check` in the engine | No build-time language. The editor still catches mistakes in the rules code |
| Dev/build | **Vite** | Dev server with instant reload, and it bundles to small static files. No framework involved |
| UI | Plain DOM and CSS. One persistent element per card, keyed by card id | Each card element survives state changes, so it can be animated instead of re-created |
| Animation | **Web Animations API** with a small hand-written FLIP helper (about 50 lines); CSS 3D transforms for card flips | No dependencies, GPU-accelerated |
| Styling | Plain CSS: custom properties, `clamp()`, container queries | Responsive without a CSS framework |
| Server | **Cloudflare Worker + Durable Objects**, plain JS | One authoritative object per room, holding hidden state and WebSockets |
| Hosting | Cloudflare (static assets served by the same Worker) | One deploy for the frontend and server, free |
| Tests | `node:test` (built into Node) | No test dependency |

## Repo layout

```
engine/   rules: pure functions, no I/O (shared by server + client)
  cards.js    deck, values, powers
  rng.js      seedable PRNG (server seeds from crypto)
  game.js     createGame(), apply(state, action) -> { state, events } | { error }, timers()
  view.js     viewFor(state, player), eventFor(event, player): redaction
  bots.js     random bots for fuzzing and as placeholder opponents
server/   Cloudflare Worker + Room Durable Object
web/      index.html, css/, js/ (net.js, render.js, flip.js, input.js, sound.js)
test/     engine tests + bot-vs-bot fuzzing
```

## Protocol

- **Client → server** sends intents: `{t:"draw"}`, `{t:"replace",slot}`, `{t:"discard"}`, `{t:"power",...}`, `{t:"throw",owner,slot}`, `{t:"give",slot}`, `{t:"cabo"}`.
- **Server → each client** sends `{events:[...], view}`.
  - `events` drive the animations, for example `CardMoved`, `Reveal`, `Shake`, `Penalty`, `TurnStart`.
  - `view` is the redacted snapshot used to resync.
- **Throws** are processed in the order they arrive at the Durable Object. The Durable Object is single-threaded, so "first correct throw" is decided fairly by the server.
- **Timers** (turn, peek, reveal, final grace period) run on the server using Durable Object alarms.

## Responsive and mobile

- Phone portrait is the primary layout: your grid fills the bottom half; the deck and discard pile are in the middle; opponents are in a compact row or arc at the top.
- Desktop shows the same table with more space.
- Every tap target is at least 48 px. Throwing takes **one tap on a card, then one tap on Throw**, or a drag onto the discard pile. Throwing your own card should take about 300 ms or less.
- Throwing another player's card asks you to confirm the target, then to pick which of your cards to give.
- Mobile extras: Wake Lock (keep the screen on), `viewport-fit=cover` with safe-area padding, haptics with `navigator.vibrate`, and automatic reconnect when the app returns from the background.
- Installable PWA comes later.

## Milestones

1. ✅ **Engine**: `RULES.md` turned into code, plus tests. Bot-vs-bot fuzzing over thousands of seeded games, checking that cards are conserved, no illegal states occur, and every game ends.
2. ✅ **Local table** (practice vs bots at `/practice`): play in the browser against bots, with no networking. Get all the animations and the phone layout feeling right here.
3. ✅ **Online** (first version; plus accounts with username/email/password, open-room list, chat, add bots, stats and leaderboard): Worker and Room Durable Object, create/join by 4-letter code or link, lobby with host settings, session token for reconnects, server timers.
4. **Polish**: sounds, shuffle-your-cards animation, first-game hints, emotes.
5. **Later**: PWA, then native apps that reuse the engine and web UI.
