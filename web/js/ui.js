// @ts-check
// Small DOM helpers for the menu screens.

/** @param {unknown} s */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** @param {HTMLElement} root @param {string} sel @returns {any} */
export const $ = (root, sel) => root.querySelector(sel);

/** @param {string} text @param {'bad' | ''} [cls] */
export function toast(text, cls = '') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = text;
  box.appendChild(el);
  el.animate(
    [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none', offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }],
    { duration: 2600, easing: 'ease-out' },
  ).onfinish = () => el.remove();
}

/** Segmented control. @param {string} name @param {(number | string)[]} choices @param {number | string} value @param {boolean} [disabled] @param {(c: any) => string} [label] */
export const seg = (name, choices, value, disabled = false, label = String) =>
  `<div class="seg" data-name="${name}">${choices.map((c) => `<button type="button" data-v="${c}" class="${c === value ? 'on' : ''}" ${disabled ? 'disabled' : ''}>${label(c)}</button>`).join('')}</div>`;
