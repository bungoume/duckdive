// MV3 background service worker: the toolbar button opens (or focuses) the app tab.

import { webext } from './webext';

const APP_URL = webext.runtime.getURL('index.html');

async function openApp() {
  const tabs = await webext.tabs.query({ url: APP_URL + '*' });
  const existing = tabs[0];
  if (existing?.id !== undefined) {
    await webext.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await webext.windows.update(existing.windowId, { focused: true });
    return;
  }
  await webext.tabs.create({ url: APP_URL });
}

webext.action.onClicked.addListener(() => {
  openApp().catch((e) => console.error(e));
});

webext.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openApp().catch((e) => console.error(e));
});
