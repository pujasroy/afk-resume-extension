'use strict';

const GROQ_MODEL        = 'llama-3.3-70b-versatile';
const CACHE_MS          = 10 * 60 * 1000;
const MIN_DURATION_SHOW = 10000;

// Domains categorized for focus score
const PRODUCTIVE_DOMAINS  = ['github', 'gitlab', 'docs.google', 'notion', 'classroom', 'stackoverflow', 'figma', 'linear', 'jira', 'confluence', 'vercel', 'netlify', 'railway', 'supabase', 'claude', 'openai', 'code', 'codesandbox', 'replit', 'leetcode', 'medium', 'substack'];
const DISTRACTION_DOMAINS = ['twitter', 'x.com', 'instagram', 'facebook', 'tiktok', 'reddit', 'snapchat', 'pinterest', 'tumblr', 'buzzfeed'];

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  setupListeners();
  setupTabs();
  await loadSettingsIntoForm();
  await run(false);
});

// ─── Main flow ─────────────────────────────────────────────────────────────────

async function run(forceRefresh) {
  const s = await getSettings();
  const { sessionLog = [], lastAnalysis } = await chrome.storage.local.get(['sessionLog', 'lastAnalysis']);
  const cutoff   = Date.now() - (s.windowMinutes * 60 * 1000);
  const relevant = sessionLog.filter(e =>
    e.endTime >= cutoff &&
    e.duration >= MIN_DURATION_SHOW &&
    e.domain !== '📄 local file'
  );

  // Today entries for timeline + stats (always midnight cutoff)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEntries = sessionLog.filter(e =>
    e.startTime >= todayStart.getTime() && e.duration >= MIN_DURATION_SHOW
  );

  renderTimeline(todayEntries);
  renderStats(todayEntries);

  if (!relevant.length) { showState('no-data'); return; }

  if (!forceRefresh && lastAnalysis && (Date.now() - lastAnalysis.timestamp) < CACHE_MS) {
    // Filter cached sites to only those still present in the current window,
    // so stale domains don't persist after the session window rolls forward.
    const activeDomains = new Set(relevant.map(e => e.domain));
    const filteredAnalysis = {
      ...lastAnalysis,
      sites: (lastAnalysis.sites || []).filter(s => activeDomains.has(s.domain)),
    };
    if (filteredAnalysis.sites.length) { render(filteredAnalysis, relevant); return; }
  }

  showState('loading');
  try {
    const analysis = await buildAnalysis(s.apiKey, relevant);
    analysis.timestamp = Date.now();
    await chrome.storage.local.set({ lastAnalysis: analysis });
    render(analysis, relevant);
  } catch (err) {
    if (lastAnalysis) { render(lastAnalysis, relevant); toast('Using cached data', 'err'); }
    else { showState('no-data'); toast('Error: ' + err.message, 'err'); }
  }
}

// ─── Build per-site analysis ───────────────────────────────────────────────────

async function buildAnalysis(apiKey, entries) {
  const domainMap = {};
  for (const e of entries) {
    if (!domainMap[e.domain]) {
      domainMap[e.domain] = {
        totalMs: 0, titles: new Set(), headings: new Set(), siteContext: new Set(),
        lastUrl: '', lastTime: 0,
      };
    }
    domainMap[e.domain].totalMs += e.duration;
    if (e.title) domainMap[e.domain].titles.add(e.title);
    (e.headings   || []).forEach(h => domainMap[e.domain].headings.add(h));
    (e.siteContext || []).forEach(s => domainMap[e.domain].siteContext.add(s));
    if (e.endTime > domainMap[e.domain].lastTime) {
      domainMap[e.domain].lastTime = e.endTime;
      domainMap[e.domain].lastUrl  = e.url;
    }
  }

  const sorted = Object.entries(domainMap)
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, 10);

  if (apiKey) {
    setLoadingLabel('Asking Groq for actions…');
    try { return await groqAnalysis(apiKey, sorted, domainMap); }
    catch (_) {}
  }

  return {
    sites: sorted.map(([domain, data]) => ({
      domain,
      duration: fmtMs(data.totalMs),
      lastUrl:  data.lastUrl || `https://${domain}`,
      actions:  heuristicActions([...data.titles][0] || domain, [...data.headings], [...data.siteContext]),
    })),
  };
}

