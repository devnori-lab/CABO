// @ts-check
// Seedable PRNG (sfc32). State is a plain array so it survives structuredClone/JSON.
// The server seeds it from crypto.getRandomValues; tests use fixed seeds.

/** @typedef {number[]} Rng */

/** @param {number | number[]} seed */
export function makeRng(seed) {
  const s = Array.isArray(seed) ? seed : [seed, 0x9e3779b9, 0x243f6a88, 0xb7e15162];
  /** @type {Rng} */
  const rng = [s[0] | 0, s[1] | 0, s[2] | 0, s[3] | 0];
  for (let i = 0; i < 15; i++) next(rng);
  return rng;
}

/** @param {Rng} r @returns {number} float in [0, 1) */
export function next(r) {
  let [a, b, c, d] = r;
  let t = (a + b) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  d = (d + 1) | 0;
  t = (t + d) | 0;
  c = (c + t) | 0;
  r[0] = a; r[1] = b; r[2] = c; r[3] = d;
  return (t >>> 0) / 4294967296;
}

/** @param {Rng} r @param {number} n */
export const randInt = (r, n) => Math.floor(next(r) * n);

/** In-place Fisher–Yates. @template T @param {T[]} arr @param {Rng} r */
export function shuffle(arr, r) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(r, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
