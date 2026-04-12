// AFK Content Script v2.1
// 1. Sends rich site-specific metadata to background (incl. siteContext)
// 2. Auto-triggers overlay on return detection
// 3. Handles popup-triggered overlays
// 4. Scroll position save & restore
// 5. Smart action dispatch (clicks real DOM elements)
// 6. SPA navigation tracking (pushState / replaceState)
// NOTE: Groq API calls are now in background.js — API key never touches this file

(function () {
  'use strict';
  if (window.__afkLoaded) return;
  window.__afkLoaded = true;

  // ── Site-specific DOM extractors ────────────────────────────────────────────

  const SITE_EXTRACTORS = {

    'linkedin.com': () => {
      const items = [];
      const convHeader = document.querySelector('.msg-thread__link-to-member, .msg-conversation-card__participant-names, .msg-entity-lockup__entity-title');
      if (convHeader) items.push('Open conversation: ' + convHeader.textContent.trim());
      document.querySelectorAll('.msg-conversation-listitem--unread .msg-conversation-card__participant-names').forEach(el => {
        const name = el.textContent.trim();
        if (name) items.push('Unread from: ' + name);
      });
      document.querySelectorAll('.msg-conversation-card__participant-names').forEach(el => {
        const name = el.textContent.trim();
        if (name && items.length < 5) items.push('Recent chat: ' + name);
      });
      const postTitle = document.querySelector('.feed-shared-update-v2__description, .article-main-image__title, h1.t-24');
      if (postTitle) items.push('Viewing: ' + postTitle.textContent.trim().slice(0, 80));
      return items.slice(0, 4);
    },

    'web.whatsapp.com': () => {
      const items = [];
      const openChat = document.querySelector('header .zoWT4, header ._3Tw1q, [data-testid="conversation-header"] span[dir="auto"]');
      if (openChat) items.push('Open chat: ' + openChat.textContent.trim());
      document.querySelectorAll('[data-testid="cell-frame-title"]').forEach(el => {
        const badge = el.closest('[data-testid="cell-frame-container"]')?.querySelector('[data-testid="icon-unread-count"], .Dvjym');
        if (badge) items.push('Unread from: ' + el.textContent.trim());
      });
      document.querySelectorAll('[data-testid="cell-frame-title"]').forEach(el => {
        const name = el.textContent.trim();
        if (name && items.length < 5) items.push('Recent chat: ' + name);
      });
      return items.slice(0, 4);
    },

    'mail.google.com': () => {
      const items = [];
      const subject = document.querySelector('h2.hP, .ha h2, [data-legacy-thread-id] h2');
      if (subject) items.push('Open email: ' + subject.textContent.trim());
      document.querySelectorAll('tr.zE .bog, tr.zE .yX').forEach(el => {
        const text = el.textContent.trim();
        if (text && items.length < 5) items.push('Unread: ' + text.slice(0, 60));
      });
      const inboxCount = document.querySelector('[title*="Inbox"]');
      if (inboxCount) items.push(inboxCount.getAttribute('title'));
      return items.slice(0, 4);
    },

    'claude.ai': () => {
      const items = [];
      const activeConv = document.querySelector('[data-testid="conversation-title"], .font-tiempos-medium, nav a[aria-current="page"] span');
      if (activeConv) items.push('Working on: ' + activeConv.textContent.trim().slice(0, 70));
      const project = document.querySelector('[data-testid="project-name"], .project-name');
      if (project) items.push('Project: ' + project.textContent.trim());
      const lastMsg = document.querySelector('.font-claude-message p, [data-testid="human-turn"] p');
      if (lastMsg) items.push('Last asked: ' + lastMsg.textContent.trim().slice(0, 80));
      return items.slice(0, 3);
    },

    'classroom.google.com': () => {
      const items = [];
      const assignment = document.querySelector('.roSPhc, h2.YVvGBb, .oqHJnc, [jsname="r4nke"]');
      if (assignment) items.push('Assignment: ' + assignment.textContent.trim().slice(0, 70));
      const className = document.querySelector('.YVvGBb, .Uoqcne span, h1.qRiKXd');
      if (className) items.push('Class: ' + className.textContent.trim());
      document.querySelectorAll('.Ub3Aoc .YVvGBb, .ds3Me').forEach(el => {
        const text = el.textContent.trim();
        if (text && items.length < 4) items.push('Due: ' + text.slice(0, 60));
      });
      return items.slice(0, 4);
    },

    'docs.google.com': () => {
      const items = [];
      const docName = document.querySelector('.docs-title-input, .waffle-name-box, #docs-toolbar input');
      if (docName) items.push('Document: ' + (docName.value || docName.textContent).trim());
      const heading = document.querySelector('.docs-gm h1, .docs-gm h2');
      if (heading) items.push('Last section: ' + heading.textContent.trim().slice(0, 60));
      return items.slice(0, 3);
    },

    'github.com': () => {
      const items = [];
      const repoName = document.querySelector('[itemprop="name"], strong[itemprop="name"] a');
      if (repoName) items.push('Repo: ' + repoName.textContent.trim());
      const issueTitle = document.querySelector('.js-issue-title, h1.gh-header-title .js-issue-title');
      if (issueTitle) items.push('Issue/PR: ' + issueTitle.textContent.trim().slice(0, 70));
      const branchName = document.querySelector('.branch-name, [data-hotkey="w"] .css-truncate-target');
      if (branchName) items.push('Branch: ' + branchName.textContent.trim());
      return items.slice(0, 3);
    },

    'youtube.com': () => {
      const items = [];
      const videoTitle = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string, h1.title');
      if (videoTitle) items.push('Watching: ' + videoTitle.textContent.trim().slice(0, 70));
      const channel = document.querySelector('#channel-name yt-formatted-string a, .ytd-channel-name a');
      if (channel) items.push('Channel: ' + channel.textContent.trim());
      return items.slice(0, 2);
    },

    'meet.google.com': () => {
      const items = [];
      const meetingName = document.querySelector('[data-meeting-title], .zWfAne, .NzPR9b');
      if (meetingName) items.push('Meeting: ' + meetingName.textContent.trim());
      const participants = document.querySelectorAll('[data-participant-id], .KF4T6b');
      if (participants.length) items.push(`${participants.length} participant(s) in call`);
      return items.slice(0, 2);
    },

    'x.com': () => {
      const items = [];
      const tweetText = document.querySelector('[data-testid="tweetText"]');
      if (tweetText) items.push('Post: ' + tweetText.textContent.trim().slice(0, 80));
      const profileName = document.querySelector('[data-testid="UserName"] span');
      if (profileName) items.push('Profile: ' + profileName.textContent.trim());
      return items.slice(0, 2);
    },

    'notion.so': () => {
      const items = [];
      const pageTitle = document.querySelector('.notion-page-block .notranslate, [placeholder="Untitled"]');
      if (pageTitle) items.push('Page: ' + pageTitle.textContent.trim().slice(0, 70));
      return items.slice(0, 2);
    },
  };

  function genericExtract() {
    const items = [];
    for (const tag of ['h1', 'h2', 'h3']) {
      document.querySelectorAll(tag).forEach(el => {
        const t = el.textContent.trim();
        if (t && t.length > 3 && t.length < 120) items.push(t);
      });
      if (items.length >= 4) break;
    }
    return items.slice(0, 4);
  }

  function getSiteContext() {
    const domain = location.hostname.replace(/^www\./, '');
    for (const [pattern, extractor] of Object.entries(SITE_EXTRACTORS)) {
      if (domain.includes(pattern.replace(/^www\./, ''))) {
        try { return extractor(); } catch (_) { return genericExtract(); }
      }
    }
    return genericExtract();
  }

  // ── SPA navigation tracking ─────────────────────────────────────────────────
  // Detects pushState/replaceState navigation in React/Vue/Angular apps

  function patchHistory() {
    const _push    = history.pushState.bind(history);
    const _replace = history.replaceState.bind(history);

    const onNavigation = () => {
      // Debounce — wait for page to settle
      setTimeout(() => {
        chrome.runtime.sendMessage({
          type:  'SPA_NAVIGATE',
          url:   location.href,
          title: document.title,
        }).catch(() => {});
        sendMeta(); // re-send metadata for new view
      }, 600);
    };

    history.pushState = function (...args) {
      _push(...args);
      onNavigation();
    };
    history.replaceState = function (...args) {
      _replace(...args);
      onNavigation();
    };

    window.addEventListener('popstate', onNavigation);
  }

  patchHistory();

  // ── Scroll position save ────────────────────────────────────────────────────

  let _scrollTimer;
  function _persistScroll() {
    const y = Math.round(window.scrollY);
    if (y < 50) return;
    chrome.storage.local.get(['scrollPositions'], r => {
      const sp = r.scrollPositions || {};
      sp[location.href] = { y, ts: Date.now() };
      const keys = Object.keys(sp);
      if (keys.length > 200) delete sp[keys[0]];
      chrome.storage.local.set({ scrollPositions: sp });
    });
  }

  window.addEventListener('scroll', () => {
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(_persistScroll, 800);
  }, { passive: true });

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _persistScroll();
  });

  // Also save video currentTime for YouTube
  function saveVideoTime() {
    const video = document.querySelector('video');
    if (!video || video.paused || video.currentTime < 5) return;
    chrome.storage.local.get(['videoPositions'], r => {
      const vp = r.videoPositions || {};
      vp[location.href] = { t: Math.floor(video.currentTime), ts: Date.now() };
      chrome.storage.local.set({ videoPositions: vp });
    });
  }

  if (location.hostname.includes('youtube')) {
    setInterval(saveVideoTime, 5000);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveVideoTime();
    });
  }

  // ── Send metadata ───────────────────────────────────────────────────────────

  function sendMeta() {
    const siteContext = getSiteContext();
    const meta = {
      title:       document.title,
      url:         location.href,
      description: getMeta('description') || getMeta('og:description') || '',
      keywords:    getMeta('keywords') || '',
      headings:    getHeadings(),
      siteContext,
      timestamp:   Date.now(),
    };
    chrome.runtime.sendMessage({ type: 'PAGE_META', meta }).catch(() => {});
  }

  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`) ||
               document.querySelector(`meta[property="${name}"]`);
    return el ? el.getAttribute('content') : '';
  }

  function getHeadings() {
    const headings = [];
    for (const tag of ['h1', 'h2', 'h3']) {
      document.querySelectorAll(tag).forEach(el => {
        const t = el.textContent.trim();
        if (t && t.length < 120) headings.push(t);
      });
      if (headings.length >= 5) break;
    }
    return headings.slice(0, 5);
  }

  function scheduleMeta() {
    sendMeta();
    setTimeout(sendMeta, 3000);
  }

  if (document.readyState === 'complete') scheduleMeta();
  else window.addEventListener('load', scheduleMeta);

  // ── Auto-trigger on return detection ───────────────────────────────────────

  function checkReturn() {
    const domain = location.hostname.replace(/^www\./, '');
    chrome.storage.local.get(['returnDetected', 'sessionLog', 'scrollPositions', 'videoPositions'], async result => {
      const ret = result.returnDetected;
      if (!ret?.flagged || ret.domain !== domain) return;

      const entries = (result.sessionLog || []).filter(e => e.domain === domain);
      // Only clear the flag once we know we have something to show
      if (!entries.length) return;
      chrome.storage.local.set({ returnDetected: { ...ret, flagged: false } });

      entries.sort((a, b) => b.endTime - a.endTime);
      const recent = entries.slice(0, 5);

      const awayMins  = Math.round(ret.awayMs / 60000);
      const awayLabel = awayMins < 60
        ? `${awayMins}m`
        : `${Math.floor(awayMins / 60)}h ${awayMins % 60}m`;

      const liveContext    = getSiteContext();
      const savedScrollY   = (result.scrollPositions || {})[location.href]?.y;
      const savedVideoTime = (result.videoPositions || {})[location.href]?.t;

      // Always ask background to generate actions — it reads apiKey from storage itself,
      // so the key never touches the content script.
      chrome.runtime.sendMessage({
        type: 'GENERATE_ACTIONS',
        domain,
        entries: recent,
        liveContext,
      }, response => {
        const actions = response?.actions || heuristicActions(
          recent[0]?.title || document.title,
          recent[0]?.headings || [],
          recent[0]?.siteContext || liveContext
        );
        injectOverlay({ domain, awayLabel, actions, lastTitle: recent[0]?.title || document.title, savedScrollY, savedVideoTime });
      });
    });
  }

  // ── Popup-triggered overlay ─────────────────────────────────────────────────

  function checkPending() {
    const domain = location.hostname.replace(/^www\./, '');
    chrome.storage.local.get(['pendingOverlay', 'scrollPositions', 'videoPositions'], result => {
      const p = result.pendingOverlay;
      if (!p || p.domain !== domain) return;
      chrome.storage.local.remove(['pendingOverlay']);
      const savedScrollY   = (result.scrollPositions || {})[location.href]?.y;
      const savedVideoTime = (result.videoPositions || {})[location.href]?.t;
      injectOverlay({ ...p, savedScrollY, savedVideoTime });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_OVERLAY') {
      chrome.storage.local.get(['scrollPositions', 'videoPositions'], r => {
        const savedScrollY   = (r.scrollPositions || {})[location.href]?.y;
        const savedVideoTime = (r.videoPositions || {})[location.href]?.t;
        injectOverlay({ ...msg.data, savedScrollY, savedVideoTime });
      });
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'AFK_TEST') {
      const ctx = getSiteContext();
      injectOverlay({
        domain:    location.hostname,
        awayLabel: '45m',
        lastTitle: document.title,
        actions:   heuristicActions(document.title, getHeadings(), ctx).concat(ctx.slice(0, 2)),
        savedScrollY: Math.round(window.scrollY) || undefined,
      });
    }
  });

  if (document.readyState === 'complete') { checkReturn(); checkPending(); }
  else window.addEventListener('load', () => { checkReturn(); checkPending(); });

  // ── Heuristic actions (local fallback, no AI needed) ───────────────────────

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
      if (t.includes('assignment') || t.includes('classroom')) actions.push(`Finish: "${trunc(title, 45)}"`);
      else if (t.includes('article') || t.includes('read'))    actions.push(`Continue reading: "${trunc(title, 40)}"`);
      else if (t.includes('doc') || t.includes('sheet'))       actions.push('Resume editing your document');
      else if (t.includes('youtube') || t.includes('watch'))   actions.push('Resume watching the video');
      else if (headings.length)                                 actions.push(`Continue at: "${trunc(headings[0], 48)}"`);
      else                                                      actions.push(`Continue: "${trunc(title, 50)}"`);
    }

    return actions.slice(0, 2);
  }

  function trunc(s = '', n = 50) { return s.length > n ? s.slice(0, n) + '…' : s; }

  // ── Scroll restore — core "wow moment" ─────────────────────────────────────

  function restoreScroll(savedScrollY) {
    window.scrollTo({ top: savedScrollY, behavior: 'smooth' });
    // Flash-highlight the viewport area at the restored position
    setTimeout(() => {
      const flash = document.createElement('div');
      flash.id = 'afk-scroll-flash';
      flash.style.cssText = `
        position:fixed !important; top:0 !important; left:0 !important;
        width:100% !important; height:100% !important; pointer-events:none !important;
        z-index:2147483646 !important;
        background:linear-gradient(180deg,rgba(108,92,231,0.07) 0%,rgba(0,206,201,0.05) 100%) !important;
        animation:afk-flash 1.1s ease forwards !important;
      `;
      // Inject flash keyframes if not already present
      if (!document.getElementById('afk-flash-style')) {
        const fs = document.createElement('style');
        fs.id = 'afk-flash-style';
        fs.textContent = '@keyframes afk-flash { 0%{opacity:1} 60%{opacity:0.6} 100%{opacity:0} }';
        document.head.appendChild(fs);
      }
      document.body.appendChild(flash);
      setTimeout(() => flash.remove(), 1100);
    }, 350); // wait for scroll to land
  }

  function scrollToFirstHeading() {
    const heading = document.querySelector('h1, h2, h3, [role="heading"]');
    if (heading) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      console.log('[AFK] Scrolled to first heading:', heading.textContent.trim().slice(0, 60));
      return true;
    }
    return false;
  }

  // ── Smart action dispatch ───────────────────────────────────────────────────

  function dispatchSmartAction(actionText, domain, overlayEl, savedScrollY, savedVideoTime) {
    const raw = actionText.replace(/^→\s*/, '').trim();
    const a   = raw.toLowerCase();
    const nameMatch = raw.match(/^(?:Reply to|Continue|Open|Finish|Resume|Check|Watch)\s+(.+)$/i);
    const subject   = nameMatch ? nameMatch[1].trim() : '';

    let handled = false;

    try {
      if (domain.includes('whatsapp') && subject) {
        const target = [...document.querySelectorAll('[data-testid="cell-frame-title"]')]
          .find(el => el.textContent.trim().toLowerCase().includes(subject.toLowerCase()));
        if (target) {
          target.closest('[data-testid="cell-frame-container"]')?.click();
          console.log('[AFK] WhatsApp: opened chat with', subject);
          handled = true;
        }
      }

      if (!handled && domain.includes('linkedin') && subject) {
        const target = [...document.querySelectorAll('.msg-conversation-card__participant-names')]
          .find(el => el.textContent.toLowerCase().includes(subject.toLowerCase()));
        if (target) {
          target.closest('.msg-conversation-listitem')?.click();
          console.log('[AFK] LinkedIn: opened conversation with', subject);
          handled = true;
        }
      }

      if (!handled && domain.includes('mail.google') && subject) {
        const target = [...document.querySelectorAll('tr.zA')]
          .find(r => r.textContent.toLowerCase().includes(subject.toLowerCase()));
        if (target) {
          target.click();
          console.log('[AFK] Gmail: opened thread matching', subject);
          handled = true;
        }
      }

      if (!handled && domain.includes('youtube') && (a.includes('watch') || a.includes('video') || a.includes('resume') || a.includes('play'))) {
        const video = document.querySelector('video');
        if (video) {
          if (savedVideoTime && savedVideoTime > 5) {
            video.currentTime = savedVideoTime;
            console.log('[AFK] YouTube: restored video time to', savedVideoTime + 's');
          }
          if (video.paused) video.play().catch(() => {});
          handled = true;
        }
      }

      if (!handled && domain.includes('docs.google')) {
        const frame    = document.querySelector('.docs-texteventtarget-iframe');
        const editable = document.querySelector('[contenteditable="true"]');
        if (frame)         { frame.focus();    console.log('[AFK] Google Docs: focused editor iframe'); handled = true; }
        else if (editable) { editable.focus(); console.log('[AFK] Google Docs: focused editable area'); handled = true; }
      }

      if (!handled && domain.includes('github') && a.includes('reply')) {
        const commentBox = document.querySelector('#new_comment_field, .comment-form-textarea');
        if (commentBox) {
          commentBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
          commentBox.focus();
          console.log('[AFK] GitHub: focused comment box');
          handled = true;
        }
      }

      if (!handled && domain.includes('notion') && (a.includes('resum') || a.includes('edit') || a.includes('finish'))) {
        const editor = document.querySelector('.notion-page-content [contenteditable="true"]');
        if (editor) {
          editor.focus();
          console.log('[AFK] Notion: focused page editor');
          handled = true;
        }
      }
    } catch (err) {
      console.warn('[AFK] Smart action dispatch error:', err);
    }

    // ── Fallback chain — always do SOMETHING visible ──────────────────────────
    if (!handled) {
      if (savedScrollY && savedScrollY > 200) {
        restoreScroll(savedScrollY);
        console.log('[AFK] Fallback: restored scroll to', savedScrollY);
      } else if (scrollToFirstHeading()) {
        // handled inside
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        console.log('[AFK] Fallback: scrolled to top');
      }
    }

    _dismissOverlay(overlayEl);
  }

  function _dismissOverlay(el) {
    el.style.animation = 'afk-out 0.22s ease forwards';
    setTimeout(() => el.remove(), 220);
  }

  // ── Inject overlay ──────────────────────────────────────────────────────────

  function injectOverlay(data) {
    if (document.getElementById('afk-overlay')) return;

    const { domain, awayLabel, actions = [], lastTitle = '', savedScrollY, savedVideoTime } = data;
    const hasScroll = savedScrollY && savedScrollY > 200;
    const hasVideo  = savedVideoTime && savedVideoTime > 5;
    const domainClean = location.hostname.replace(/^www\./, '');

    // Escape HTML to prevent XSS from page-derived strings
    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Primary action — scroll restore gets top billing
    let primaryHTML = '';
    if (hasVideo) {
      const mins = Math.floor(savedVideoTime / 60), secs = savedVideoTime % 60;
      primaryHTML = `<button id="afk-primary">▶ Resume video at ${mins}:${String(secs).padStart(2,'0')}</button>`;
    } else if (hasScroll) {
      primaryHTML = `<button id="afk-primary">↩ Jump back to where you were</button>`;
    }

    // Secondary context actions
    const secondaryHTML = (actions.length ? actions : [])
      .map((a, i) => `<button class="afk-action" data-idx="${i}">→ ${esc(a.replace(/^→\s*/, ''))}</button>`)
      .join('');

    const el = document.createElement('div');
    el.id = 'afk-overlay';
    el.innerHTML = `
      <div id="afk-card">
        <div id="afk-top">
          <div id="afk-brand">
            <img id="afk-logo" src="${chrome.runtime.getURL('icons/icon32.png')}" width="18" height="18" />
            <span id="afk-name">AFK</span>
            ${awayLabel && awayLabel !== '—' ? `<span id="afk-away-pill">${esc(awayLabel)} ago</span>` : ''}
          </div>
          <button id="afk-close" title="Dismiss">✕</button>
        </div>
        <div id="afk-headline">You were here before you left</div>
        ${lastTitle ? `<div id="afk-last">${esc(trunc(lastTitle, 52))}</div>` : ''}
        <div id="afk-subtext">Jump back in instantly</div>
        ${primaryHTML ? `<div id="afk-primary-wrap">${primaryHTML}</div>` : ''}
        ${secondaryHTML ? `<div id="afk-actions">${secondaryHTML}</div>` : ''}
        ${!primaryHTML && !secondaryHTML ? `<button class="afk-action" data-idx="-1">→ Continue where you left off</button>` : ''}
      </div>
    `;

    const style = document.createElement('style');
    style.id = 'afk-style';
    style.textContent = `
      #afk-overlay {
        position:fixed !important; bottom:24px !important; right:24px !important;
        z-index:2147483647 !important;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;
        animation:afk-in 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;
      }
      @keyframes afk-in  { from{opacity:0;transform:translateY(16px) scale(0.95)} to{opacity:1;transform:translateY(0) scale(1)} }
      @keyframes afk-out { from{opacity:1;transform:translateY(0)} to{opacity:0;transform:translateY(12px)} }
      #afk-card {
        width:308px; background:#0c0c18; border:1px solid #28284a;
        border-radius:16px; padding:16px 16px 14px;
        box-shadow:0 16px 56px rgba(0,0,0,0.65),0 0 0 1px rgba(108,92,231,0.12);
        position:relative; overflow:hidden;
      }
      #afk-card::before {
        content:''; position:absolute; top:0;left:0;right:0; height:2px;
        background:linear-gradient(90deg,#6c5ce7,#00cec9);
      }
      #afk-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      #afk-brand { display:flex; align-items:center; gap:6px; }
      #afk-logo { border-radius:4px !important; display:block !important; }
      #afk-name { font-size:10px; font-weight:800; letter-spacing:0.18em; color:#636380; }
      #afk-away-pill {
        font-size:9.5px !important; font-weight:600 !important; letter-spacing:0.04em !important;
        color:#6c5ce7 !important; background:rgba(108,92,231,0.12) !important;
        border:1px solid rgba(108,92,231,0.22) !important;
        border-radius:20px !important; padding:1px 7px !important; margin-left:2px !important;
      }
      #afk-close {
        background:none !important; border:none !important; color:#44445a !important;
        font-size:14px !important; cursor:pointer !important; padding:2px 5px !important;
        border-radius:4px !important; transition:color 0.15s !important; line-height:1 !important;
      }
      #afk-close:hover { color:#e0dff0 !important; }
      #afk-headline { font-size:13px; font-weight:700; color:#e0dff0; margin-bottom:4px; line-height:1.3; }
      #afk-last { font-size:11px; color:#55556a; margin-bottom:5px; line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #afk-subtext { font-size:10.5px; color:#44445a; margin-bottom:12px; }
      #afk-primary-wrap { margin-bottom:8px; }
      #afk-primary {
        display:block !important; width:100% !important; text-align:center !important;
        background:linear-gradient(135deg,#6c5ce7,#00b4b0) !important;
        border:none !important; border-radius:10px !important;
        padding:11px 14px !important; font-size:12.5px !important; font-weight:700 !important;
        color:#fff !important; cursor:pointer !important;
        transition:opacity 0.15s, transform 0.15s !important; font-family:inherit !important;
        letter-spacing:0.01em !important;
        box-shadow:0 4px 18px rgba(108,92,231,0.35) !important;
      }
      #afk-primary:hover { opacity:0.92 !important; transform:translateY(-1px) !important; }
      #afk-primary:active { transform:translateY(0) !important; }
      #afk-actions { display:flex; flex-direction:column; gap:5px; }
      .afk-action {
        display:block !important; width:100% !important; text-align:left !important;
        background:#12121e !important; border:1px solid #1e1e35 !important;
        border-radius:8px !important; padding:8px 11px !important;
        font-size:11.5px !important; color:#9898b8 !important; cursor:pointer !important;
        transition:all 0.15s !important; font-family:inherit !important; line-height:1.45 !important;
      }
      .afk-action:hover { border-color:#6c5ce7 !important; background:rgba(108,92,231,0.08) !important; color:#c8c7e0 !important; transform:translateX(2px) !important; }
    `;

    if (!document.getElementById('afk-style')) document.head.appendChild(style);
    document.body.appendChild(el);

    // Auto-scroll to saved position as soon as overlay appears
    if (hasScroll) {
      restoreScroll(savedScrollY);
      console.log('[AFK] Auto-restored scroll to', savedScrollY, 'on overlay mount');
    }

    document.getElementById('afk-close').onclick = () => _dismissOverlay(el);

    const primaryBtn = document.getElementById('afk-primary');
    if (primaryBtn) {
      primaryBtn.onclick = () => {
        if (hasVideo) {
          const video = document.querySelector('video');
          if (video) { video.currentTime = savedVideoTime; if (video.paused) video.play().catch(() => {}); }
        } else {
          restoreScroll(savedScrollY);
        }
        _dismissOverlay(el);
      };
    }

    el.querySelectorAll('.afk-action').forEach((btn, i) => {
      btn.onclick = () => dispatchSmartAction(actions[i] || '', domainClean, el, savedScrollY, savedVideoTime);
    });
  }

})();
