'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;

(async () => {
  const state = document.getElementById('state');
  const openBtn = document.getElementById('open');
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  let info = null;
  try {
    info = await api.tabs.sendMessage(tab.id, { type: 'ping' });
  } catch {
    info = null;
  }
  if (!info) {
    state.textContent = 'Open a Bobcares audit edit page (portal.bobcares.com → server audit → edit) first.';
    return;
  }
  openBtn.disabled = false;
  if (info.running) state.textContent = 'A run is in progress on this page.';
  else if (info.items) state.textContent = 'This page: ' + info.items + ' audit items in ' + info.sections + ' sections.';
  else state.textContent = info.job ? 'A run is paused. Open the panel to see it.' : 'No audit items found on this page.';
  openBtn.addEventListener('click', async () => {
    await api.tabs.sendMessage(tab.id, { type: 'open-panel' });
    window.close();
  });
})();