async function groqAnalysis(apiKey, sorted, domainMap) {
  const domainData = sorted.map(([domain, data]) => {
    const titles = [...data.titles].slice(0, 3).join(' | ');
    const heads  = [...data.headings].slice(0, 3).join(' / ');
    const ctx    = [...data.siteContext].slice(0, 4).join(' | ');
    return `Domain: ${domain} (${fmtMs(data.totalMs)})\nPages: ${titles}${heads ? '\nHeadings: ' + heads : ''}${ctx ? '\nContext: ' + ctx : ''}`;
  }).join('\n---\n');

  const prompt = `You are AFK, a focus-recovery tool. Help this user instantly resume their work.

Session data:
${domainData}

For each domain, write 1-2 specific "resume actions" — things the user should do RIGHT NOW.
- Use "you" not "the user"
- Start with: Continue, Finish, Resume, Reply, Open, Complete, Watch
- Use ACTUAL names from Context — be hyper-specific
- Under 65 chars each

Respond ONLY with valid JSON, no markdown:
{"sites":[{"domain":"exact-domain.com","actions":["action 1","action 2"]}]}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL, max_tokens: 800, temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);

  const data   = await res.json();
  const raw    = data.choices?.[0]?.message?.content || '{}';
  const parsed = safeParseJSON(raw, {});

  return {
    sites: (parsed.sites || []).map(s => ({
      domain:   s.domain,
      duration: fmtMs(domainMap[s.domain]?.totalMs || 0),
      lastUrl:  domainMap[s.domain]?.lastUrl || `https://${s.domain}`,
      actions:  s.actions?.slice(0, 2) || ['Continue where you left off'],
    })),
  };
}

function heuristicActions(title = '', headings = [], siteContext = []) {
  const actions = [];
  if (siteContext.length) {
    const unread = siteContext.find(s => s.startsWith('Unread from:') || s.startsWith('Unread:'));
    const open   = siteContext.find(s => s.startsWith('Open chat:') || s.startsWith('Open conversation:') || s.startsWith('Open email:'));
    const assign = siteContext.find(s => s.startsWith('Assignment:') || s.startsWith('Due:'));
    const doc    = siteContext.find(s => s.startsWith('Document:') || s.startsWith('Working on:'));
    if (unread)  actions.push('Reply to ' + unread.replace(/^.*?: /, ''));
    if (open)    actions.push('Continue ' + open.replace(/^.*?: /, ''));
    if (assign)  actions.push('Finish ' + assign.replace(/^.*?: /, ''));
    if (doc)     actions.push('Resume editing ' + doc.replace(/^.*?: /, ''));
  }
  if (actions.length < 2) {
    const t = title.toLowerCase();
    if (t.includes('assignment') || t.includes('classroom')) actions.push(`Finish: "${trunc(title, 38)}"`);
    else if (t.includes('read') || t.includes('article'))    actions.push(`Continue reading: "${trunc(title, 40)}"`);
    else if (t.includes('doc') || t.includes('sheet'))       actions.push('Resume editing your document');
    else if (t.includes('github') || t.includes('code'))     actions.push('Get back to your code');
    else if (t.includes('mail') || t.includes('inbox'))      actions.push('Get back to your emails');
    else if (headings.length)                                 actions.push(`Continue at: "${trunc(headings[0], 45)}"`);
    else                                                      actions.push(`Continue: "${trunc(title, 48)}"`);
  }
  return actions.slice(0, 2);
}

// ─── Render sessions ────────────────────────────────────────────────────────────

