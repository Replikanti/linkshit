// Linkshit content script.
//
// Runs on https://www.linkedin.com/feed/* and does:
//   - DOM observation: capture posts as they render (LinkedIn virtualizes
//     the feed, so old posts get unmounted — we must snapshot during scroll)
//   - Auto-scroll with human-like jitter
//   - Pre-filter: keyword/author allowlist + min reactions
//   - Send pre-filtered batches to the background service worker via
//     chrome.runtime.sendMessage; the worker bridges to the native messaging
//     host (host.js) which spawns the LLM
//   - Render hits in a side panel
//   - Persist everything in IndexedDB so already-scored posts are not
//     re-scored on subsequent sessions

(() => {
  'use strict';

  // ---------- CPU mitigation: disable LinkedIn animations / transitions ----------
  // LinkedIn ships an enormous amount of CSS animation: skeleton loaders,
  // hover effects, content fade-ins, count-up odometers, scroll-driven
  // ticker rotations, and so on. With auto-scroll continuously triggering
  // new content mounts, dozens of animations run in parallel on the
  // compositor + main thread. Injecting a near-zero animation/transition
  // duration globally is a known SPA performance trick and routinely cuts
  // CPU by a large fraction on visually busy sites. UX impact: transitions
  // snap instead of fade, but everything still works.
  const __cpuStyle = document.createElement('style');
  __cpuStyle.id = 'linkshit-no-animations';
  __cpuStyle.textContent = '*, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }';
  const __mountStyle = () => { (document.head || document.documentElement).append(__cpuStyle); };
  if (document.head) __mountStyle(); else document.addEventListener('DOMContentLoaded', __mountStyle, { once: true });

  // ---------- Config (persisted in localStorage) ----------
  const NS = 'linkshit.';
  const DEFAULTS = {
    criteria:
      'Posts about AI engineering, technical recruiting, sourcing strategies, ' +
      'engineering leadership, or first-person founder stories. Skip generic ' +
      'motivation, sales pitches, reposted news, lazy AI hype.',
    keywords: ['ai', 'recruit', 'sourc', 'hir', 'engineer', 'llm', 'startup', 'founder'],
    authors: [],
    minReactions: 0,
    maxAgeHours: 0,
    scoreThresh: 7,
    showBorderline: false,
    borderlineDelta: 2,
    scrollMinMs: 5000,
    scrollMaxMs: 10000,
    batchSize: 8,
    maxPosts: 50,
    autoReloadOnCap: true,
  };
  const CFG = {};
  for (const k of Object.keys(DEFAULTS)) {
    const raw = localStorage.getItem(NS + k);
    if (raw == null) {
      CFG[k] = DEFAULTS[k];
    } else if (typeof DEFAULTS[k] === 'object') {
      try { CFG[k] = JSON.parse(raw); } catch { CFG[k] = DEFAULTS[k]; }
    } else if (typeof DEFAULTS[k] === 'number') {
      CFG[k] = +raw;
    } else if (typeof DEFAULTS[k] === 'boolean') {
      CFG[k] = raw === 'true';
    } else {
      CFG[k] = raw;
    }
  }
  const SAVE = (k, v) => {
    CFG[k] = v;
    localStorage.setItem(NS + k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- Criteria profiles ----------
  // localStorage shape:
  //   linkshit.profiles      → [{name, criteria}]
  //   linkshit.activeProfile → name (string)
  // CFG.criteria mirrors the active profile so the rest of the pipeline
  // (scoreBatch) keeps reading CFG.criteria with no awareness of profiles.
  const profiles = { list: [], activeName: '' };
  (function loadProfiles() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(NS + 'profiles')); } catch { /* corrupt */ }
    if (!Array.isArray(raw) || raw.length === 0
        || !raw.every(p => p && typeof p.name === 'string' && typeof p.criteria === 'string')) {
      raw = [{ name: 'Default', criteria: CFG.criteria || DEFAULTS.criteria }];
    }
    profiles.list = raw;
    const stored = localStorage.getItem(NS + 'activeProfile');
    profiles.activeName = stored && raw.find(p => p.name === stored) ? stored : raw[0].name;
    CFG.criteria = profiles.list.find(p => p.name === profiles.activeName).criteria;
    persistProfiles();
  })();
  function persistProfiles() {
    localStorage.setItem(NS + 'profiles', JSON.stringify(profiles.list));
    localStorage.setItem(NS + 'activeProfile', profiles.activeName);
  }
  function activeProfile() {
    return profiles.list.find(p => p.name === profiles.activeName);
  }
  function setActiveProfile(name) {
    const p = profiles.list.find(x => x.name === name);
    if (!p) return;
    profiles.activeName = p.name;
    CFG.criteria = p.criteria;
    persistProfiles();
  }

  // ---------- IndexedDB ----------
  const DB_NAME = 'linkshit', STORE = 'posts';
  const dbReady = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'urn' });
        s.createIndex('score', 'score');
        s.createIndex('status', 'status');
      }
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });
  // IDB callback → Promise wrappers. Extracted so dbPut / dbGet / dbAllScored
  // stay flat instead of nesting `.then(db => new Promise((res, rej) => { ... }))`
  // four levels deep.
  const txDone = tx => new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  const reqDone = req => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const cursorAll = (idx, range) => new Promise(res => {
    const out = [];
    idx.openCursor(range, 'prev').onsuccess = e => {
      const c = e.target.result;
      if (c) { out.push(c.value); c.continue(); } else res(out);
    };
  });
  async function dbPut(post) {
    const db = await dbReady;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(post);
    return txDone(tx);
  }
  async function dbGet(urn) {
    const db = await dbReady;
    return reqDone(db.transaction(STORE, 'readonly').objectStore(STORE).get(urn));
  }
  async function dbAllScored(min) {
    const db = await dbReady;
    const idx = db.transaction(STORE, 'readonly').objectStore(STORE).index('score');
    return cursorAll(idx, IDBKeyRange.lowerBound(min));
  }
  async function dbAllQueued() {
    const db = await dbReady;
    const idx = db.transaction(STORE, 'readonly').objectStore(STORE).index('status');
    return cursorAll(idx, IDBKeyRange.only('queued'));
  }

  // ---------- Extractor ----------
  // LinkedIn periodically rewrites the feed DOM. If captured stays at 0
  // open DevTools on linkedin.com/feed/ and locate the new feed container
  // (currently `[data-testid="mainFeed"]`) and post markers (currently
  // `[data-testid="expandable-text-box"]` for body, `a[href*="/in/"]` for
  // author). The pattern: pick attributes you can sanity-check via
  // distribution counts, not class names — class names are hashed as of
  // 2026-05.
  const FEED_SEL = '[data-testid="mainFeed"]';
  const POST_TEXT_SEL = '[data-testid="expandable-text-box"]';
  const AUTHOR_SEL = 'a[href*="/in/"], a[href*="/company/"]';

  // djb2 — short stable string hash for synthesizing a URN-equivalent
  // dedup key. The new DOM no longer carries `urn:li:activity:` so we
  // hash (author profile URL + first 200 chars of post text) instead.
  // Collision risk: same author posting the exact same opening 200
  // chars twice — vanishingly rare and would be a duplicate post anyway.
  function djb2(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = Math.trunc((h << 5) + h + s.charCodeAt(i));
    }
    return (h >>> 0).toString(36);
  }
  // Sponsored posts carry a small "Promoted" / "Sponsored" label somewhere
  // inside the post wrapper. The old DOM scoped this to .update-components-actor;
  // that scope no longer exists, so scan the whole wrapper. Exact-string
  // match keeps body text using the words from being misclassified.
  function isPromoted(el) {
    for (const node of el.querySelectorAll('span, div')) {
      const t = (node.textContent || '').trim();
      if (t === 'Promoted' || t === 'Sponsored') return true;
    }
    return false;
  }
  // LinkedIn renders post age as relative text (2h, 3d, 1mo, 2y) in the
  // actor sub-description. Returns hours or null when unparseable; null
  // is treated as "do not filter" (defensive — would rather over-include).
  // The unit table starts with the longer keys so "mo" / "min" beat "m".
  // String-based dispatch (instead of one alternation regex) keeps the
  // hot path linear and avoids ReDoS-leaning patterns.
  const AGE_UNITS = [
    ['mo', 720],
    ['min', 1 / 60],
    ['s', 1 / 3600],
    ['m', 1 / 60],
    ['h', 1],
    ['d', 24],
    ['w', 168],
    ['y', 8760],
  ];
  function parseAgeHours(text) {
    if (!text) return null;
    const digits = /(\d+)/.exec(text);
    if (!digits) return null;
    const n = Number.parseInt(digits[1], 10);
    if (!Number.isFinite(n)) return null;
    const rest = text.slice(digits.index + digits[0].length).trimStart().toLowerCase();
    if (!rest) return null;
    for (const [unit, factor] of AGE_UNITS) {
      if (rest.startsWith(unit)) return n * factor;
    }
    return null;
  }
  function extractAgeHours(el) {
    // Best-effort scan over short text nodes inside the post wrapper.
    // The previous .update-components-actor__sub-description anchor is
    // dead. Default maxAgeHours=0 disables this path entirely so a noisy
    // match here does not affect users who have not opted in.
    for (const node of el.querySelectorAll('span')) {
      const t = (node.textContent || '').trim();
      if (!t || t.length > 30) continue;
      const h = parseAgeHours(t);
      if (h != null) return h;
    }
    return null;
  }
  // Walk up from a post-text element to the smallest ancestor that also
  // contains an author link — that is the post wrapper. Stops at feed
  // itself so we never escape into the page chrome. Used by capture to
  // turn each [data-testid="expandable-text-box"] into a wrapper that
  // extractPost / isPromoted / extractAgeHours all operate on.
  function findWrapper(textBox, feed) {
    let n = textBox.parentElement;
    while (n && n !== feed) {
      if (n.querySelector(AUTHOR_SEL)) return n;
      n = n.parentElement;
    }
    return null;
  }
  function extractPost(el) {
    const textEl = el.querySelector(POST_TEXT_SEL);
    if (!textEl) return null;
    // Each post carries ~2 author links: an avatar wrapper around an
    // <img> (first in DOM order, empty innerText) and the name link.
    // Pick the first link whose innerText has a non-empty first line so
    // the avatar wrapper does not poison the author field.
    let authorLink = null, authorRaw = null;
    for (const a of el.querySelectorAll(AUTHOR_SEL)) {
      const raw = (a.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      if (raw[0]) { authorLink = a; authorRaw = raw; break; }
    }
    if (!authorLink) return null;
    const author = authorRaw[0];
    const text = (textEl.innerText || '').trim();
    if (!text || text.length < 30) return null;
    const subtitle = authorRaw.slice(1).join(' · ').slice(0, 200);
    // Real post permalink if present (rare in the new DOM, kept as a
    // best-effort) — fall back to the author profile so "Open on
    // LinkedIn →" lands somewhere relevant.
    const permaLink = el.querySelector('a[href*="/feed/update/"]') || el.querySelector('a[href*="/posts/"]');
    const url = permaLink?.href || authorLink.href;
    // Synthetic URN for IndexedDB key + dedup. Stable per (author, text).
    const urn = 'lks:' + djb2(authorLink.href + '|' + text.slice(0, 200));
    return {
      urn,
      author,
      subtitle,
      text,
      // Reactions count moved out of the public DOM in the 2026-05 rewrite.
      // Set to 0 so default minReactions=0 still admits the post; a
      // stricter minReactions setting will currently reject everything,
      // which is documented limitation until we identify the new marker.
      reactions: 0,
      url,
      capturedAt: Date.now(),
      status: 'new',
    };
  }

  // ---------- Pre-filter ----------
  function preFilter(p) {
    if (!p.text || p.text.length < 30) return false;
    if (p.reactions < CFG.minReactions) return false;
    const hay = (p.author + ' ' + p.text).toLowerCase();
    if (CFG.authors.length && CFG.authors.some(a => p.author.toLowerCase().includes(a.toLowerCase()))) return true;
    if (CFG.keywords.length && CFG.keywords.some(k => hay.includes(k.toLowerCase()))) return true;
    return CFG.keywords.length === 0 && CFG.authors.length === 0;
  }

  // ---------- Orphan-content-script detection ----------
  // After the user reloads the extension via chrome://extensions, every
  // already-open LinkedIn tab keeps running its old content script. The
  // chrome.runtime context is invalidated; any chrome.* call throws
  // "Extension context invalidated", which Chrome itself reports as a
  // runtime error on the extensions page regardless of how we wrap it.
  // We can't undo Chrome's reporting, but we can stop generating new
  // ones — short-circuit anything that touches chrome.* in this script
  // once the context is gone, and surface a hint that the tab needs F5.
  function isAlive() {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  }
  let invalidatedAnnounced = false;
  function announceInvalidated() {
    if (invalidatedAnnounced) return;
    invalidatedAnnounced = true;
    try { ui.setStatus('Extension reloaded — refresh tab (F5) to continue.'); } catch { /* panel might be gone */ }
  }

  // ---------- Score via background service worker → native messaging host ----------
  async function scoreBatch(posts) {
    if (!isAlive()) {
      announceInvalidated();
      const err = new Error('Extension context invalidated');
      err.code = 'context_invalidated';
      throw err;
    }
    const response = await chrome.runtime.sendMessage({
      type: 'score',
      criteria: CFG.criteria,
      posts,
    });
    if (!response?.ok) {
      const err = new Error(response?.error || 'no response from native host');
      err.code = response?.code;
      throw err;
    }
    const arr = response.result;
    if (!Array.isArray(arr)) {
      throw new TypeError('host returned non-array result');
    }
    return posts.map((p, i) => {
      const f = arr.find(x => x.id === i + 1) || arr[i] || { score: 0, reason: 'no-score' };
      return { ...p, score: Math.trunc(f.score) || 0, reason: f.reason || '', status: 'scored' };
    });
  }

  const queue = [];
  let scoring = false;
  // Sticky force flag: if Stop/end-of-feed asks for a flush while a batch is
  // already in flight, we still want to drain the remainder once the batch
  // completes — even if it's smaller than batchSize.
  let pendingForce = false;
  // Set when the host returns code='quota_exhausted'. Blocks further flushes
  // until the user clicks Resume (startScroll clears the flag) — without it,
  // the auto re-flush at the end of maybeFlush would immediately retry and
  // burn the next request against the still-exhausted limit.
  let quotaPaused = false;
  // Bounded retry on non-quota scoring errors. Without this the catch path
  // re-queues the failed batch, sleeps 15 s, and the finally block calls
  // maybeFlush() recursively — same batch fails again, every 15 s, forever.
  // In a background tab where Chrome MV3 kills the service worker, every
  // batch fails until the user refocuses, and the deferred retries fire in
  // a thunderstorm when they do. After 3 consecutive non-quota failures we
  // pause exactly like the quota path; manual Resume clears the flag.
  let scoringStalled = false;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;
  async function maybeFlush(force = false) {
    if (quotaPaused || scoringStalled) return;
    if (!isAlive()) { announceInvalidated(); return; }
    if (force) pendingForce = true;
    if (scoring || queue.length === 0) return;
    if (queue.length < CFG.batchSize && !pendingForce) return;
    // Don't burn CPU on hidden tabs — Chrome throttles setTimeout to ~1/min
    // there but the recursive promise chain doesn't care, leading to
    // backpressure when the user refocuses. Resumed automatically on
    // visibilitychange.
    if (document.visibilityState === 'hidden') return;
    scoring = true;
    const batch = queue.splice(0, CFG.batchSize);
    ui.setStatus(`Scoring ${batch.length} (${queue.length} queued)…`);
    try {
      const scored = await scoreBatch(batch);
      consecutiveErrors = 0;
      for (const s of scored) {
        await dbPut(s);
        if (s.score >= CFG.scoreThresh) {
          ui.addResult(s);
        } else if (CFG.showBorderline && s.score >= CFG.scoreThresh - CFG.borderlineDelta) {
          ui.addResult({ ...s, borderline: true });
        }
      }
      ui.bump('scored', scored.length);
      ui.setStatus(scrollTimer ? 'Scrolling…' : 'Idle.');
    } catch (e) {
      // warn rather than error so transient Chrome MV3 service-worker
      // lifecycle hiccups (cold-start sendMessage, port disconnected
      // mid-batch as SW gets killed, etc.) don't badge the extension
      // red on chrome://extensions. The bounded-retry / quotaPaused
      // logic already handles real failures cleanly; the message stays
      // visible in DevTools for genuine debugging.
      console.warn('[Linkshit]', e);
      for (const p of batch) queue.unshift(p);
      if (e.code === 'quota_exhausted') {
        quotaPaused = true;
        pauseScroll();
        ui.setStatus('Quota hit; click Resume to retry.');
      } else {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          scoringStalled = true;
          pauseScroll();
          ui.setStatus(`Scoring stalled after ${consecutiveErrors} errors; click Resume.`);
        } else {
          ui.setStatus(`Error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${e.message}`);
          await sleep(15000);
        }
      }
    } finally {
      scoring = false;
      if (queue.length === 0) pendingForce = false;
      if (!quotaPaused && !scoringStalled
          && (queue.length >= CFG.batchSize || (pendingForce && queue.length > 0))) {
        maybeFlush();
      }
    }
  }
  // Background-tab CPU starvation watchdog. When Chrome refocuses the tab
  // after long inactivity, deferred timers fire in a burst. Resuming
  // scoring here is fine; the bounded retry counter and visibility check
  // in maybeFlush prevent the burst from spiralling.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !quotaPaused && !scoringStalled) {
      maybeFlush();
    }
  });

  // ---------- Rescore (re-run scoring against current criteria) ----------
  async function rescoreAll() {
    const stored = await dbAllScored(0);
    if (stored.length === 0) {
      ui.setStatus('Nothing to rescore.');
      return;
    }
    const batches = Math.ceil(stored.length / CFG.batchSize);
    if (!confirm(
      `Re-score ${stored.length} stored posts in ~${batches} batches with current criteria?\n\n`
      + 'This will consume LLM quota.',
    )) return;

    const wasRunning = !!scrollTimer;
    if (wasRunning) pauseScroll();
    ui.clearResults();

    for (let i = 0; i < stored.length; i += CFG.batchSize) {
      const batch = stored.slice(i, i + CFG.batchSize);
      ui.setStatus(`Rescoring ${i + 1}-${i + batch.length} of ${stored.length}…`);
      try {
        const scored = await scoreBatch(batch);
        for (const s of scored) {
          await dbPut(s);
          if (s.score >= CFG.scoreThresh) {
            ui.addResult(s);
          } else if (CFG.showBorderline && s.score >= CFG.scoreThresh - CFG.borderlineDelta) {
            ui.addResult({ ...s, borderline: true });
          }
        }
      } catch (e) {
        ui.setStatus(`Rescore failed: ${e.message}`);
        if (wasRunning) startScroll();
        return;
      }
    }
    ui.setStatus(`Rescored ${stored.length}.`);
    if (wasRunning) startScroll();
  }

  // ---------- Capture (MutationObserver) ----------
  const seen = new Set();
  async function tryCapture(el) {
    // seen.add happens before the await on dbGet, so an unhandled rejection
    // there would leave the urn permanently dedup-skipped without ever
    // reaching the captured bump. One bad IDB record (e.g. a stale entry
    // from a prior urn scheme) would freeze the counter for that post.
    // Catch and warn so the pipeline keeps moving.
    try {
      const post = extractPost(el);
      if (!post || seen.has(post.urn)) return;
      seen.add(post.urn);
      if (isPromoted(el)) {
        ui.bump('promoted', 1);
        return;
      }
      if (CFG.maxAgeHours > 0) {
        const age = extractAgeHours(el);
        if (age != null && age > CFG.maxAgeHours) {
          ui.bump('tooOld', 1);
          return;
        }
      }
      const ex = await dbGet(post.urn);
      if (ex?.status === 'scored') {
        // Re-encountering a post the LLM already scored in a previous
        // session counts toward `scored` so the panel invariant
        // hits ≤ scored holds across reloads.
        ui.bump('scored', 1);
        if (ex.score >= CFG.scoreThresh) ui.addResult(ex);
        else if (CFG.showBorderline && ex.score >= CFG.scoreThresh - CFG.borderlineDelta) {
          ui.addResult({ ...ex, borderline: true });
        }
        return;
      }
      if (ex?.status === 'queued') {
        // Already drained from disk into the in-memory queue at boot; nothing to do.
        return;
      }
      ui.bump('captured', 1);
      if (preFilter(post)) {
        post.status = 'queued';
        await dbPut(post);
        queue.push(post);
        ui.bump('queued', 1);
        maybeFlush();
      } else {
        await dbPut(post);
      }
    } catch (e) {
      console.warn('[linkshit] tryCapture failed:', e);
    }
  }
  function startObserver() {
    // The feed list is rendered lazily by LinkedIn's React shell. Two earlier
    // attempts (subtree on the feed wrapper) failed in production: LinkedIn
    // periodically re-mounts the feed element, which leaves any observer
    // bound to the old node detached and silent.
    //
    // PR #58 worked around that by observing document.body subtree:true.
    // That caught everything but is the suspected cause of long-session
    // tab crashes (#63 Symptom A) — body subtree fires on every animation,
    // hover, video buffer, and unrelated React update across the whole
    // page, allocating MutationRecord arrays at browser-tick rate.
    //
    // <main> is the document layout container, sits above the React app,
    // and outlives feed re-mounts. Subtree observation rooted at <main>
    // still catches every text-box mount that PR #58 needed but ignores
    // header / left rail / chat panel / video chrome traffic.
    //
    // Defensive: if we ever observe an element that gets detached from
    // the document (rare but possible), the next rescan re-attaches.
    // Falls back to document.body when <main> is not yet present so the
    // first paint window still works.
    // Marker-based fast-skip on text-box nodes. Without this the rescan
    // re-runs extractPost / isPromoted (each a querySelectorAll) for every
    // visible post on every tick — ~30-50 wrappers × ~3 rescans/sec = 90-150
    // parallel async tryCapture invocations/sec, each allocating a Promise
    // and an IDB transaction. Suspected cause of #63 Symptom A (tab crash
    // around captured ~230 even after the <main>-scoped observer in #66).
    //
    // Stamping the text-box element itself means LinkedIn's virtualization
    // (it unmounts off-screen posts and remounts new ones) automatically
    // resets the marker for any genuinely new node. urn-based dedup in
    // tryCapture stays as the second line of defense for the same post text
    // re-mounted under a different DOM node.
    const RESCAN_MARK = '__lksRescanProcessed';
    const DEBOUNCE_MS = 500;
    let pending = false;
    let observed = null;
    let observer = null;
    const rescan = () => {
      pending = false;
      const root = document.querySelector('main') || document.body;
      if (root !== observed || (observed && !document.contains(observed))) {
        if (observer) observer.disconnect();
        observed = root;
        observer = new MutationObserver(() => {
          if (pending) return;
          pending = true;
          setTimeout(rescan, DEBOUNCE_MS);
        });
        observer.observe(observed, { childList: true, subtree: true });
      }
      const feed = document.querySelector(FEED_SEL);
      if (!feed) return;
      for (const tb of feed.querySelectorAll(POST_TEXT_SEL)) {
        if (tb[RESCAN_MARK]) continue;
        tb[RESCAN_MARK] = true;
        const wrapper = findWrapper(tb, feed);
        if (wrapper) tryCapture(wrapper);
      }
    };
    rescan();
    // Polling fallback. The MutationObserver alone does not reliably fire
    // on this LinkedIn DOM — React reconciliation in some cases produces
    // mutations the observer never wakes up on, so the capture pipeline
    // stays silent even as the user is visibly scrolling and new posts
    // are mounting. Polling rescues the pipeline. Marker-skip in the loop
    // body means each tick is essentially free if MO already kept up
    // (every visible text-box is marked, the for loop is a no-op);
    // newly-mounted nodes are processed exactly once. Hidden-tab guard
    // matches the auto-scroll tick so we don't burn CPU in background.
    const pollHandle = setInterval(() => {
      if (!isAlive()) {
        // Orphaned content script after extension reload. Stop polling
        // entirely — without this we'd keep firing rescan + tryCapture +
        // dbGet (still works, IDB is page-local) and eventually hit
        // chrome.runtime via maybeFlush, generating Chrome-reported
        // errors on the extensions page.
        clearInterval(pollHandle);
        announceInvalidated();
        return;
      }
      if (document.visibilityState === 'hidden') return;
      rescan();
    }, 2000);
  }

  // ---------- Scroller (human-like pacing) ----------
  let scrollTimer = null, lastH = 0, stable = 0, postsAtStart = 0, paused = false;
  function startScroll() {
    if (scrollTimer) return;
    // Resuming from a pause keeps the original maxPosts baseline so the
    // session as a whole still respects the cap; a fresh start resets it.
    if (!paused) postsAtStart = seen.size;
    paused = false;
    // Manual Start / Resume always retries scoring after a stall — the
    // user clicking the button is the explicit "try again" signal. Same
    // for the bounded-retry stall path.
    if (quotaPaused || scoringStalled) {
      quotaPaused = false;
      scoringStalled = false;
      consecutiveErrors = 0;
      // Drain any queue that piled up while paused.
      maybeFlush();
    }
    const tick = () => {
      if (!scrollTimer) return;
      // Skip ticks while the tab is hidden — the LLM can't see anything
      // useful and Chrome throttles us anyway. Resumed automatically when
      // the user returns to the tab. No jitter here: we are just polling
      // visibility, not pretending to be a human, and the visibilitychange
      // listener wakes us up immediately on refocus.
      if (document.visibilityState === 'hidden') {
        scrollTimer = setTimeout(tick, 30000);
        return;
      }
      // The 2026-05 React rewrite moved scroll out of document.body into a
      // flex-grow <main>; window.scrollTo / body.scrollHeight are no-ops on
      // that DOM and the height-stable check trips after the initial render.
      // Resolve the real container per tick (cheap, survives <main>
      // re-mount) and fall back to the document scroller / body so older
      // or future LinkedIn variants that scroll the document still work.
      const scroller = document.querySelector('main') || document.scrollingElement || document.body;
      scroller.scrollTo(0, scroller.scrollHeight);
      // Pause every <video> in the feed before processing the rest of
      // the tick. LinkedIn auto-plays inline videos as they scroll into
      // view; left to its own devices, every post in a long auto-scroll
      // session ends up with a continuously playing video on the main
      // thread. Each running video adds CPU + GPU + decoder memory
      // pressure, compounding with the React reconciliation cost as the
      // feed DOM grows. LinkedIn re-starts a video when it next comes
      // back into view (IntersectionObserver-driven), so this only
      // affects the off-screen accumulation.
      for (const v of document.querySelectorAll('video')) {
        if (!v.paused) { try { v.pause(); } catch { /* not all videos accept programmatic pause */ } }
      }
      // Throttle off-screen images. There's no API to "pause" a still
      // image, but we can give the browser explicit hints to skip
      // decoding, paint and composite work on images that are far above
      // the current viewport. content-visibility:auto + decoding:async
      // lets Chrome lazily decode and skip layout for content the user
      // can't see, which is the bulk of the feed once the user has
      // scrolled a few screens. We only stamp once per element via the
      // __lksPicHinted flag so this is essentially free per tick.
      for (const im of document.querySelectorAll('img')) {
        if (im.__lksPicHinted) continue;
        im.__lksPicHinted = true;
        if (!im.decoding) im.decoding = 'async';
        if (!im.loading) im.loading = 'lazy';
        // content-visibility on the image's wrapping <picture> or parent
        // span gives the biggest wins; on the <img> itself it has no
        // effect, so apply to the closest block-ish container.
        const block = im.closest('picture, span, div');
        if (block && !block.style.contentVisibility) block.style.contentVisibility = 'auto';
      }
      document.querySelectorAll('button').forEach(b => {
        const t = (b.innerText || '').toLowerCase();
        if (t.includes('load more comment') || t.includes('show more replies')
         || t.includes('zobrazit další') || t.includes('načíst předchozí')) b.click();
      });
      const h = scroller.scrollHeight;
      if (h === lastH) {
        if (++stable > 6) { stopScroll(); ui.setStatus('End of feed.'); maybeFlush(true); return; }
      } else {
        stable = 0; lastH = h;
      }
      if (seen.size - postsAtStart >= CFG.maxPosts) {
        // LinkedIn does not virtualize its feed; long auto-scroll sessions
        // grow the page DOM unbounded until the renderer crashes (#63).
        // We can't stop LinkedIn from doing that, but we can recycle the
        // tab on a fixed cadence so it never reaches the crash zone.
        //
        // This is NOT a hard session limit. Queue and IDB persist across
        // the reload, the resume flag below tells the next boot to call
        // startScroll() automatically once the queue is drained, and the
        // user effectively gets a continuous session — just bounced
        // through periodic invisible DOM recycles.
        stopScroll();
        maybeFlush(true);
        if (CFG.autoReloadOnCap) {
          localStorage.setItem(NS + 'resumeOnBoot', '1');
          ui.setStatus(`Recycling LinkedIn DOM (every ${CFG.maxPosts} posts) — refreshing tab in 5s, scrolling will auto-resume…`);
          setTimeout(() => globalThis.location.reload(), 5000);
        } else {
          ui.setStatus(`Cap (${CFG.maxPosts}) reached. Refresh tab to continue.`);
        }
        return;
      }
      const delay = CFG.scrollMinMs + Math.random() * (CFG.scrollMaxMs - CFG.scrollMinMs);
      scrollTimer = setTimeout(tick, delay);
    };
    scrollTimer = setTimeout(tick, 500);
    ui.setStatus('Scrolling…');
    ui.refreshControls();
  }
  function pauseScroll() {
    if (!scrollTimer) return;
    clearTimeout(scrollTimer);
    scrollTimer = null;
    paused = true;
    ui.setStatus('Paused.');
    ui.refreshControls();
  }
  function stopScroll() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = null;
    paused = false;
    ui.setStatus('Stopped.');
    ui.refreshControls();
  }

  // ---------- UI ----------
  // Colours flow through CSS variables on #lks-panel so a single
  // prefers-color-scheme: dark media query swaps the entire palette
  // without duplicating every selector.
  const STYLE = `
    #lks-panel{
      --bg:#fff; --fg:#111;
      --border:#ddd; --border-subtle:#eee; --row-border:#f0f0f0;
      --status-bg:#fafafa;
      --muted:#555; --muted-2:#666;
      --btn-bg:#f5f5f5; --btn-border:#aaa;
      --primary:#0a66c2; --primary-fg:#fff;
      --hint-bg:#f6f9ff; --hint-fg:#444;
      --reason:#555; --snippet:#333;
      --field-bg:#fff; --field-border:#ccc;
      --shadow:0 4px 16px rgba(0,0,0,.1);
      position:fixed;right:12px;top:80px;width:380px;max-height:82vh;
      background:var(--bg);color:var(--fg);
      border:1px solid var(--border);border-radius:8px;
      box-shadow:var(--shadow);z-index:999999;
      font:13px system-ui;display:flex;flex-direction:column}
    @media (prefers-color-scheme: dark){
      #lks-panel{
        --bg:#1d2226; --fg:#e8e8e8;
        --border:#3d4145; --border-subtle:#2a2e33; --row-border:#2a2e33;
        --status-bg:#15191c;
        --muted:#a0a4a8; --muted-2:#888c90;
        --btn-bg:#2a2e33; --btn-border:#555;
        --primary:#0a66c2; --primary-fg:#fff;
        --hint-bg:#1c2b3a; --hint-fg:#cfd6dc;
        --reason:#b0b0b0; --snippet:#d0d0d0;
        --field-bg:#15191c; --field-border:#3d4145;
        --shadow:0 4px 16px rgba(0,0,0,.5)}
    }
    #lks-panel header{padding:8px 12px;border-bottom:1px solid var(--border-subtle);font-weight:600;
      display:flex;justify-content:space-between;align-items:center;cursor:move;
      user-select:none}
    #lks-panel header button{cursor:pointer}
    #lks-panel header select{cursor:pointer;font:inherit;background:var(--field-bg);
      color:var(--fg);border:1px solid var(--field-border);border-radius:3px;padding:1px 4px}
    #lks-panel #lks-resize{position:absolute;left:0;top:0;bottom:0;width:6px;
      cursor:ew-resize;background:transparent;z-index:1}
    #lks-panel .body{padding:8px 12px;overflow-y:auto;flex:1}
    #lks-panel button{padding:4px 10px;margin-left:4px;border:1px solid var(--btn-border);
      background:var(--btn-bg);color:var(--fg);
      border-radius:4px;cursor:pointer;font:inherit}
    #lks-panel button.primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}
    #lks-panel .status{padding:6px 12px;font-size:12px;color:var(--muted);background:var(--status-bg);
      border-top:1px solid var(--border-subtle);border-bottom:1px solid var(--border-subtle)}
    #lks-panel .counters{padding:6px 12px;font-size:11px;color:var(--muted-2);display:flex;gap:12px;
      border-bottom:1px solid var(--border-subtle)}
    #lks-panel .hint{padding:10px 12px;font-size:12px;color:var(--hint-fg);background:var(--hint-bg);
      border-bottom:1px solid var(--border-subtle);line-height:1.45}
    #lks-panel .history-controls{display:flex;flex-direction:column;gap:4px;
      padding-bottom:8px;border-bottom:1px solid var(--border-subtle);margin-bottom:6px}
    #lks-panel .history-controls input[type=text]{box-sizing:border-box;width:100%;
      background:var(--field-bg);color:var(--fg);border:1px solid var(--field-border);
      border-radius:3px;padding:3px 5px;font:inherit}
    #lks-panel .history-controls input[type=range]{width:100%}
    #lks-panel .history-empty{color:var(--muted);font-size:12px;padding:8px 0}
    #lks-panel .result{padding:8px 0;border-bottom:1px solid var(--row-border)}
    #lks-panel .result.borderline{opacity:.6;border-left:3px dotted var(--btn-border);
      padding-left:6px;margin-left:-6px}
    #lks-panel .result.borderline .score{background:var(--btn-bg);color:var(--muted);
      border:1px solid var(--btn-border)}
    #lks-panel .result .author{font-weight:600}
    #lks-panel .result .score{float:right;background:var(--primary);color:var(--primary-fg);padding:1px 6px;
      border-radius:3px;font-size:11px}
    #lks-panel .result .reason{font-style:italic;color:var(--reason);margin:2px 0}
    #lks-panel .result .snippet{color:var(--snippet);font-size:12px;max-height:64px;overflow:hidden}
    #lks-panel .result a{color:var(--primary);text-decoration:none;font-size:11px}
    #lks-settings textarea,#lks-settings input{width:100%;box-sizing:border-box;
      margin:2px 0 6px;font-family:inherit;font-size:12px;
      background:var(--field-bg);color:var(--fg);border:1px solid var(--field-border);
      border-radius:3px;padding:3px 5px}
    #lks-settings label{font-size:11px;color:var(--muted);display:block;margin-top:4px}
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.append(styleEl);

  const ui = (() => {
    const panel = document.createElement('div');
    panel.id = 'lks-panel';
    panel.innerHTML = `
      <div id="lks-resize"></div>
      <header>
        <span>Linkshit<span id="lks-profile-wrap" style="display:none"> · Profile: <select id="lks-profile" title="Active profile"></select></span></span>
        <span>
          <button id="lks-start" class="primary">Start</button>
          <button id="lks-pause">Pause</button>
          <button id="lks-stop">Stop</button>
          <button id="lks-history-toggle">History</button>
          <button id="lks-cog">⚙</button>
        </span>
      </header>
      <div class="counters">
        <span>captured <b id="lks-c-captured">0</b></span>
        <span>promoted <b id="lks-c-promoted">0</b></span>
        <span>old <b id="lks-c-tooOld">0</b></span>
        <span>queued <b id="lks-c-queued">0</b></span>
        <span>scored <b id="lks-c-scored">0</b></span>
        <span>hits <b id="lks-c-hits">0</b></span>
      </div>
      <div class="status" id="lks-status">Idle.</div>
      <div class="hint" id="lks-hint" style="display:none">
        Set your <b>Criteria</b> in <b>⚙</b> → click <b>Start</b> to begin scoring your feed.
      </div>
      <div class="body" id="lks-body"></div>
      <div class="body" id="lks-history" style="display:none">
        <div class="history-controls">
          <label>Min score: <b id="lks-history-min">0</b></label>
          <input id="lks-history-range" type="range" min="0" max="10" step="1" value="0"/>
          <input id="lks-history-search" type="text" placeholder="Search author or text…"/>
        </div>
        <div id="lks-history-list"></div>
      </div>
      <div class="body" id="lks-settings" style="display:none;border-top:1px solid #eee;">
        <label>Criteria (active profile)</label><textarea id="s-criteria" rows="5"></textarea>
        <div style="margin:2px 0 6px">
          <button id="s-profile-new">New profile</button>
          <button id="s-profile-rename">Rename</button>
          <button id="s-profile-dup">Duplicate</button>
          <button id="s-profile-del">Delete</button>
        </div>
        <label>Pre-filter keywords (comma-separated)</label><input id="s-keywords"/>
        <label>Author allowlist (comma-separated substrings)</label><input id="s-authors"/>
        <label>Min reactions</label><input id="s-minReactions" type="number"/>
        <label>Max age (hours, 0 = unlimited)</label><input id="s-maxAgeHours" type="number"/>
        <label>Score threshold to surface</label><input id="s-scoreThresh" type="number"/>
        <label><input id="s-showBorderline" type="checkbox" style="width:auto;margin-right:6px"/>Show borderline (within N below threshold)</label>
        <label>Borderline N</label><input id="s-borderlineDelta" type="number"/>
        <label>Scroll delay min / max ms</label>
        <input id="s-scrollMinMs" type="number"/><input id="s-scrollMaxMs" type="number"/>
        <label>Batch size</label><input id="s-batchSize" type="number"/>
        <label>Max posts per session</label><input id="s-maxPosts" type="number"/>
        <button id="s-save" class="primary">Save</button>
        <button id="s-cancel">Cancel</button>
        <button id="s-rescore">Rescore stored</button>
        <button id="s-clear">Clear DB</button>
      </div>`;
    document.body.append(panel);
    const $ = id => panel.querySelector('#' + id);

    // ---------- Geometry: drag-to-move + resize-from-left, persisted ----------
    const GEOM_KEY = NS + 'panel.geometry';
    const MIN_W = 280, MAX_W = 720, MIN_VISIBLE_X = 100, MIN_VISIBLE_Y = 60;
    function applyGeom(g) {
      panel.style.right = '';
      panel.style.left = g.left + 'px';
      panel.style.top = g.top + 'px';
      panel.style.width = g.width + 'px';
    }
    function saveGeom() {
      const r = panel.getBoundingClientRect();
      localStorage.setItem(GEOM_KEY, JSON.stringify({
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
      }));
    }
    try {
      const raw = localStorage.getItem(GEOM_KEY);
      if (raw) applyGeom(JSON.parse(raw));
    } catch { /* ignore corrupt geometry */ }

    function startDrag(e, onMove) {
      e.preventDefault();
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveGeom();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    panel.querySelector('header').addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = rect.left, startTop = rect.top;
      startDrag(e, e2 => {
        const newLeft = Math.max(
          MIN_VISIBLE_X - rect.width,
          Math.min(window.innerWidth - MIN_VISIBLE_X, startLeft + e2.clientX - startX),
        );
        const newTop = Math.max(
          0,
          Math.min(window.innerHeight - MIN_VISIBLE_Y, startTop + e2.clientY - startY),
        );
        panel.style.right = '';
        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
      });
    });
    $('lks-resize').addEventListener('mousedown', e => {
      const rect = panel.getBoundingClientRect();
      const startX = e.clientX;
      const startWidth = rect.width, startLeft = rect.left;
      startDrag(e, e2 => {
        const dx = startX - e2.clientX;
        const newWidth = Math.max(MIN_W, Math.min(MAX_W, startWidth + dx));
        const widthDelta = newWidth - startWidth;
        panel.style.right = '';
        panel.style.left = (startLeft - widthDelta) + 'px';
        panel.style.width = newWidth + 'px';
      });
    });
    const counters = { captured: 0, promoted: 0, tooOld: 0, queued: 0, scored: 0, hits: 0 };
    // Track URNs already rendered in the panel so the boot replay + later
    // scroll-into-view of the same post don't produce duplicate rows.
    const rendered = new Set();

    function refreshProfileSelector() {
      const sel = $('lks-profile');
      sel.innerHTML = '';
      for (const p of profiles.list) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        if (p.name === profiles.activeName) opt.selected = true;
        sel.append(opt);
      }
      // Hide the whole "· Profile: [select]" affordance when a single profile
      // exists — at that point the dropdown is just a confusing title-suffix
      // with one inert option. It pops back the moment the user creates a
      // second profile in ⚙.
      $('lks-profile-wrap').style.display = profiles.list.length > 1 ? '' : 'none';
    }
    refreshProfileSelector();

    const sync = () => {
      $('s-criteria').value = CFG.criteria;
      $('s-keywords').value = CFG.keywords.join(', ');
      $('s-authors').value = CFG.authors.join(', ');
      $('s-minReactions').value = CFG.minReactions;
      $('s-maxAgeHours').value = CFG.maxAgeHours;
      $('s-scoreThresh').value = CFG.scoreThresh;
      $('s-showBorderline').checked = CFG.showBorderline;
      $('s-borderlineDelta').value = CFG.borderlineDelta;
      $('s-scrollMinMs').value = CFG.scrollMinMs;
      $('s-scrollMaxMs').value = CFG.scrollMaxMs;
      $('s-batchSize').value = CFG.batchSize;
      $('s-maxPosts').value = CFG.maxPosts;
    };
    sync();

    $('lks-start').onclick = () => { hideHint(); startScroll(); };
    $('lks-pause').onclick = () => pauseScroll();
    $('lks-stop').onclick = () => { stopScroll(); maybeFlush(true); };

    // ---------- History view ----------
    let historyMode = false;
    let historySearchTimer = null;
    function renderHistoryRow(p) {
      const row = document.createElement('div');
      row.className = 'result';
      row.innerHTML = `
        <div><span class="score"></span><span class="author"></span></div>
        <div class="reason"></div>
        <div class="snippet"></div>
        <a target="_blank">Open on LinkedIn →</a>`;
      row.querySelector('.score').textContent = p.score;
      row.querySelector('.author').textContent = p.author;
      row.querySelector('.reason').textContent = p.reason || '';
      row.querySelector('.snippet').textContent = (p.text || '').slice(0, 240);
      row.querySelector('a').href = p.url;
      return row;
    }
    async function renderHistory() {
      const min = Number.parseInt($('lks-history-range').value, 10) || 0;
      $('lks-history-min').textContent = String(min);
      const q = $('lks-history-search').value.trim().toLowerCase();
      const list = $('lks-history-list');
      list.innerHTML = '';
      const all = await dbAllScored(min);
      const filtered = q
        ? all.filter(p => (p.author + ' ' + (p.text || '')).toLowerCase().includes(q))
        : all;
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = 'No stored posts match these filters.';
        list.append(empty);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const p of filtered.slice(0, 200)) frag.append(renderHistoryRow(p));
      list.append(frag);
    }
    $('lks-history-toggle').onclick = () => {
      historyMode = !historyMode;
      $('lks-body').style.display = historyMode ? 'none' : '';
      $('lks-history').style.display = historyMode ? '' : 'none';
      $('lks-history-toggle').textContent = historyMode ? 'Live' : 'History';
      if (historyMode) renderHistory();
    };
    $('lks-history-range').oninput = () => { if (historyMode) renderHistory(); };
    $('lks-history-search').oninput = () => {
      if (!historyMode) return;
      if (historySearchTimer) clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(renderHistory, 250);
    };
    $('lks-profile').onchange = e => {
      setActiveProfile(e.target.value);
      $('s-criteria').value = CFG.criteria;
      setStatus(`Profile: ${profiles.activeName}`);
    };
    $('s-profile-new').onclick = () => {
      const name = (prompt('New profile name:') || '').trim();
      if (!name) return;
      if (profiles.list.some(p => p.name === name)) { alert('A profile with that name already exists.'); return; }
      profiles.list.push({ name, criteria: '' });
      profiles.activeName = name;
      CFG.criteria = '';
      persistProfiles();
      refreshProfileSelector();
      $('s-criteria').value = '';
      setStatus(`Profile: ${name}`);
    };
    $('s-profile-rename').onclick = () => {
      const cur = activeProfile();
      const name = (prompt('Rename profile to:', cur.name) || '').trim();
      if (!name || name === cur.name) return;
      if (profiles.list.some(p => p.name === name)) { alert('A profile with that name already exists.'); return; }
      cur.name = name;
      profiles.activeName = name;
      persistProfiles();
      refreshProfileSelector();
      setStatus(`Renamed to ${name}`);
    };
    $('s-profile-dup').onclick = () => {
      const cur = activeProfile();
      const name = (prompt('Name for the duplicate:', cur.name + ' copy') || '').trim();
      if (!name) return;
      if (profiles.list.some(p => p.name === name)) { alert('A profile with that name already exists.'); return; }
      profiles.list.push({ name, criteria: cur.criteria });
      profiles.activeName = name;
      persistProfiles();
      refreshProfileSelector();
      setStatus(`Profile: ${name}`);
    };
    $('s-profile-del').onclick = () => {
      if (profiles.list.length <= 1) { alert('Cannot delete the only profile.'); return; }
      const cur = activeProfile();
      if (!confirm(`Delete profile "${cur.name}"?`)) return;
      profiles.list = profiles.list.filter(p => p.name !== cur.name);
      profiles.activeName = profiles.list[0].name;
      CFG.criteria = profiles.list[0].criteria;
      persistProfiles();
      refreshProfileSelector();
      $('s-criteria').value = CFG.criteria;
      setStatus(`Profile: ${profiles.activeName}`);
    };
    $('lks-cog').onclick = () => {
      const s = $('lks-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    };
    $('s-save').onclick = () => {
      // Criteria belongs to the active profile, not the global CFG bucket.
      const text = $('s-criteria').value;
      activeProfile().criteria = text;
      CFG.criteria = text;
      persistProfiles();
      SAVE('keywords', $('s-keywords').value.split(',').map(s => s.trim()).filter(Boolean));
      SAVE('authors', $('s-authors').value.split(',').map(s => s.trim()).filter(Boolean));
      SAVE('minReactions', Number.parseInt($('s-minReactions').value, 10) || 0);
      SAVE('maxAgeHours', Number.parseInt($('s-maxAgeHours').value, 10) || 0);
      SAVE('scoreThresh', Number.parseInt($('s-scoreThresh').value, 10) || 7);
      SAVE('showBorderline', $('s-showBorderline').checked);
      SAVE('borderlineDelta', Number.parseInt($('s-borderlineDelta').value, 10) || 2);
      SAVE('scrollMinMs', Number.parseInt($('s-scrollMinMs').value, 10) || 3000);
      SAVE('scrollMaxMs', Number.parseInt($('s-scrollMaxMs').value, 10) || 6000);
      SAVE('batchSize', Number.parseInt($('s-batchSize').value, 10) || 8);
      SAVE('maxPosts', Number.parseInt($('s-maxPosts').value, 10) || 1500);
      $('lks-settings').style.display = 'none';
      setStatus('Settings saved.');
    };
    $('s-cancel').onclick = () => {
      sync();
      $('lks-settings').style.display = 'none';
      setStatus('Settings unchanged.');
    };
    $('s-rescore').onclick = () => rescoreAll();
    $('s-clear').onclick = async () => {
      if (!confirm('Wipe all stored posts and scores?')) return;
      const db = await dbReady;
      db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      $('lks-body').innerHTML = '';
      seen.clear();
      queue.length = 0;
      pendingForce = false;
      rendered.clear();
      for (const k of Object.keys(counters)) {
        counters[k] = 0;
        const el = $('lks-c-' + k);
        if (el) el.textContent = '0';
      }
      setStatus('DB cleared.');
    };

    function setStatus(s) { $('lks-status').textContent = s; }
    function showHint() { $('lks-hint').style.display = 'block'; }
    function hideHint() { $('lks-hint').style.display = 'none'; }
    function clearResults() {
      $('lks-body').innerHTML = '';
      rendered.clear();
      counters.hits = 0;
      $('lks-c-hits').textContent = '0';
    }
    function refreshControls() {
      $('lks-start').textContent = paused ? 'Resume' : 'Start';
      $('lks-pause').disabled = !scrollTimer;
    }
    refreshControls();
    function bump(name, n) {
      counters[name] = (counters[name] || 0) + n;
      const el = $('lks-c-' + name);
      if (el) el.textContent = counters[name];
      if (name === 'hits' || name === 'scored') hideHint();
    }
    // Cap visible result cards to bound panel DOM growth in long sessions.
    // History view (dbAllScored) still surfaces everything stored. Insert
    // order is score-descending; eviction drops the lowest-score card from
    // the tail. seen.add prevents tryCapture from re-walking the urn within
    // this session, so evicted posts only re-render via the boot history
    // loop on a future page load.
    const MAX_PANEL_RESULTS = 200;
    function addResult(post) {
      if (rendered.has(post.urn)) return;
      rendered.add(post.urn);
      if (!post.borderline) bump('hits', 1);
      const div = document.createElement('div');
      div.dataset.urn = post.urn;
      div.className = post.borderline ? 'result borderline' : 'result';
      div.innerHTML = `
        <div><span class="score"></span><span class="author"></span></div>
        <div class="reason"></div>
        <div class="snippet"></div>
        <a target="_blank">Open on LinkedIn →</a>`;
      div.querySelector('.score').textContent = post.score;
      div.querySelector('.author').textContent = post.author;
      div.querySelector('.reason').textContent = post.reason;
      div.querySelector('.snippet').textContent = post.text.slice(0, 240);
      div.querySelector('a').href = post.url;
      const body = $('lks-body');
      const after = [...body.children].find(
        c => Number.parseInt(c.querySelector('.score').textContent, 10) < post.score
      );
      if (after) after.before(div); else body.append(div);
      while (body.children.length > MAX_PANEL_RESULTS) {
        const last = body.lastElementChild;
        if (last.dataset.urn) rendered.delete(last.dataset.urn);
        last.remove();
      }
    }
    return { setStatus, bump, addResult, showHint, hideHint, refreshControls, clearResults };
  })();

  // ---------- Boot ----------
  (async () => {
    // Drain any queued-but-not-scored posts left over from a previous session
    // BEFORE starting the observer, so the observer can't race on the same
    // URN. seen.add prevents a later DOM re-encounter from re-queueing.
    const queuedFromDisk = await dbAllQueued();
    for (const p of queuedFromDisk) {
      seen.add(p.urn);
      queue.push(p);
      ui.bump('queued', 1);
    }
    startObserver();
    const lowerBound = CFG.showBorderline
      ? Math.max(0, CFG.scoreThresh - CFG.borderlineDelta)
      : CFG.scoreThresh;
    const past = await dbAllScored(lowerBound);
    for (const p of past.slice(0, 50)) {
      // Bump `scored` for each past hit we surface so the panel invariant
      // hits ≤ scored holds at boot before any fresh scoring runs.
      ui.bump('scored', 1);
      ui.addResult(p.score >= CFG.scoreThresh ? p : { ...p, borderline: true });
    }
    const anyStored = await dbAllScored(0);
    if (anyStored.length === 0) ui.showHint();
    // Auto-resume after a DOM-recycle reload. The previous session segment
    // hit maxPosts and bounced the tab; pick up scrolling automatically so
    // the user sees a continuous capture session despite the reload.
    if (localStorage.getItem(NS + 'resumeOnBoot') === '1') {
      localStorage.removeItem(NS + 'resumeOnBoot');
      ui.setStatus('Resuming after DOM recycle…');
      // Wait a beat for the feed to mount and any queued posts to start
      // flowing through the observer; then kick scrolling.
      setTimeout(() => startScroll(), 1500);
    } else {
      ui.setStatus(queuedFromDisk.length > 0
        ? `Ready. ${queuedFromDisk.length} carried over — click Start.`
        : 'Ready. Click Start.');
    }
  })();
})();
