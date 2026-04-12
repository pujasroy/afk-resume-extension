// AFK — Background Service Worker v2.1
// Tracks time only when tab is ACTIVE + window FOCUSED + user not IDLE
// Fixes: siteContext now saved from PAGE_META
// New: idle detection, centralized Groq API calls, scroll TTL cleanup

const RETURN_THRESHOLD_MS   = 30 * 60 * 1000;
const MIN_VISIT_DURATION_MS = 8000;
const MAX_SESSION_LOG       = 400;
const FLUSH_ALARM           = 'afk-flush';
const CLEANUP_ALARM         = 'afk-cleanup';
const SKIP_PROTOCOLS        = ['chrome:', 'about:', 'data:', 'chrome-extension:'];
const IDLE_THRESHOLD_SEC    = 60; // user idle after 60s of no input
const SCROLL_TTL_MS         = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Idle detection setup ──────────────────────────────────────────────────────
chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SEC);

chrome.idle.onStateChanged.addListener((state) => withSessionLock(async () => {
  const now    = Date.now();
  const active = await getActive();

  if (state === 'idle' || state === 'locked') {
    for (const tabId of Object.keys(active)) {
      await pauseSession(Number(tabId), now, active);
    }
  } else if (state === 'active') {
    try {
      const wins = await chrome.windows.getAll({ populate: true });
      for (const w of wins) {
        if (!w.focused) continue;
        const tab = w.tabs?.find(t => t.active);
        if (tab && tab.url && !isSkipped(tab.url)) {
          await startSession(tab.id, tab, now);
        }
      }
    } catch (_) {}
  }
}));

// ─── Alarms ───────────────────────────────────────────────────────────────────
chrome.alarms.create(FLUSH_ALARM,   { periodInMinutes: 0.5 });
chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FLUSH_ALARM)   await snapshotActiveSessions();
  if (alarm.name === CLEANUP_ALARM) await cleanupStaleData();
});

// ─── Tab activated ────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => withSessionLock(async () => {
  const now    = Date.now();
  const active = await getActive();

  for (const id of Object.keys(active)) {
    if (Number(id) !== tabId) await pauseSession(Number(id), now, active);
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(windowId);
    if (win.focused) await startSession(tabId, tab, now, active);
  } catch (_) {}
}));

// ─── Tab URL changes ──────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.active) return;
  if (!tab.url || isSkipped(tab.url)) return;
  withSessionLock(async () => {
    const now    = Date.now();
    const active = await getActive();
    if (active[tabId] && active[tabId].url !== tab.url) {
      await pauseSession(tabId, now, active);
    }
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.focused) await startSession(tabId, tab, now, active);
    } catch (_) {}
  });
});

// ─── Tab closed ───────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => withSessionLock(async () => {
  await pauseSession(tabId, Date.now());
}));

// ─── Window focus changes ─────────────────────────────────────────────────────
chrome.windows.onFocusChanged.addListener((windowId) => withSessionLock(async () => {
  const now    = Date.now();
  const active = await getActive();

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    for (const tabId of Object.keys(active)) {
      await pauseSession(Number(tabId), now, active);
    }
  } else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab && tab.url && !isSkipped(tab.url)) {
        await startSession(tab.id, tab, now, active);
      }
    } catch (_) {}
  }
}));

