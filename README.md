# CABO

Online multiplayer CABO. Plain JavaScript, no framework. One Cloudflare Worker serves the
site, the accounts API and the game rooms (one Durable Object per room). Users and the
room listing live in D1. Everything fits in Cloudflare's free tier.

## Run locally

Two terminals:

```sh
npm install
npm run dev:server   # builds, sets up the local database, runs the Worker on :8787
npm run dev          # Vite with hot reload on :5173, forwarding /api to :8787
```

Open http://localhost:5173. To test multiplayer on one machine, use a second browser
profile or a private window, since each login is a cookie. Phones on the same Wi-Fi
can open the network URL that Vite prints.

`npm test` runs the engine tests, including bot-vs-bot games.

## Deploy (Cloudflare, free)

```sh
npx wrangler login
npx wrangler d1 create cabo   # copy the printed database_id into wrangler.jsonc
npm run deploy                # build, migrate the remote database, deploy
```

The site is then live at `https://cabo.<your-subdomain>.workers.dev`. A custom domain
can be added in the Cloudflare dashboard.

## Layout

```
engine/   rules (pure, shared by browser and server), bots
server/   worker.js (HTTP API), room.js (Room Durable Object), auth.js
web/      index.html, css/, js/ (table.js renders the game, screens/ are the menus)
migrations/  D1 schema
test/     engine tests
```

RULES.md is the rules spec; PLAN.md is the build plan.