function render(analysis, entries) {
  const list = $('site-list');
  list.innerHTML = '';

  (analysis.sites || []).forEach((site, i) => {
    const card = document.createElement('div');
    card.className = 'site-card';
    card.style.animationDelay = `${i * 55}ms`;

    const actionsHTML = (site.actions || [])
      .map(a => `<div class="site-action-item">${a}</div>`).join('');

    card.innerHTML = `
      <div class="card-top">
        <div class="card-left">
          <img class="site-favicon" src="https://www.google.com/s2/favicons?domain=${site.domain}&sz=14" width="14" height="14" onerror="this.style.display='none'" />
          <span class="site-domain">${site.domain}</span>
        </div>
        <span class="site-duration">${site.duration}</span>
      </div>
      <div class="site-actions">${actionsHTML}</div>
      <button class="open-btn">
        <span class="open-btn-icon">↗</span>
        <span class="open-btn-label">${ctaText(site.domain)}</span>
      </button>
    `;
    card.querySelector('.open-btn').addEventListener('click', () => openSite(site));
    list.appendChild(card);
  });

  $('analyzed-label').textContent = analysis.timestamp
    ? (() => { const m = Math.round((Date.now() - analysis.timestamp) / 60000); return m < 1 ? 'Just analyzed' : `${m}m ago`; })()
    : 'Analyzed';
  $('visits-label').textContent = `${entries.length} visits`;

  showState('content');
}

// ─── Render timeline ───────────────────────────────────────────────────────────

