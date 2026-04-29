// Linkshit content script.
//
// Runs on https://www.linkedin.com/feed/* and does:
//   - DOM observation: capture posts as they render (LinkedIn virtualizes
//     the feed, so old posts get unmounted — we must snapshot during scroll)
//   - Auto-scroll with human-like jitter
//   - Pre-filter: keyword/author allowlist + min reactions
//   - Send pre-filtered batches to http://127.0.0.1:7777/score (the local
//     bridge) for LLM scoring
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
    scoreThresh: 7,
    scrollMinMs: 3000,
    scrollMaxMs: 6000,
    batchSize: 8,
    maxPosts: 1500,
    serverUrl: 'http://127.0.0.1:7777/score',
    serverToken: '',
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
  const dbPut = post => dbReady.then(db => new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(post);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  }));
  const dbGet = urn => dbReady.then(db => new Promise((res, rej) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(urn);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const dbAllScored = min => dbReady.then(db => new Promise(res => {
    const out = [];
    db.transaction(STORE, 'readonly').objectStore(STORE).index('score')
      .openCursor(IDBKeyRange.lowerBound(min), 'prev').onsuccess = e => {
        const c = e.target.result;
        if (c) { out.push(c.value); c.continue(); } else res(out);
      };
  }));

  // ---------- Extractor ----------
  // LinkedIn rewrites these CSS class names occasionally. If captured count
  // stays at 0, open DevTools and find the new selectors.
  const firstLine = s => (s || '').trim().split('\n')[0].trim();
  function extractPost(el) {
    const urn = el.getAttribute('data-urn') || el.getAttribute('data-id') || '';
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
      reactions: reactEl ? parseInt(reactEl.innerText.replace(/\D/g, '') || '0', 10) : 0,
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

  // ---------- Score via local bridge ----------
  async function scoreBatch(posts) {
    const headers = { 'content-type': 'application/json' };
    if (CFG.serverToken) headers['x-linkshit-token'] = CFG.serverToken;
    const r = await fetch(CFG.serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ criteria: CFG.criteria, posts }),
    });
    if (!r.ok) throw new Error('server ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const arr = await r.json();
    return posts.map((p, i) => {
      const f = arr.find(x => x.id === i + 1) || arr[i] || { score: 0, reason: 'no-score' };
      return { ...p, score: f.score | 0, reason: f.reason || '', status: 'scored' };
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
    const ex = await dbGet(post.urn);
    if (ex && ex.status === 'scored') {
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
  let scrollTimer = null, lastH = 0, stable = 0, postsAtStart = 0;
  function startScroll() {
    if (scrollTimer) return;
    postsAtStart = seen.size;
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
  }
  function stopScroll() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = null;
    ui.setStatus('Stopped.');
  }

  // ---------- UI ----------
  const STYLE = `
    #lks-panel{position:fixed;right:12px;top:80px;width:380px;max-height:82vh;background:#fff;
      border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.1);z-index:999999;
      font:13px system-ui;display:flex;flex-direction:column;color:#111}
    #lks-panel header{padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;
      display:flex;justify-content:space-between;align-items:center}
    #lks-panel .body{padding:8px 12px;overflow-y:auto;flex:1}
    #lks-panel button{padding:4px 10px;margin-left:4px;border:1px solid #aaa;background:#f5f5f5;
      border-radius:4px;cursor:pointer;font:inherit}
    #lks-panel button.primary{background:#0a66c2;color:#fff;border-color:#0a66c2}
    #lks-panel .status{padding:6px 12px;font-size:12px;color:#555;background:#fafafa;
      border-top:1px solid #eee;border-bottom:1px solid #eee}
    #lks-panel .counters{padding:6px 12px;font-size:11px;color:#666;display:flex;gap:12px;
      border-bottom:1px solid #eee}
    #lks-panel .result{padding:8px 0;border-bottom:1px solid #f0f0f0}
    #lks-panel .result .author{font-weight:600}
    #lks-panel .result .score{float:right;background:#0a66c2;color:#fff;padding:1px 6px;
      border-radius:3px;font-size:11px}
    #lks-panel .result .reason{font-style:italic;color:#555;margin:2px 0}
    #lks-panel .result .snippet{color:#333;font-size:12px;max-height:64px;overflow:hidden}
    #lks-panel .result a{color:#0a66c2;text-decoration:none;font-size:11px}
    #lks-settings textarea,#lks-settings input{width:100%;box-sizing:border-box;
      margin:2px 0 6px;font-family:inherit;font-size:12px}
    #lks-settings label{font-size:11px;color:#555;display:block;margin-top:4px}
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const ui = (() => {
    const panel = document.createElement('div');
    panel.id = 'lks-panel';
    panel.innerHTML = `
      <header>
        <span>Linkshit</span>
        <span>
          <button id="lks-start" class="primary">Start</button>
          <button id="lks-stop">Stop</button>
          <button id="lks-cog">⚙</button>
        </span>
      </header>
      <div class="counters">
        <span>captured <b id="lks-c-captured">0</b></span>
        <span>queued <b id="lks-c-queued">0</b></span>
        <span>scored <b id="lks-c-scored">0</b></span>
        <span>hits <b id="lks-c-hits">0</b></span>
      </div>
      <div class="status" id="lks-status">Idle.</div>
      <div class="body" id="lks-body"></div>
      <div class="body" id="lks-settings" style="display:none;border-top:1px solid #eee;">
        <label>Local server URL</label><input id="s-serverUrl"/>
        <label>Server token (printed by score-server.js on start)</label><input id="s-serverToken" type="password"/>
        <label>Criteria</label><textarea id="s-criteria" rows="5"></textarea>
        <label>Pre-filter keywords (comma-separated)</label><input id="s-keywords"/>
        <label>Author allowlist (comma-separated substrings)</label><input id="s-authors"/>
        <label>Min reactions</label><input id="s-minReactions" type="number"/>
        <label>Score threshold to surface</label><input id="s-scoreThresh" type="number"/>
        <label>Scroll delay min / max ms</label>
        <input id="s-scrollMinMs" type="number"/><input id="s-scrollMaxMs" type="number"/>
        <label>Batch size</label><input id="s-batchSize" type="number"/>
        <label>Max posts per session</label><input id="s-maxPosts" type="number"/>
        <button id="s-save" class="primary">Save</button>
        <button id="s-clear">Clear DB</button>
      </div>`;
    document.body.appendChild(panel);
    const $ = id => panel.querySelector('#' + id);
    const counters = { captured: 0, queued: 0, scored: 0, hits: 0 };
    // Track URNs already rendered in the panel so the boot replay + later
    // scroll-into-view of the same post don't produce duplicate rows.
    const rendered = new Set();

    const sync = () => {
      $('s-serverUrl').value = CFG.serverUrl;
      $('s-serverToken').value = CFG.serverToken;
      $('s-criteria').value = CFG.criteria;
      $('s-keywords').value = CFG.keywords.join(', ');
      $('s-authors').value = CFG.authors.join(', ');
      $('s-minReactions').value = CFG.minReactions;
      $('s-scoreThresh').value = CFG.scoreThresh;
      $('s-scrollMinMs').value = CFG.scrollMinMs;
      $('s-scrollMaxMs').value = CFG.scrollMaxMs;
      $('s-batchSize').value = CFG.batchSize;
      $('s-maxPosts').value = CFG.maxPosts;
    };
    sync();

    $('lks-start').onclick = () => startScroll();
    $('lks-stop').onclick = () => { stopScroll(); maybeFlush(true); };
    $('lks-cog').onclick = () => {
      const s = $('lks-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    };
    $('s-save').onclick = () => {
      SAVE('serverUrl', $('s-serverUrl').value.trim() || DEFAULTS.serverUrl);
      SAVE('serverToken', $('s-serverToken').value.trim());
      SAVE('criteria', $('s-criteria').value);
      SAVE('keywords', $('s-keywords').value.split(',').map(s => s.trim()).filter(Boolean));
      SAVE('authors', $('s-authors').value.split(',').map(s => s.trim()).filter(Boolean));
      SAVE('minReactions', parseInt($('s-minReactions').value) || 0);
      SAVE('scoreThresh', parseInt($('s-scoreThresh').value) || 7);
      SAVE('scrollMinMs', parseInt($('s-scrollMinMs').value) || 3000);
      SAVE('scrollMaxMs', parseInt($('s-scrollMaxMs').value) || 6000);
      SAVE('batchSize', parseInt($('s-batchSize').value) || 8);
      SAVE('maxPosts', parseInt($('s-maxPosts').value) || 1500);
      $('lks-settings').style.display = 'none';
      setStatus('Settings saved.');
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
    function bump(name, n) {
      counters[name] = (counters[name] || 0) + n;
      const el = $('lks-c-' + name);
      if (el) el.textContent = counters[name];
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
      const after = Array.from(body.children).find(
        c => parseInt(c.querySelector('.score').textContent) < post.score
      );
      if (after) body.insertBefore(div, after); else body.appendChild(div);
    }
    return { setStatus, bump, addResult };
  })();

  // ---------- Boot ----------
  (async () => {
    startObserver();
    const past = await dbAllScored(CFG.scoreThresh);
    for (const p of past.slice(0, 50)) ui.addResult(p);
    ui.setStatus('Ready. Click Start.');
  })();
})();
