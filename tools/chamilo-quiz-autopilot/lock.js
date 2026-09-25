/*
 * Quiz Autopilot - optional password lock.
 *
 * When config.js has a passwordHash, the popup, the question bank page and the
 * autopilot on quiz pages stay locked until the password is entered. Unlocking
 * lasts until Firefox closes (browser.storage.session) or "Lock" is clicked.
 *
 * Only a salted PBKDF2 hash is stored (make one with scripts/make-password.js).
 * This keeps casual users out; it is not strong protection - someone who edits
 * the add-on's own files can remove it.
 */
(function (root) {
  'use strict';

  // Looked up when needed, so the load order of scripts doesn't matter.
  const ext = () => (typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null);
  const stored = () => String((root.QUIZ_AUTOPILOT_CONFIG || {}).passwordHash || '').trim();
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const enabled = () => !!stored();

  // "pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>"
  async function verify(password, hashString) {
    const parts = String(hashString || stored()).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
    const subtle = root.crypto.subtle;
    const key = await subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const got = new Uint8Array(
      await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(parts[2]), iterations: Number(parts[1]) }, key, 256)
    );
    const want = bytes(parts[3]);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  }

  async function isUnlocked(a) {
    a = a || ext();
    if (!enabled()) return true;
    try {
      return !!(await a.storage.session.get({ unlocked: false })).unlocked;
    } catch (e) {
      return false;
    }
  }

  // After 5 wrong tries, wait 30 s, then 60 s, 120 s ... (up to 8 minutes).
  async function unlock(password, a) {
    a = a || ext();
    const now = Date.now();
    const st = await a.storage.local.get({ lockFailed: 0, lockUntil: 0 });
    if (now < st.lockUntil) return { ok: false, wait: Math.ceil((st.lockUntil - now) / 1000) };
    if (await verify(password)) {
      await a.storage.session.set({ unlocked: true });
      await a.storage.local.set({ lockFailed: 0, lockUntil: 0 });
      return { ok: true };
    }
    const failed = st.lockFailed + 1;
    const until = failed >= 5 ? now + 30000 * 2 ** Math.min(failed - 5, 4) : 0;
    await a.storage.local.set({ lockFailed: failed, lockUntil: until });
    return { ok: false, wait: until ? Math.ceil((until - now) / 1000) : 0 };
  }

  async function lock(a) {
    await (a || ext()).storage.session.set({ unlocked: false });
  }

  // Show a password screen instead of the page until it is unlocked, then run onReady().
  async function guard(onReady) {
    if (await isUnlocked()) return onReady();
    document.body.classList.add('qa-locked');
    const style = document.createElement('style');
    style.textContent = `
      body.qa-locked > *:not(#qaLock) { display: none !important; }
      #qaLock { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
                min-height: 280px; padding: 32px 16px; text-align: center; }
      #qaLock h1 { margin: 0; font-size: 18px; }
      #qaLock p { margin: 0; color: var(--muted); }
      #qaLock form { display: flex; gap: 8px; width: min(320px, 100%); }
      #qaLock input { flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px;
                      background: var(--field); color: var(--fg); font: inherit; }
      #qaLock .err { color: var(--danger); min-height: 1.4em; }`;
    document.head.append(style);
    const box = document.createElement('div');
    box.id = 'qaLock';
    box.innerHTML = `
      <h1>Quiz Autopilot is locked</h1>
      <p>Enter the password to use it.</p>
      <form>
        <input type="password" id="qaPw" aria-label="Password" autocomplete="current-password" required />
        <button type="submit" class="primary">Unlock</button>
      </form>
      <p class="err" role="alert"></p>`;
    document.body.prepend(box);
    const input = box.querySelector('#qaPw');
    input.focus();
    box.querySelector('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await unlock(input.value);
      if (r.ok) {
        box.remove();
        style.remove();
        document.body.classList.remove('qa-locked');
        onReady();
        return;
      }
      input.value = '';
      input.focus();
      box.querySelector('.err').textContent = r.wait
        ? 'Too many wrong tries. Try again in ' + r.wait + ' seconds.'
        : 'Wrong password.';
    });
    return undefined;
  }

  const QuizLock = { enabled, verify, isUnlocked, unlock, lock, guard };
  root.QuizLock = QuizLock;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuizLock;
})(typeof globalThis !== 'undefined' ? globalThis : this);