function renderTimeline(entries) {
  const list    = $('timeline-list');
  const emptyEl = $('timeline-empty');
  if (!list) return;
  list.innerHTML = '';

  if (!entries.length) {
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // Items within each group: oldest-first so "switched from X" labels read forward in time.
  // Groups themselves: newest-first so today appears at the top.
  const sorted = [...entries].sort((a, b) => a.startTime - b.startTime);
  const groups = {};
  const groupOrder = [];
  for (const e of sorted) {
    const key = fmtDate(e.startTime);
    if (!groups[key]) { groups[key] = []; groupOrder.push(key); }
    groups[key].push(e);
  }
  // Reverse so newest date group renders first
  groupOrder.reverse();

  for (const dateKey of groupOrder) {
    const items = groups[dateKey];
    const groupEl = document.createElement('div');
    groupEl.className = 'tl-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'tl-date-label';
    labelEl.textContent = dateKey;
    groupEl.appendChild(labelEl);

    items.forEach((item, idx) => {
      if (idx > 0 && items[idx - 1].domain !== item.domain) {
        const switchEl = document.createElement('div');
        switchEl.className = 'tl-switch';
        switchEl.textContent = `switched from ${items[idx - 1].domain}`;
        groupEl.appendChild(switchEl);
      }

      const row = document.createElement('div');
      row.className = 'tl-item';
      row.innerHTML = `
        <div class="tl-time">${fmtTime(item.startTime)}</div>
        <div class="tl-dot"></div>
        <div class="tl-body">
          <div class="tl-domain">
            <img class="tl-favicon" src="https://www.google.com/s2/favicons?domain=${item.domain}&sz=12" width="12" height="12" onerror="this.style.display='none'" />
            ${item.domain}
            <span class="tl-dur">${fmtMs(item.duration)}</span>
          </div>
          <div class="tl-title">${item.title || item.url}</div>
        </div>
      `;
      row.querySelector('.tl-body').addEventListener('click', () =>
        openSite({ domain: item.domain, lastUrl: item.url, actions: [] })
      );
      groupEl.appendChild(row);
    });

    list.appendChild(groupEl);
  }
}

// ─── Render stats / today ──────────────────────────────────────────────────────

function classifyDomain(domain) {
  if (DISTRACTION_DOMAINS.some(d => domain.includes(d))) return 'distraction';
  if (PRODUCTIVE_DOMAINS.some(d => domain.includes(d)))  return 'productive';
  return 'neutral';
}

function renderStats(todayEntries) {
  const emptyEl = $('stats-empty');
  const domList = $('stats-domain-list');
  if (!domList) return;
  domList.innerHTML = '';

  if (!todayEntries.length) {
    if (emptyEl) emptyEl.style.display = 'flex';
    $('stat-total-time').textContent  = '—';
    $('stat-switches').textContent    = '—';
    $('stat-focus-score').textContent = '—';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // Aggregate by domain
  const domainMap = {};
  for (const e of todayEntries) {
    if (!domainMap[e.domain]) domainMap[e.domain] = 0;
    domainMap[e.domain] += e.duration;
  }

  const totalMs  = Object.values(domainMap).reduce((a, b) => a + b, 0);
  const sorted   = Object.entries(domainMap).sort((a, b) => b[1] - a[1]);
  const maxMs    = sorted[0]?.[1] || 1;

  // Context switches: consecutive entries with different domains
  const chronological = [...todayEntries].sort((a, b) => a.startTime - b.startTime);
  let switches = 0;
  for (let i = 1; i < chronological.length; i++) {
    if (chronological[i].domain !== chronological[i - 1].domain) switches++;
  }

  // Focus score: productive share of weighted total.
  // Neutral time counts as half-distraction so a day of only neutral browsing
  // scores low (not focused) without being as punishing as full distraction.
  let productiveMs = 0, distractionMs = 0, neutralMs = 0;
  for (const [domain, ms] of Object.entries(domainMap)) {
    const t = classifyDomain(domain);
    if (t === 'productive')  productiveMs  += ms;
    if (t === 'distraction') distractionMs += ms;
    if (t === 'neutral')     neutralMs     += ms;
  }
  const weightedDenominator = productiveMs + distractionMs + (neutralMs * 0.5);
  const focusScore = weightedDenominator > 0
    ? Math.round((productiveMs / weightedDenominator) * 100)
    : 100;

  // Hero stats
  $('stat-total-time').textContent  = fmtMs(totalMs);
  $('stat-switches').textContent    = String(switches);
  $('stat-focus-score').textContent = `${focusScore}%`;

  // Domain rows
  sorted.slice(0, 8).forEach(([domain, ms], i) => {
    const pct  = Math.round((ms / maxMs) * 100);
    const type = classifyDomain(domain);
    const row  = document.createElement('div');
    row.className = 'stats-row';
    row.style.animationDelay = `${i * 40}ms`;
    row.innerHTML = `
      <div class="stats-row-top">
        <img class="stats-favicon" src="https://www.google.com/s2/favicons?domain=${domain}&sz=14" width="14" height="14" onerror="this.style.display='none'" />
        <span class="stats-domain">${domain}</span>
        <span class="stats-type-badge ${type}">${type}</span>
        <span class="stats-time">${fmtMs(ms)}</span>
      </div>
      <div class="stats-bar-track">
        <div class="stats-bar-fill ${type}" style="width:${pct}%"></div>
      </div>
    `;
    domList.appendChild(row);
  });
}

// ─── CTA text ──────────────────────────────────────────────────────────────────

function ctaText(domain) {
  if (domain.includes('mail') || domain.includes('gmail'))       return 'Return to inbox';
  if (domain.includes('classroom'))                              return 'Return to Classroom';
  if (domain.includes('docs') || domain.includes('notion'))     return 'Resume document';
  if (domain.includes('github'))                                 return 'Get back to code';
  if (domain.includes('chat') || domain.includes('whatsapp') || domain.includes('slack')) return 'Resume chat';
  if (domain.includes('medium') || domain.includes('substack')) return 'Continue reading';
  if (domain.includes('youtube'))                                return 'Resume watching';
  return 'Jump back in ↗';
}

// ─── Open site ─────────────────────────────────────────────────────────────────

async function openSite(site) {
  await chrome.storage.local.set({
    pendingOverlay: {
      domain:    site.domain,
      awayLabel: '—',
      lastTitle: '',
      actions:   site.actions || [],
      timestamp: Date.now(),
    },
  });

  const tabs     = await chrome.tabs.query({});
  const existing = tabs.find(t => {
    try { return new URL(t.url).hostname.replace(/^www\./, '') === site.domain; } catch (_) { return false; }
  });

  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    // Clear pendingOverlay — we're delivering directly via message, so checkPending
    // won't run and the entry would otherwise persist as a ghost trigger.
    await chrome.storage.local.remove(['pendingOverlay']);
    chrome.tabs.sendMessage(existing.id, {
      type: 'SHOW_OVERLAY',
      data: { domain: site.domain, awayLabel: '—', actions: site.actions, lastTitle: '' },
    }).catch(() => {});
  } else {
    chrome.tabs.create({ url: site.lastUrl || `https://${site.domain}` });
  }
  window.close();
}

// ─── Tab switching ─────────────────────────────────────────────────────────────

function setupTabs() {
  const tabBar = $('tab-bar');
  if (!tabBar) return;
  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabName = btn.dataset.tab;
      $('tab-sessions').style.display = tabName === 'sessions' ? 'block' : 'none';
      $('tab-timeline').style.display = tabName === 'timeline' ? 'block' : 'none';
      $('tab-stats').style.display    = tabName === 'stats'    ? 'block' : 'none';
      $('footer').style.display       = tabName === 'sessions' ? 'flex'  : 'none';
    });
  });
}