// ─── Messages ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // PAGE_META — FIX: now correctly saves siteContext too
  if (msg.type === 'PAGE_META' && msg.meta?.url) {
    chrome.storage.local.get(['pageMeta']).then(result => {
      const meta = result.pageMeta || {};
      meta[msg.meta.url] = {
        description: msg.meta.description || '',
        headings:    msg.meta.headings    || [],
        siteContext: msg.meta.siteContext || [], // ← was missing before
      };
      const keys = Object.keys(meta);
      if (keys.length > 300) delete meta[keys[0]];
      chrome.storage.local.set({ pageMeta: meta });
    });
    sendResponse({ ok: true });
    return true;
  }

  // GENERATE_ACTIONS — centralized Groq call (API key never touches content script)
  if (msg.type === 'GENERATE_ACTIONS') {
    handleGenerateActions(msg).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // keep channel open for async response
  }

  // SPA_NAVIGATE — content script reports pushState navigations in SPAs
  if (msg.type === 'SPA_NAVIGATE' && msg.url) {
    withSessionLock(async () => {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      const now    = Date.now();
      const active = await getActive();

      if (active[tabId] && active[tabId].url !== msg.url) {
        await pauseSession(tabId, now, active);
        const fakeTab = { url: msg.url, title: msg.title || active[tabId]?.domain || '', id: tabId, windowId: sender.tab?.windowId };
        await startSession(tabId, fakeTab, now, active);
      }
    });
    sendResponse({ ok: true });
    return true;
  }
});

// ─── Groq action generation (moved from content.js) ───────────────────────────
async function handleGenerateActions({ domain, entries, liveContext }) {
  const { apiKey } = await chrome.storage.local.get(['apiKey']);
  if (!apiKey) return { actions: null }; // signal content script to use heuristic

  const sessionContext = entries.map(e => {
    const parts = [e.title];
    if (e.siteContext?.length) parts.push(...e.siteContext);
    if (e.headings?.length)   parts.push(...e.headings.slice(0, 2));
    return parts.filter(Boolean).join(' | ');
  }).join('\n');

  const liveCtxStr = liveContext?.length
    ? '\nCurrently visible on page:\n' + liveContext.join('\n')
    : '';

  const prompt = `You are AFK, a focus-recovery tool. The user just returned to ${domain} after being away.

What was on the page during their last visit:
${sessionContext}
${liveCtxStr}

Write exactly 2 hyper-specific resume actions.
Rules:
- Use ACTUAL names, titles, people from the context — not generic descriptions
- If there are specific people (e.g. "Unread from: Puja Roy"), reference them by name
- If there's a specific assignment, document, video, or chat — name it exactly
- Start with: Reply to, Open, Finish, Continue, Resume, Check, Review, Watch
- Each action under 65 characters
- Use "you" not "the user"

Respond ONLY with a JSON array of 2 strings, no markdown:
["action 1", "action 2"]`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 150,
      temperature: 0.25,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || '[]';

  // Safe parse with fallback
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    return { actions: Array.isArray(parsed) ? parsed.slice(0, 2) : [String(parsed)] };
  } catch (_) {
    return { actions: ['Continue where you left off'] };
  }
}

// ─── Session lock (prevents race conditions between concurrent async listeners) ─
let _sessionLock = Promise.resolve();
function withSessionLock(fn) {
  _sessionLock = _sessionLock.then(fn).catch(() => {});
  return _sessionLock;
}

// ─── Core session logic ───────────────────────────────────────────────────────

function isSkipped(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (SKIP_PROTOCOLS.includes(protocol)) return true;
    if (['newtab', 'extensions', 'settings'].some(k => hostname.includes(k))) return true;
    return false;
  } catch (_) { return true; }
}

async function getActive() {
  const r = await chrome.storage.local.get(['activeSessions']);
  return r.activeSessions || {};
}

async function saveActive(active) {
  await chrome.storage.local.set({ activeSessions: active });
}

async function startSession(tabId, tab, now, active) {
  if (!tab.url || isSkipped(tab.url)) return;
  active = active || await getActive();

  let domain;
  try { domain = new URL(tab.url).hostname.replace(/^www\./, ''); }
  catch (_) { return; }

  if (active[tabId] && active[tabId].url === tab.url) return;

  active[tabId] = { url: tab.url, title: tab.title || domain, domain, startTime: now };
  await saveActive(active);
  await checkReturn(domain, now);
}

