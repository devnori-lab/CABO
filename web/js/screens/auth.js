// @ts-check
import { api } from '../api.js';
import { $ } from '../ui.js';

/**
 * @param {HTMLElement} root
 * @param {{ onDone: (user: import('../api.js').User) => void, go: (path: string) => void }} opts
 */
export function authScreen(root, { onDone, go }) {
  let mode = /** @type {'login' | 'signup'} */ ('login');
  root.innerHTML = `
    <main class="screen auth">
      <h1 class="logo">CABO</h1>
      <p class="tag">Remember your cards. Throw fast. Lowest sum wins.</p>
      <div class="panel">
        <div class="tabs"><button type="button" data-m="login" class="on">Log in</button><button type="button" data-m="signup">Sign up</button></div>
        <form novalidate>
          <label class="f signup-only"><span>Username</span><input name="username" autocomplete="username" maxlength="16" placeholder="3–16 letters, numbers or _"></label>
          <label class="f signup-only"><span>Email</span><input name="email" type="email" autocomplete="email" maxlength="254"></label>
          <label class="f login-only"><span>Username or email</span><input name="login" autocomplete="username"></label>
          <label class="f"><span>Password</span><input name="password" type="password" autocomplete="current-password" minlength="8"></label>
          <p class="err" hidden></p>
          <button class="primary wide" type="submit">Log in</button>
        </form>
      </div>
      <button class="link" data-a="practice">or practice against bots first →</button>
      <button class="link" data-a="creator">Creator's corner</button>
    </main>`;
  const form = /** @type {HTMLFormElement} */ ($(root, 'form'));
  const err = $(root, '.err');
  const submit = $(root, 'button[type=submit]');

  const setMode = (/** @type {typeof mode} */ m) => {
    mode = m;
    root.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.m === m));
    $(root, '.auth').dataset.mode = m;
    submit.textContent = m === 'login' ? 'Log in' : 'Create account';
    $(root, 'input[name=password]').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    err.hidden = true;
  };
  setMode('login');
  $(root, '.tabs').addEventListener('click', (/** @type {any} */ e) => e.target.dataset.m && setMode(e.target.dataset.m));
  $(root, '[data-a=practice]').addEventListener('click', () => go('/practice'));
  $(root, '[data-a=creator]').addEventListener('click', () => go('/creator'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    err.hidden = true;
    try {
      const user = mode === 'login'
        ? await api.login({ login: String(f.login), password: String(f.password) })
        : await api.signup({ username: String(f.username), email: String(f.email), password: String(f.password) });
      onDone(user);
    } catch (/** @type {any} */ ex) {
      err.textContent = ex.message;
      err.hidden = false;
      submit.disabled = false;
    }
  });
  return () => {};
}
