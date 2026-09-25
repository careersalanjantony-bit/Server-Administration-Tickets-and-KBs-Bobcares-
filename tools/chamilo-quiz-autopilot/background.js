/*
 * Quiz Autopilot - cloud sync (background page).
 *
 * The local question bank is a cache of the cloud bank on your Vercel server:
 *   1. local changes are queued (bank.js) and uploaded here,
 *   2. then the full cloud bank is downloaded and replaces the cache
 *      (with any still-unsent local changes re-applied on top).
 * The quiz page asks for a sync before answering each question, so it always
 * answers from the latest cloud data; if the server can't be reached it
 * answers from the cached copy.
 *
 * Messages: { type: 'sync' } | { type: 'connect', url, key } | { type: 'disconnect' } | { type: 'syncInfo' }
 */
(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const B = globalThis.QuizBank;
  const BUILT_IN = globalThis.QUIZ_AUTOPILOT_CONFIG || {};
  let inflight = null;
  let rerun = false; // a change arrived while a sync was running
  let timer = null;

  const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/api(\/questions)?$/, '');

  // Settings saved in the add-on win; otherwise the ones built into config.js.
  async function getConfig() {
    const { syncConfig } = await api.storage.local.get({ syncConfig: null });
    if (syncConfig) return syncConfig.disabled ? { url: '', key: '', disabled: true } : syncConfig;
    return { url: cleanUrl(BUILT_IN.serverUrl), key: String(BUILT_IN.accessKey || '').trim(), builtIn: true };
  }

  async function call(cfg, method, body, qs) {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers = { Authorization: 'Bearer ' + cfg.key };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(cfg.url + '/api/questions' + (qs || ''), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        cache: 'no-store',
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        /* not JSON */
      }
      if (!res.ok) throw new Error((data && data.error) || 'The server answered with error ' + res.status + '.');
      if (!data) throw new Error('The server did not send a question bank. Check the address.');
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The server did not answer in time.');
      if (e instanceof TypeError) throw new Error('Could not reach the server. Check the address and your internet connection.');
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function setStatus(s) {
    await api.storage.local.set({ syncStatus: Object.assign({ at: Date.now() }, s) });
    return s;
  }

  function syncNow() {
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = runSync().finally(() => {
      inflight = null;
      if (rerun) {
        rerun = false;
        syncNow();
      }
    });
    return inflight;
  }

  async function runSync() {
    const cfg = await getConfig();
    if (!cfg.url || !cfg.key) return setStatus({ state: 'off' });
    try {
      const st = await api.storage.local.get({ pendingOps: {}, serverRev: null });
      const sent = Object.values(st.pendingOps);
      let data;
      if (sent.length) {
        data = await call(cfg, 'POST', {
          upsert: sent.filter((o) => o.op === 'upsert').map((o) => o.entry),
          delete: sent.filter((o) => o.op === 'delete').map((o) => o.key),
        });
        // Forget what was uploaded (unless it changed again meanwhile).
        const { pendingOps } = await api.storage.local.get({ pendingOps: {} });
        for (const o of sent) if (pendingOps[o.key] && pendingOps[o.key].t === o.t) delete pendingOps[o.key];
        await api.storage.local.set({ pendingOps });
      } else {
        data = await call(cfg, 'GET', null, st.serverRev != null ? '?rev=' + encodeURIComponent(st.serverRev) : '');
      }
      if (!data.unchanged) {
        const { pendingOps } = await api.storage.local.get({ pendingOps: {} });
        await api.storage.local.set({ bank: B.applyOps(B.fromServer(data.entries), pendingOps), serverRev: data.rev });
      }
      const { bank } = await api.storage.local.get({ bank: [] });
      return setStatus({ state: 'ok', count: bank.length, url: cfg.url });
    } catch (e) {
      return setStatus({ state: 'error', message: e.message, url: cfg.url });
    }
  }

  async function connect(url, key) {
    const prev = await getConfig();
    const cfg = { url: cleanUrl(url), key: String(key || '').trim() || prev.key || '' };
    if (!/^https?:\/\/[^/\s]+/i.test(cfg.url)) return { state: 'error', message: 'Enter the full address, e.g. https://your-project.vercel.app' };
    if (!cfg.key) return { state: 'error', message: 'Enter the access key (BANK_TOKEN).' };
    try {
      await call(cfg, 'GET'); // checks the address and the key before saving them
    } catch (e) {
      return { state: 'error', message: e.message };
    }
    await api.storage.local.set({ syncConfig: cfg, serverRev: null });
    await B.queueAll(api); // upload what this computer already has
    return syncNow();
  }

  async function disconnect() {
    await api.storage.local.set({ syncConfig: { disabled: true }, serverRev: null });
    return setStatus({ state: 'off' });
  }

  async function info() {
    const cfg = await getConfig();
    const { syncStatus, pendingOps } = await api.storage.local.get({ syncStatus: null, pendingOps: {} });
    return { url: cfg.url, hasKey: !!cfg.key, builtIn: !!cfg.builtIn, status: syncStatus, pending: Object.keys(pendingOps).length };
  }

  // The quiz page can't read session storage itself, so it asks here.
  async function lockState() {
    if (!String(BUILT_IN.passwordHash || '').trim()) return { locked: false };
    try {
      return { locked: !(await api.storage.session.get({ unlocked: false })).unlocked };
    } catch (e) {
      return { locked: true };
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === 'lockState') return lockState();
    if (msg.type === 'sync') return syncNow();
    if (msg.type === 'connect') return connect(msg.url, msg.key);
    if (msg.type === 'disconnect') return disconnect();
    if (msg.type === 'syncInfo') return info();
    return undefined;
  });

  // Upload local changes shortly after they happen.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.pendingOps) return;
    if (!Object.keys(changes.pendingOps.newValue || {}).length) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, 400);
  });

  if (api.runtime.onStartup) api.runtime.onStartup.addListener(syncNow);
  if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(syncNow);
})();
