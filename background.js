// Background service worker. Bridges content-script messages from the
// LinkedIn page to the native messaging host that calls the LLM.
//
// Why: content scripts cannot use chrome.runtime.connectNative directly —
// only background contexts can. So content.js sends a `score` message
// here and we relay it to the host through a short-lived native port.

const HOST_NAME = 'com.replikanti.linkshit';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'score') return false;

  (async () => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      sendResponse({ ok: false, error: 'failed to connect to native host: ' + e.message });
      return;
    }

    try {
      const result = await sendAndAwait(port, {
        type: 'score',
        criteria: msg.criteria,
        posts: msg.posts,
      });
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    } finally {
      try { port.disconnect(); } catch { /* already gone */ }
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});

function sendAndAwait(port, payload) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      port.onMessage.removeListener(onMsg);
      port.onDisconnect.removeListener(onDisc);
    };
    const onMsg = response => {
      cleanup();
      resolve(response);
    };
    const onDisc = () => {
      cleanup();
      const err = chrome.runtime.lastError?.message
        || 'native host disconnected before responding (is it installed?)';
      reject(new Error(err));
    };
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDisc);
    port.postMessage(payload);
  });
}
