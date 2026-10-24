// @ts-check
// The creator's page: who made CABO and what it's built with.

import { $, esc } from '../ui.js';

// Edit this block to change the intro.
const CREATOR = {
  name: 'Aditya',
  role: 'Creator of CABO',
  bio: [
    "Hi, I'm Aditya. I built CABO Online so the card game my friends and I love can be played anywhere, on any phone, with no app to install.",
    'The goal was a game that feels as quick and physical as real cards: smooth card motion, instant throws, and a fair server that keeps everyone honest.',
  ],
  /** @type {{ label: string, url: string }[]} e.g. { label: 'GitHub', url: 'https://github.com/…' } */
  links: [],
};

const STACK = [
  {
    group: 'Game engine',
    items: [
      ['Plain JavaScript', 'The rules are pure functions with no dependencies. The same code runs in the browser and on the server.'],
      ['Seeded random numbers', 'Shuffles are reproducible in tests; online games are seeded from crypto randomness.'],
      ['node:test', 'Scenario tests for every rule, plus hundreds of bot-vs-bot games checked on every run.'],
    ],
  },
  {
    group: 'Front end',
    items: [
      ['No framework', 'Plain DOM. Every card is one element that lives for the whole game, so it can glide instead of being redrawn.'],
      ['Web Animations API', 'Card flights, 3D flips, spotlight zooms and shakes, all on the GPU with no animation library.'],
      ['Modern CSS', 'Custom properties, backdrop blur and safe-area padding for a phone-first layout.'],
      ['Vite', 'Dev server and bundler only. The whole game ships as about 20 KB of gzipped JavaScript.'],
    ],
  },
  {
    group: 'Server',
    items: [
      ['Cloudflare Workers', 'One Worker serves the site, the accounts API and the WebSockets, close to every player.'],
      ['Durable Objects', 'One object per room holds the hidden cards, runs the timers and bots, and decides which throw came first.'],
      ['D1 (SQLite)', 'Accounts, sessions, stats and the open-rooms list.'],
      ['Web Crypto', 'Passwords hashed with PBKDF2, HTTP-only session cookies.'],
    ],
  },
];

/** @param {HTMLElement} root @param {{ go: (path: string) => void }} opts */
export function creatorScreen(root, { go }) {
  const c = CREATOR;
  const initials = c.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  root.innerHTML = `
    <main class="screen creator">
      <header class="top">
        <button class="plain sm" data-a="back">← Back</button>
        <div class="title"><b>Creator's corner</b></div>
        <span class="spacer"></span>
      </header>

      <section class="panel intro">
        <div class="avatar">${esc(initials)}</div>
        <h2>${esc(c.name)}</h2>
        <p class="muted role">${esc(c.role)}</p>
        ${c.bio.map((p) => `<p>${esc(p)}</p>`).join('')}
        ${c.links.length ? `<div class="links">${c.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</div>` : ''}
      </section>

      <section class="panel">
        <h3>How it fits together</h3>
        <div class="flow">
          <div class="node"><b>Your phone</b><span>renders cards, sends taps</span></div>
          <div class="arrow">⇅ <span>WebSocket</span></div>
          <div class="node hl"><b>Room server</b><span>Durable Object: hidden cards, timers, bots</span></div>
          <div class="arrow">⇅</div>
          <div class="node"><b>D1 database</b><span>accounts, stats, room list</span></div>
        </div>
        <p class="muted small">Each player only ever receives their own view of the table, so nobody can peek at hidden cards through the browser.</p>
      </section>

      ${STACK.map((g) => `
        <section class="panel">
          <h3>${esc(g.group)}</h3>
          <ul class="stack">${g.items.map(([name, why]) => `<li><b>${esc(name)}</b><span>${esc(why)}</span></li>`).join('')}</ul>
        </section>`).join('')}

      <section class="panel facts">
        <div><b>0</b><span>runtime dependencies</span></div>
        <div><b>~20 KB</b><span>gzipped game code</span></div>
        <div><b>$0</b><span>to host (free tier)</span></div>
      </section>
    </main>`;
  $(root, '[data-a=back]').addEventListener('click', () => (history.length > 1 ? history.back() : go('/')));
  return () => {};
}