// ─── State ─────────────────────────────────────────────────────────────────────
// FIX: removed $('no-key-state') reference — element no longer exists in HTML

function showState(s) {
  const noData  = $('no-data-state');
  const loading = $('loading-state');
  const content = $('content');
  const footer  = $('footer');

  if (noData)  noData.style.display  = 'none';
  if (loading) loading.style.display = 'none';
  if (content) content.style.display = 'none';
  if (footer)  footer.style.display  = 'none';

  if (s === 'no-data' && noData)  noData.style.display  = 'flex';
  if (s === 'loading' && loading) loading.style.display = 'flex';
  if (s === 'content') {
    if (content) content.style.display = 'block';
    if (footer)  footer.style.display  = 'flex';
  }
}

function setLoadingLabel(t) { const el = $('loading-label'); if (el) el.textContent = t; }
function showMain()     { $('main-view').style.display = 'flex'; $('settings-view').style.display = 'none'; }
function showSettings() { $('main-view').style.display = 'none'; $('settings-view').style.display = 'flex'; }

// ─── Settings ──────────────────────────────────────────────────────────────────

async function getSettings() {
  const r = await chrome.storage.local.get(['apiKey', 'returnThresholdMs', 'windowMinutes']);
  return {
    apiKey:            r.apiKey || '',
    returnThresholdMs: r.returnThresholdMs || 30 * 60 * 1000,
    windowMinutes:     r.windowMinutes || 180,
  };
}

async function loadSettingsIntoForm() {
  const s = await getSettings();
  $('api-key-input').value   = s.apiKey;
  $('threshold-input').value = Math.round(s.returnThresholdMs / 60000);
  $('window-select').value   = String(s.windowMinutes);
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiKey:            $('api-key-input').value.trim(),
    returnThresholdMs: (parseInt($('threshold-input').value) || 30) * 60000,
    windowMinutes:     parseInt($('window-select').value) || 180,
  });
  toast('Saved ✓', 'ok');
  setTimeout(() => { showMain(); run(false); }, 500);
}

// ─── Listeners ─────────────────────────────────────────────────────────────────

function setupListeners() {
  $('refresh-btn')?.addEventListener('click', async () => {
    $('refresh-btn').classList.add('spinning');
    await run(true);
    $('refresh-btn').classList.remove('spinning');
  });
  $('settings-btn')?.addEventListener('click', () => { loadSettingsIntoForm(); showSettings(); });
  $('back-btn')?.addEventListener('click', showMain);
  $('save-btn')?.addEventListener('click', saveSettings);
  $('clear-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all AFK session data?')) return;
    await chrome.storage.local.remove(['sessionLog', 'lastAnalysis', 'lastSeenDomains', 'returnDetected', 'pendingOverlay', 'activeSessions', 'pageMeta', 'scrollPositions', 'videoPositions']);
    toast('Cleared', 'ok');
    setTimeout(() => { showMain(); run(false); }, 500);
  });
}

// ─── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg, type = '') {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast ${type}`;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ─── Utils ─────────────────────────────────────────────────────────────────────

function safeParseJSON(raw, fallback) {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (_) {
    return fallback;
  }
}

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`;
}

function fmtDate(ts) {
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function trunc(str = '', len = 50) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}