async function pauseSession(tabId, endTime, active) {
  active = active || await getActive();
  const session = active[tabId];
  if (!session) return;

  const duration = endTime - session.startTime;

  if (duration >= MIN_VISIT_DURATION_MS) {
    const { pageMeta = {} } = await chrome.storage.local.get(['pageMeta']);
    const meta = pageMeta[session.url] || {};

    const { sessionLog = [] } = await chrome.storage.local.get(['sessionLog']);
    const entry = {
      domain:      session.domain,
      title:       session.title,
      url:         session.url,
      description: meta.description  || '',
      headings:    meta.headings     || [],
      siteContext: meta.siteContext  || [], // now populated correctly
      startTime:   session.startTime,
      endTime,
      duration,
    };

    const idx = sessionLog.findIndex(e => e.url === session.url && e.startTime === session.startTime);
    if (idx >= 0) sessionLog[idx] = entry;
    else sessionLog.push(entry);

    await chrome.storage.local.set({
      sessionLog: sessionLog.slice(-MAX_SESSION_LOG),
      lastUpdated: endTime,
    });
  }

  delete active[tabId];
  await saveActive(active);
}

async function snapshotActiveSessions() {
  const now    = Date.now();
  const active = await getActive();
  if (!Object.keys(active).length) return;

  const { sessionLog = [], pageMeta = {} } = await chrome.storage.local.get(['sessionLog', 'pageMeta']);
  let updated = [...sessionLog];

  for (const [tabId, session] of Object.entries(active)) {
    const duration = now - session.startTime;
    if (duration < MIN_VISIT_DURATION_MS) continue;

    const meta = pageMeta[session.url] || {};
    const snapshot = {
      domain:      session.domain,
      title:       session.title,
      url:         session.url,
      description: meta.description  || '',
      headings:    meta.headings     || [],
      siteContext: meta.siteContext  || [],
      startTime:   session.startTime,
      endTime:     now,
      duration,
    };

    const idx = updated.findIndex(e => e.url === session.url && e.startTime === session.startTime);
    if (idx >= 0) updated[idx] = snapshot;
    else updated.push(snapshot);
  }

  await chrome.storage.local.set({ sessionLog: updated.slice(-MAX_SESSION_LOG), lastUpdated: now });
}

async function checkReturn(domain, now) {
  const { lastSeenDomains = {}, returnThresholdMs = RETURN_THRESHOLD_MS } =
    await chrome.storage.local.get(['lastSeenDomains', 'returnThresholdMs']);

  const last = lastSeenDomains[domain];
  if (last && (now - last) > returnThresholdMs) {
    await chrome.storage.local.set({
      returnDetected: { domain, timestamp: now, awayMs: now - last, flagged: true },
    });
  }

  lastSeenDomains[domain] = now;
  await chrome.storage.local.set({ lastSeenDomains });
}

// ─── Cleanup stale data (runs hourly) ─────────────────────────────────────────
async function cleanupStaleData() {
  const now = Date.now();

  // Remove scroll positions older than 7 days
  const { scrollPositions = {} } = await chrome.storage.local.get(['scrollPositions']);
  let cleaned = false;
  for (const [url, data] of Object.entries(scrollPositions)) {
    if (now - (data.ts || 0) > SCROLL_TTL_MS) {
      delete scrollPositions[url];
      cleaned = true;
    }
  }
  if (cleaned) await chrome.storage.local.set({ scrollPositions });

  // Remove pageMeta for URLs with no session entry in last 7 days
  const { pageMeta = {}, sessionLog = [] } = await chrome.storage.local.get(['pageMeta', 'sessionLog']);
  const recentUrls = new Set(sessionLog.filter(e => now - e.endTime < SCROLL_TTL_MS).map(e => e.url));
  let metaCleaned = false;
  for (const url of Object.keys(pageMeta)) {
    if (!recentUrls.has(url)) { delete pageMeta[url]; metaCleaned = true; }
  }
  if (metaCleaned) await chrome.storage.local.set({ pageMeta });
}
