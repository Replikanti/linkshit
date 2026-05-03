// Background service worker. Bridges content-script messages from the
// LinkedIn page to the native messaging host that calls the LLM.
//
// Why: content scripts cannot use chrome.runtime.connectNative directly —
// only background contexts can. So content.js sends a `score` message
// here and we relay it to the host through a short-lived native port.

const HOST_NAME = 'com.replikanti.linkshit';

// MV3 service workers go to sleep after ~30 s idle. While processing
// `chrome.runtime.connectNative` traffic, Chrome should keep the worker
// alive — but in practice, when the native host (claude CLI) takes
// longer than the idle window to respond, Chrome can still kill the
// SW mid-batch. The content script then sees:
//   "A listener indicated an asynchronous response by returning true,
//    but the message channel closed before a response was received"
// and the bounded retry kicks in.
//
// Workaround: while we have any in-flight scoring port open, ping a
// cheap chrome API every 20 s. Each call resets the idle timer. The
// pattern is documented across MV3 keep-alive guides and is the
// commonly accepted shape for long-running native-messaging work.
let inFlight = 0;
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
}
function stopKeepAlive() {
  if (inFlight > 0) return;
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

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

    inFlight++;
    startKeepAlive();
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
      inFlight--;
      stopKeepAlive();
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
