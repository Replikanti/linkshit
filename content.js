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
    scrollMinMs: 3000,
    scrollMaxMs: 6000,
    batchSize: 8,
    maxPosts: 1500,
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
    } else {
      CFG[k] = raw;
    }
  }
  const SAVE = (k, v) => {
    CFG[k] = v;
    localStorage.setItem(NS + k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // ---------- Extractor ----------
  // LinkedIn rewrites these CSS class names occasionally. If captured count
  // stays at 0, open DevTools and find the new selectors.
  const firstLine = s => (s || '').trim().split('\n')[0].trim();
  // Sponsored posts are marked by a small "Promoted" / "Sponsored" label
  // inside the post header (actor block). Restrict the scan to that block
  // so an organic post that happens to use the word in its body is not
  // misclassified.
  function isPromoted(el) {
    const actor = el.querySelector('.update-components-actor') || el;
    for (const node of actor.querySelectorAll('span, div')) {
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
    const actor = el.querySelector('.update-components-actor') || el;
    const subdesc = actor.querySelector('.update-components-actor__sub-description');
    if (subdesc) {
      const h = parseAgeHours(subdesc.innerText);
      if (h != null) return h;
    }
    for (const node of actor.querySelectorAll('span')) {
      const t = (node.textContent || '').trim();
      if (!t || t.length > 30) continue;
      const h = parseAgeHours(t);
      if (h != null) return h;
    }
    return null;
  }
  function extractPost(el) {
    const urn = el.dataset.urn || el.dataset.id || '';
    if (!urn.startsWith('urn:li:activity:')) return null;
    const authorEl =
      el.querySelector('.update-components-actor__title') ||
      el.querySelector('.update-components-actor__name') ||
      el.querySelector('a.app-aware-link span[aria-hidden="true"]');
    const subtitleEl = el.querySelector('.update-components-actor__description');
    const textEl =
      el.querySelector('.update-components-text') ||
      el.querySelector('.feed-shared-update-v2__description') ||
      el.querySelector('.feed-shared-inline-show-more-text');
    const reactEl = el.querySelector('.social-details-social-counts__reactions-count');
    return {
      urn,
      author: firstLine(authorEl?.innerText),
      subtitle: firstLine(subtitleEl?.innerText),
      text: (textEl?.innerText || '').trim(),
      reactions: reactEl ? Number.parseInt(reactEl.innerText.replaceAll(/\D/g, '') || '0', 10) : 0,
      url: `https://www.linkedin.com/feed/update/${urn}/`,
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

  // ---------- Score via background service worker → native messaging host ----------
  async function scoreBatch(posts) {
    const response = await chrome.runtime.sendMessage({
      type: 'score',
      criteria: CFG.criteria,
      posts,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'no response from native host');
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
  async function maybeFlush(force = false) {
    if (force) pendingForce = true;
    if (scoring || queue.length === 0) return;
    if (queue.length < CFG.batchSize && !pendingForce) return;
    scoring = true;
    const batch = queue.splice(0, CFG.batchSize);
    ui.setStatus(`Scoring ${batch.length} (${queue.length} queued)…`);
    try {
      const scored = await scoreBatch(batch);
      for (const s of scored) {
        await dbPut(s);
        if (s.score >= CFG.scoreThresh) ui.addResult(s);
      }
      ui.bump('scored', scored.length);
      ui.setStatus(scrollTimer ? 'Scrolling…' : 'Idle.');
    } catch (e) {
      console.error('[Linkshit]', e);
      ui.setStatus('Error: ' + e.message);
      for (const p of batch) queue.unshift(p);
      await sleep(15000);
    } finally {
      scoring = false;
      if (queue.length === 0) pendingForce = false;
      if (queue.length >= CFG.batchSize || (pendingForce && queue.length > 0)) {
        maybeFlush();
      }
    }
  }

  // ---------- Capture (MutationObserver) ----------
  const seen = new Set();
  async function tryCapture(el) {
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
      if (ex.score >= CFG.scoreThresh) ui.addResult(ex);
      return;
    }
    await dbPut(post);
    ui.bump('captured', 1);
    if (preFilter(post)) {
      queue.push(post);
      ui.bump('queued', 1);
      maybeFlush();
    }
  }
  function startObserver() {
    const sel = '[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]';
    const root = document.querySelector('main') || document.body;
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.(sel)) tryCapture(n);
        n.querySelectorAll?.(sel).forEach(tryCapture);
      }
    }).observe(root, { childList: true, subtree: true });
    document.querySelectorAll(sel).forEach(tryCapture);
  }

  // ---------- Scroller (human-like pacing) ----------
  let scrollTimer = null, lastH = 0, stable = 0, postsAtStart = 0, paused = false;
  function startScroll() {
    if (scrollTimer) return;
    // Resuming from a pause keeps the original maxPosts baseline so the
    // session as a whole still respects the cap; a fresh start resets it.
    if (!paused) postsAtStart = seen.size;
    paused = false;
    const tick = () => {
      if (!scrollTimer) return;
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelectorAll('button').forEach(b => {
        const t = (b.innerText || '').toLowerCase();
        if (t.includes('load more comment') || t.includes('show more replies')
         || t.includes('zobrazit další') || t.includes('načíst předchozí')) b.click();
      });
      if (document.body.scrollHeight === lastH) {
        if (++stable > 6) { stopScroll(); ui.setStatus('End of feed.'); maybeFlush(true); return; }
      } else {
        stable = 0; lastH = document.body.scrollHeight;
      }
      if (seen.size - postsAtStart >= CFG.maxPosts) {
        stopScroll(); ui.setStatus(`maxPosts=${CFG.maxPosts} reached.`); maybeFlush(true); return;
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
      display:flex;justify-content:space-between;align-items:center}
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
    #lks-panel .result{padding:8px 0;border-bottom:1px solid var(--row-border)}
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
      <header>
        <span>Linkshit</span>
        <span>
          <button id="lks-start" class="primary">Start</button>
          <button id="lks-pause">Pause</button>
          <button id="lks-stop">Stop</button>
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
      <div class="body" id="lks-settings" style="display:none;border-top:1px solid #eee;">
        <label>Criteria</label><textarea id="s-criteria" rows="5"></textarea>
        <label>Pre-filter keywords (comma-separated)</label><input id="s-keywords"/>
        <label>Author allowlist (comma-separated substrings)</label><input id="s-authors"/>
        <label>Min reactions</label><input id="s-minReactions" type="number"/>
        <label>Max age (hours, 0 = unlimited)</label><input id="s-maxAgeHours" type="number"/>
        <label>Score threshold to surface</label><input id="s-scoreThresh" type="number"/>
        <label>Scroll delay min / max ms</label>
        <input id="s-scrollMinMs" type="number"/><input id="s-scrollMaxMs" type="number"/>
        <label>Batch size</label><input id="s-batchSize" type="number"/>
        <label>Max posts per session</label><input id="s-maxPosts" type="number"/>
        <button id="s-save" class="primary">Save</button>
        <button id="s-cancel">Cancel</button>
        <button id="s-clear">Clear DB</button>
      </div>`;
    document.body.append(panel);
    const $ = id => panel.querySelector('#' + id);
    const counters = { captured: 0, promoted: 0, tooOld: 0, queued: 0, scored: 0, hits: 0 };
    // Track URNs already rendered in the panel so the boot replay + later
    // scroll-into-view of the same post don't produce duplicate rows.
    const rendered = new Set();

    const sync = () => {
      $('s-criteria').value = CFG.criteria;
      $('s-keywords').value = CFG.keywords.join(', ');
      $('s-authors').value = CFG.authors.join(', ');
      $('s-minReactions').value = CFG.minReactions;
      $('s-maxAgeHours').value = CFG.maxAgeHours;
      $('s-scoreThresh').value = CFG.scoreThresh;
      $('s-scrollMinMs').value = CFG.scrollMinMs;
      $('s-scrollMaxMs').value = CFG.scrollMaxMs;
      $('s-batchSize').value = CFG.batchSize;
      $('s-maxPosts').value = CFG.maxPosts;
    };
    sync();

    $('lks-start').onclick = () => { hideHint(); startScroll(); };
    $('lks-pause').onclick = () => pauseScroll();
    $('lks-stop').onclick = () => { stopScroll(); maybeFlush(true); };
    $('lks-cog').onclick = () => {
      const s = $('lks-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    };
    $('s-save').onclick = () => {
      SAVE('criteria', $('s-criteria').value);
      SAVE('keywords', $('s-keywords').value.split(',').map(s => s.trim()).filter(Boolean));
      SAVE('authors', $('s-authors').value.split(',').map(s => s.trim()).filter(Boolean));
      SAVE('minReactions', Number.parseInt($('s-minReactions').value, 10) || 0);
      SAVE('maxAgeHours', Number.parseInt($('s-maxAgeHours').value, 10) || 0);
      SAVE('scoreThresh', Number.parseInt($('s-scoreThresh').value, 10) || 7);
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
    function addResult(post) {
      if (rendered.has(post.urn)) return;
      rendered.add(post.urn);
      bump('hits', 1);
      const div = document.createElement('div');
      div.className = 'result';
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
    }
    return { setStatus, bump, addResult, showHint, hideHint, refreshControls };
  })();

  // ---------- Boot ----------
  (async () => {
    startObserver();
    const past = await dbAllScored(CFG.scoreThresh);
    for (const p of past.slice(0, 50)) ui.addResult(p);
    const anyStored = await dbAllScored(0);
    if (anyStored.length === 0) ui.showHint();
    ui.setStatus('Ready. Click Start.');
  })();
})();
