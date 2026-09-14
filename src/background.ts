// MV3 background service worker: the toolbar button opens (or focuses) the app tab.

const APP_URL = chrome.runtime.getURL('index.html');

async function openApp() {
  const tabs = await chrome.tabs.query({ url: APP_URL + '*' });
  const existing = tabs[0];
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
}

chrome.action.onClicked.addListener(() => {
  openApp().catch((e) => console.error(e));
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openApp().catch((e) => console.error(e));
});
