// @ts-check
// Moves absolutely-positioned elements with the Web Animations API. Each element remembers
// its target; moving starts from wherever it is *right now* (even mid-flight), so
// interrupted animations never jump.

/** @typedef {{ x: number, y: number, s?: number, r?: number, z?: number }} Spot  x/y = top-left */

export const EASE = 'cubic-bezier(.2, .8, .25, 1)';

/** @param {Spot} t */
const css = (t) => `translate(${t.x.toFixed(1)}px, ${t.y.toFixed(1)}px) rotate(${(t.r ?? 0).toFixed(1)}deg) scale(${(t.s ?? 1).toFixed(4)})`;

/**
 * @param {HTMLElement & { _spot?: Spot }} el
 * @param {Spot} to
 * @param {{ ms?: number, delay?: number, lift?: boolean }} [opts]
 */
export function moveTo(el, to, { ms = 420, delay = 0, lift = true } = {}) {
  const prev = el._spot;
  const next = css(to);
  el._spot = to;
  const z = String(to.z ?? 1);
  if (!prev || ms === 0) {
    el.getAnimations().forEach((a) => a.cancel());
    el.style.transform = next;
    el.style.zIndex = z;
    return;
  }
  if (css(prev) === next) {
    if (!el.getAnimations().length) el.style.zIndex = z;
    return;
  }
  const from = getComputedStyle(el).transform;
  el.getAnimations().forEach((a) => a.cancel());
  el.style.transform = next;
  // Fly above everything, then settle to the real stacking order.
  if (lift) el.style.zIndex = String(Math.max(1000, to.z ?? 1));
  const anim = el.animate([{ transform: from === 'none' ? css(prev) : from }, { transform: next }], {
    duration: ms, delay, easing: EASE, fill: 'backwards',
  });
  anim.onfinish = () => { if (el._spot === to) el.style.zIndex = z; };
}
