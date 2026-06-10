// ==UserScript==
// @name         Claude Session Manager
// @namespace    https://claude.ai
// @version      1.0.8
// @description  Cross-account conversation tracker and session manager for Claude.ai
// @author       claude@anthropic
// @match        https://claude.ai/*
// @updateURL    https://raw.githubusercontent.com/Emball/ClaudeSessionManager/main/claude_session_manager.user.js
// @downloadURL  https://raw.githubusercontent.com/Emball/ClaudeSessionManager/main/claude_session_manager.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'csm_data';
  const GIST_TOKEN_KEY = 'csm_gist_token';
  const GIST_ID_KEY = 'csm_gist_id';
  const GIST_FILENAME = 'claude-sessions.json';
  const SYNC_INTERVAL_MS = 30_000; // push to Gist every 30s if dirty
  const PANEL_ID = 'csm-panel';

  // ─── Data model ──────────────────────────────────────────────────────────────
  // {
  //   accounts: { [email]: { label, sessionKeyLC, lastSeen } },
  //   conversations: { [convId]: { title, url, accountEmail, model, lastMessage, parentConvId, childConvIds[], notes, updatedAt } },
  //   settings: { gistToken, gistId, autoSwap }
  // }

  let data = {
    accounts: {},
    conversations: {},
    settings: { gistToken: '', gistId: '', autoSwap: false },
  };
  let dirty = false;

  // ─── Storage helpers ──────────────────────────────────────────────────────────
  function loadLocal() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (raw) {
        const parsed = JSON.parse(raw);
        data.accounts = parsed.accounts || {};
        data.conversations = parsed.conversations || {};
        data.settings.autoSwap = parsed.settings?.autoSwap || false;
      }
      // Token and gistId stored separately, never in the main blob
      data.settings.gistToken = GM_getValue(GIST_TOKEN_KEY, '');
      data.settings.gistId = GM_getValue(GIST_ID_KEY, '');
    } catch (e) {
      console.warn('[CSM] Failed to load local data:', e);
    }
  }

  function saveLocal() {
    // Never serialize token or gistId into the Gist-pushed blob
    const payload = {
      accounts: data.accounts,
      conversations: data.conversations,
      settings: { autoSwap: data.settings.autoSwap },
    };
    GM_setValue(STORAGE_KEY, JSON.stringify(payload));
    GM_setValue(GIST_TOKEN_KEY, data.settings.gistToken || '');
    GM_setValue(GIST_ID_KEY, data.settings.gistId || '');
    dirty = true;
  }

  // ─── Cookie helpers ──────────────────────────────────────────────────────────
  function getCookie(name) {
    const match = document.cookie.split(';').find(c => c.trim().startsWith(name + '='));
    return match ? decodeURIComponent(match.trim().slice(name.length + 1)) : null;
  }

  function setCookie(name, value, days = 30) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; domain=.claude.ai; SameSite=Lax`;
  }

  // ─── Account detection ───────────────────────────────────────────────────────
  // Cache the detected account in memory so we don't re-scan on every call
  let _cachedAccount = null;

  function detectAccount() {
    return _cachedAccount;
  }

  // Fetch account info directly from the API — bootstrap has already fired by the time we init
  async function fetchAccountFromAPI() {
    try {
      const res = await fetch('/api/account_profile', { credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        const account = json?.account || json;
        if (account?.email_address) {
          _cachedAccount = { email: account.email_address, uuid: account.uuid };
          return _cachedAccount;
        }
      }
    } catch {}

    // Fallback: try /api/bootstrap endpoint directly
    try {
      const bootstrapUrls = performance.getEntriesByType('resource')
        .filter(r => r.name.includes('/edge-api/bootstrap/'))
        .map(r => r.name);
      if (bootstrapUrls.length) {
        const res = await fetch(bootstrapUrls[0], { credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          const account = json?.account || json;
          if (account?.email_address) {
            _cachedAccount = { email: account.email_address, uuid: account.uuid };
            return _cachedAccount;
          }
        }
      }
    } catch {}

    // Last resort: extract org UUID from bootstrap URL and try accounts API
    try {
      const entry = performance.getEntriesByType('resource')
        .find(r => r.name.includes('/edge-api/bootstrap/'));
      const uuidMatch = entry?.name.match(/bootstrap\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const res = await fetch(`/api/organizations/${uuidMatch[1]}/members/me`, { credentials: 'include' });
        if (res.ok) {
          const json = await res.json();
          if (json?.email_address) {
            _cachedAccount = { email: json.email_address, uuid: json.uuid };
            return _cachedAccount;
          }
        }
      }
    } catch {}

    console.warn('[CSM] Could not detect account email');
    return null;
  }

  function registerCurrentAccount(account) {
    if (!account) account = detectAccount();
    if (!account || !account.email) return null;
    const sessionKeyLC = getCookie('sessionKeyLC');
    if (!data.accounts[account.email]) {
      data.accounts[account.email] = {
        label: account.email.split('@')[0],
        sessionKeyLC: sessionKeyLC || '',
        lastSeen: Date.now(),
        uuid: account.uuid,
      };
    } else {
      // Update session token + lastSeen
      if (sessionKeyLC) data.accounts[account.email].sessionKeyLC = sessionKeyLC;
      data.accounts[account.email].lastSeen = Date.now();
      data.accounts[account.email].uuid = account.uuid;
    }
    saveLocal();
    return account.email;
  }

  // ─── Conversation detection ───────────────────────────────────────────────────
  function getConvIdFromUrl() {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/);
    return match ? match[1] : null;
  }

  function extractConvTitle() {
    // Try <title> tag first
    const t = document.title;
    if (t && t !== 'Claude') return t.replace(' - Claude', '').trim();
    // Try first h1/h2 in the conversation header
    const h = document.querySelector('[data-testid="conversation-title"], h1, h2');
    return h ? h.textContent.trim() : 'Untitled';
  }

  function detectModel() {
    // Look for the model selector button text
    const btn = document.querySelector('[data-testid="model-selector-dropdown"] span, [aria-label*="model"] span');
    return btn ? btn.textContent.trim() : null;
  }

  function registerCurrentConversation(accountEmail) {
    const convId = getConvIdFromUrl();
    if (!convId || !accountEmail) return;

    const existing = data.conversations[convId];
    data.conversations[convId] = {
      ...existing,
      convId,
      title: extractConvTitle(),
      url: window.location.href,
      accountEmail,
      model: detectModel() || existing?.model || null,
      lastMessage: Date.now(),
      parentConvId: existing?.parentConvId || null,
      childConvIds: existing?.childConvIds || [],
      notes: existing?.notes || '',
      updatedAt: Date.now(),
    };
    saveLocal();
  }

  // ─── Limit detection ─────────────────────────────────────────────────────────
  // Hard limit patterns — must match the actual "you're blocked" state
  const HARD_LIMIT_PATTERNS = [
    /you.ve reached your (usage|session|weekly|monthly|daily) limit/i,
    /you are out of free messages until/i,
    /^usage limit reached$/im,
    /you.re out of (extra usage|usage credits)/i,
    /token limit reached/i,
  ];

  // Soft warning patterns — approaching but NOT blocked
  const SOFT_WARNING_PATTERNS = [
    /almost out of (usage|extra usage|usage credits)/i,
    /\d+%.*of.*limit/i,
    /resuming the full session will consume/i,
    /this task runs during peak hours/i,
    /opus consumes usage limits faster/i,
  ];

  function isLimitReached() {
    const bodyText = document.body.innerText;
    if (SOFT_WARNING_PATTERNS.some(re => re.test(bodyText))) return false;
    return HARD_LIMIT_PATTERNS.some(re => re.test(bodyText));
  }

  // ─── Session swap ─────────────────────────────────────────────────────────────
  // sessionKeyLC is only a cache namespace key — not an auth token.
  // Real auth is sessionKey (HttpOnly).
  // Claude's own switch-account button: /logout?selectAccount=true&returnTo=<path>
  // We chain returnTo so after server logout, /login gets login_hint=<email> and
  // Google auto-selects the right account without a password prompt.
  function swapToAccount(email) {
    if (!email) return false;
    showToast(`Switching to ${email}…`);
    const finalDest = window.location.pathname + window.location.search;
    const loginAfter = `/login?login_hint=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(finalDest)}`;
    const logoutUrl = `/logout?selectAccount=true&returnTo=${encodeURIComponent(loginAfter)}`;
    setTimeout(() => { window.location.href = logoutUrl; }, 600);
    return true;
  }

  function nextFreshAccount(currentEmail) {
    // Return most recently seen account that isn't the current one
    const candidates = Object.entries(data.accounts)
      .filter(([email]) => email !== currentEmail)
      .sort(([, a], [, b]) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return candidates.length ? candidates[0][0] : null;
  }

  // ─── Gist sync ───────────────────────────────────────────────────────────────
  function gistRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `https://api.github.com${path}`,
        headers: {
          Authorization: `token ${data.settings.gistToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github.v3+json',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch { resolve(r.responseText); }
        },
        onerror: reject,
      });
    });
  }

  async function pushToGist() {
    if (!data.settings.gistToken || !dirty) return;

    // Strip sensitive keys before pushing
    const safeData = {
      accounts: data.accounts,
      conversations: data.conversations,
      settings: { autoSwap: data.settings.autoSwap },
    };
    const content = JSON.stringify(safeData, null, 2);
    try {
      if (!data.settings.gistId) {
        // Create new gist
        const res = await gistRequest('POST', '/gists', {
          description: 'Claude Session Manager data',
          public: false,
          files: { [GIST_FILENAME]: { content } },
        });
        if (res.id) {
          data.settings.gistId = res.id;
          saveLocal();
        }
      } else {
        await gistRequest('PATCH', `/gists/${data.settings.gistId}`, {
          files: { [GIST_FILENAME]: { content } },
        });
      }
      dirty = false;
    } catch (e) {
      console.warn('[CSM] Gist push failed:', e);
    }
  }

  async function pullFromGist() {
    if (!data.settings.gistToken || !data.settings.gistId) return;
    try {
      const res = await gistRequest('GET', `/gists/${data.settings.gistId}`);
      const raw = res?.files?.[GIST_FILENAME]?.content;
      if (raw) {
        const remote = JSON.parse(raw);
        // Merge: remote wins for accounts/conversations, keep local settings
        data.accounts = { ...remote.accounts, ...data.accounts };
        data.conversations = { ...remote.conversations, ...data.conversations };
        saveLocal();
      }
    } catch (e) {
      console.warn('[CSM] Gist pull failed:', e);
    }
  }

  // ─── Toast ───────────────────────────────────────────────────────────────────
  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `
      position:fixed; bottom:80px; right:20px; z-index:99999;
      background:#1a1a1a; color:#fff; padding:10px 16px; border-radius:8px;
      font-size:13px; font-family:sans-serif; opacity:0;
      transition:opacity 0.3s; max-width:300px; box-shadow:0 4px 12px rgba(0,0,0,.4);
    `;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3000);
  }

  // ─── Panel UI ────────────────────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #csm-toggle {
        position: fixed; bottom: 20px; right: 20px; z-index: 99998;
        width: 44px; height: 44px; border-radius: 50%;
        background: #2563eb; color: #fff; border: none; cursor: pointer;
        font-size: 20px; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 12px rgba(37,99,235,.5); transition: transform 0.2s;
      }
      #csm-toggle:hover { transform: scale(1.1); }
      #csm-panel {
        position: fixed; bottom: 74px; right: 20px; z-index: 99997;
        width: 360px; max-height: 70vh; background: #1e1e2e;
        border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.6);
        overflow: hidden; display: none; flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; color: #cdd6f4;
      }
      #csm-panel.open { display: flex; }
      .csm-header {
        padding: 12px 16px; background: #313244; display: flex;
        align-items: center; justify-content: space-between;
        font-weight: 600; font-size: 14px;
      }
      .csm-tabs {
        display: flex; background: #181825; border-bottom: 1px solid #313244;
      }
      .csm-tab {
        flex: 1; padding: 8px; text-align: center; cursor: pointer;
        font-size: 12px; color: #6c7086; transition: color 0.2s;
        border-bottom: 2px solid transparent;
      }
      .csm-tab.active { color: #cdd6f4; border-bottom-color: #2563eb; }
      .csm-body { flex: 1; overflow-y: auto; padding: 12px; }
      .csm-section { margin-bottom: 16px; }
      .csm-section-title {
        font-size: 11px; font-weight: 600; text-transform: uppercase;
        color: #6c7086; margin-bottom: 8px; letter-spacing: 0.05em;
      }
      .csm-account-row {
        display: flex; align-items: center; gap: 8px; padding: 8px;
        background: #313244; border-radius: 8px; margin-bottom: 6px;
        cursor: pointer; transition: background 0.15s;
      }
      .csm-account-row:hover { background: #45475a; }
      .csm-account-row.current { border-left: 3px solid #a6e3a1; }
      .csm-avatar {
        width: 28px; height: 28px; border-radius: 50%; background: #2563eb;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0;
      }
      .csm-account-info { flex: 1; min-width: 0; }
      .csm-account-email { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .csm-account-meta { font-size: 10px; color: #6c7086; margin-top: 1px; }
      .csm-swap-btn {
        padding: 3px 8px; background: #2563eb; color: #fff; border: none;
        border-radius: 4px; cursor: pointer; font-size: 11px;
      }
      .csm-conv-row {
        padding: 8px; background: #313244; border-radius: 8px;
        margin-bottom: 6px; cursor: pointer; transition: background 0.15s;
      }
      .csm-conv-row:hover { background: #45475a; }
      .csm-conv-row.current { border-left: 3px solid #89b4fa; }
      .csm-conv-title { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .csm-conv-meta { font-size: 10px; color: #6c7086; margin-top: 2px; }
      .csm-conv-actions { margin-top: 6px; display: flex; gap: 6px; }
      .csm-btn-sm {
        padding: 3px 8px; border: 1px solid #45475a; background: transparent;
        color: #cdd6f4; border-radius: 4px; cursor: pointer; font-size: 11px;
      }
      .csm-btn-sm:hover { background: #45475a; }
      .csm-search {
        width: 100%; padding: 6px 10px; background: #313244; border: none;
        border-radius: 6px; color: #cdd6f4; font-size: 12px; margin-bottom: 10px;
        outline: none;
      }
      .csm-search::placeholder { color: #6c7086; }
      .csm-settings-row { margin-bottom: 10px; }
      .csm-settings-row label { display: block; font-size: 11px; color: #6c7086; margin-bottom: 4px; }
      .csm-settings-row input[type=text], .csm-settings-row input[type=password] {
        width: 100%; padding: 6px 10px; background: #313244; border: none;
        border-radius: 6px; color: #cdd6f4; font-size: 12px; outline: none;
        box-sizing: border-box;
      }
      .csm-settings-row input[type=checkbox] { margin-right: 6px; }
      .csm-btn-primary {
        width: 100%; padding: 8px; background: #2563eb; color: #fff;
        border: none; border-radius: 6px; cursor: pointer; font-size: 13px;
        font-weight: 600; margin-top: 4px;
      }
      .csm-btn-primary:hover { background: #1d4ed8; }
      .csm-limit-banner {
        background: #f38ba8; color: #1e1e2e; padding: 8px 12px;
        border-radius: 8px; margin-bottom: 10px; font-weight: 600;
        font-size: 12px; text-align: center;
      }
      .csm-chain-picker {
        margin-top: 6px; padding: 6px; background: #181825; border-radius: 6px;
        display: none;
      }
      .csm-chain-picker.open { display: block; }
      .csm-chain-picker select {
        width: 100%; padding: 4px; background: #313244; color: #cdd6f4;
        border: none; border-radius: 4px; font-size: 11px;
      }
      .csm-empty { color: #6c7086; font-size: 12px; text-align: center; padding: 20px 0; }
    `;
    document.head.appendChild(style);

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'csm-toggle';
    toggleBtn.innerHTML = '🗂';
    toggleBtn.title = 'Claude Session Manager';
    document.body.appendChild(toggleBtn);

    // Panel
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="csm-header">
        <span>🗂 Session Manager</span>
        <span id="csm-sync-status" style="font-size:11px;color:#6c7086"></span>
      </div>
      <div class="csm-tabs">
        <div class="csm-tab active" data-tab="accounts">Accounts</div>
        <div class="csm-tab" data-tab="conversations">Convos</div>
        <div class="csm-tab" data-tab="settings">Settings</div>
      </div>
      <div class="csm-body" id="csm-body"></div>
    `;
    document.body.appendChild(panel);

    toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) renderPanel();
    });

    panel.querySelectorAll('.csm-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.csm-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderPanel();
      });
    });
  }

  function activeTab() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return 'accounts';
    const active = panel.querySelector('.csm-tab.active');
    return active ? active.dataset.tab : 'accounts';
  }

  function renderPanel() {
    const body = document.getElementById('csm-body');
    if (!body) return;
    const tab = activeTab();
    if (tab === 'accounts') renderAccounts(body);
    else if (tab === 'conversations') renderConversations(body);
    else renderSettings(body);
  }

  function renderAccounts(body) {
    const currentEmail = getCurrentEmail();
    const limitHit = isLimitReached();
    const nextAcc = limitHit ? nextFreshAccount(currentEmail) : null;

    let html = '';

    if (limitHit) {
      html += `<div class="csm-limit-banner">⚠ Usage limit reached!${nextAcc ? ` Swap to ${nextAcc}?` : ' No fresh accounts saved.'}</div>`;
    }

    const accounts = Object.entries(data.accounts);
    if (!accounts.length) {
      html += `<div class="csm-empty">No accounts registered yet.<br>Browse claude.ai while logged in to auto-register.</div>`;
    } else {
      html += `<div class="csm-section-title">Registered Accounts (${accounts.length})</div>`;
      html += accounts
        .sort(([, a], [, b]) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .map(([email, acc]) => {
          const isCurrent = email === currentEmail;
          const initial = (acc.label || email)[0].toUpperCase();
          const lastSeen = acc.lastSeen ? relTime(acc.lastSeen) : 'never';
          return `
            <div class="csm-account-row${isCurrent ? ' current' : ''}" data-email="${email}">
              <div class="csm-avatar">${initial}</div>
              <div class="csm-account-info">
                <div class="csm-account-email" title="${email}">${email}</div>
                <div class="csm-account-meta">Last seen ${lastSeen}</div>
              </div>
              ${!isCurrent ? `<button class="csm-swap-btn" data-swap="${email}">Swap</button>` : ''}
              ${isCurrent ? '<span style="font-size:11px;color:#a6e3a1">● Active</span>' : ''}
            </div>
          `;
        }).join('');

      if (nextAcc && limitHit) {
        html += `<button class="csm-btn-primary" id="csm-auto-swap-btn">⚡ Swap to ${nextAcc} now</button>`;
      }
    }

    html += `
      <div class="csm-section-title" style="margin-top:16px">Current Session</div>
      <div style="background:#313244;border-radius:8px;padding:10px;font-size:12px">
        <div>Active account: <strong>${currentEmail || '(unknown)'}</strong></div>
        <div style="margin-top:4px;color:#6c7086">Swap uses Google Account Chooser — no password needed if already signed in.</div>
      </div>
    `;

    body.innerHTML = html;

    // Bind swap buttons
    body.querySelectorAll('[data-swap]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        swapToAccount(btn.dataset.swap);
      });
    });

    const autoSwapBtn = body.querySelector('#csm-auto-swap-btn');
    if (autoSwapBtn) autoSwapBtn.addEventListener('click', () => swapToAccount(nextAcc));
  }

  function renderConversations(body) {
    const currentEmail = getCurrentEmail();
    const currentConvId = getConvIdFromUrl();
    const convs = Object.values(data.conversations);

    let html = `<input class="csm-search" id="csm-conv-search" placeholder="Search conversations…">`;

    if (!convs.length) {
      html += `<div class="csm-empty">No conversations tracked yet.<br>Open a chat to start tracking.</div>`;
      body.innerHTML = html;
      return;
    }

    const sorted = convs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    html += sorted.map(conv => {
      const isCurrent = conv.convId === currentConvId;
      const chainInfo = conv.parentConvId ? `↳ chains from ${conv.parentConvId.slice(0, 8)}…` : '';
      const childCount = conv.childConvIds?.length || 0;
      return `
        <div class="csm-conv-row${isCurrent ? ' current' : ''}" data-conv-id="${conv.convId}">
          <div class="csm-conv-title" title="${conv.title}">${conv.title || 'Untitled'}</div>
          <div class="csm-conv-meta">
            ${conv.accountEmail || '?'} · ${conv.model || '?'} · ${relTime(conv.updatedAt)}
            ${chainInfo ? `<br>${chainInfo}` : ''}
            ${childCount ? `<br>⛓ ${childCount} continuation(s)` : ''}
          </div>
          <div class="csm-conv-actions">
            <button class="csm-btn-sm" data-open="${conv.url}">Open</button>
            <button class="csm-btn-sm" data-chain-from="${conv.convId}">Chain from here</button>
            <button class="csm-btn-sm" data-delete-conv="${conv.convId}" style="color:#f38ba8">Del</button>
          </div>
          <div class="csm-chain-picker" id="chain-picker-${conv.convId}">
            <div style="font-size:11px;color:#6c7086;margin-bottom:4px">Mark current conversation as continuation of this one:</div>
            <button class="csm-btn-sm" style="width:100%" data-do-chain="${conv.convId}">
              Link current convo → this one
            </button>
          </div>
        </div>
      `;
    }).join('');

    body.innerHTML = html;

    // Search filter
    const search = body.querySelector('#csm-conv-search');
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      body.querySelectorAll('.csm-conv-row').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
      });
    });

    // Open buttons
    body.querySelectorAll('[data-open]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        window.location.href = btn.dataset.open;
      });
    });

    // Chain-from buttons toggle picker
    body.querySelectorAll('[data-chain-from]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const picker = document.getElementById(`chain-picker-${btn.dataset.chainFrom}`);
        if (picker) picker.classList.toggle('open');
      });
    });

    // Do-chain buttons
    body.querySelectorAll('[data-do-chain]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const parentId = btn.dataset.doChain;
        const currentId = getConvIdFromUrl();
        if (!currentId) { showToast('Open a conversation first'); return; }
        if (!data.conversations[currentId]) {
          data.conversations[currentId] = {
            convId: currentId,
            title: extractConvTitle(),
            url: window.location.href,
            accountEmail: currentEmail,
            updatedAt: Date.now(),
            parentConvId: null,
            childConvIds: [],
          };
        }
        data.conversations[currentId].parentConvId = parentId;
        if (!data.conversations[parentId].childConvIds) data.conversations[parentId].childConvIds = [];
        if (!data.conversations[parentId].childConvIds.includes(currentId)) {
          data.conversations[parentId].childConvIds.push(currentId);
        }
        saveLocal();
        showToast('Chained! 🔗');
        renderPanel();
      });
    });

    // Delete buttons
    body.querySelectorAll('[data-delete-conv]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm('Delete this conversation record?')) return;
        delete data.conversations[btn.dataset.deleteConv];
        saveLocal();
        renderPanel();
      });
    });
  }

  function renderSettings(body) {
    body.innerHTML = `
      <div class="csm-section-title">GitHub Gist Sync</div>
      <div class="csm-settings-row">
        <label>GitHub Personal Access Token (gist scope)</label>
        <input type="password" id="csm-gist-token" value="${data.settings.gistToken || ''}" placeholder="ghp_…">
      </div>
      <div class="csm-settings-row">
        <label>Gist ID (leave blank to auto-create)</label>
        <input type="text" id="csm-gist-id" value="${data.settings.gistId || ''}" placeholder="abc123…">
      </div>
      <div class="csm-settings-row">
        <label>
          <input type="checkbox" id="csm-auto-swap" ${data.settings.autoSwap ? 'checked' : ''}>
          Auto-swap to next account when limit is hit
        </label>
      </div>
      <button class="csm-btn-primary" id="csm-save-settings">Save Settings</button>
      <button class="csm-btn-primary" id="csm-push-gist" style="margin-top:8px;background:#1e6823">⬆ Push to Gist now</button>
      <button class="csm-btn-primary" id="csm-pull-gist" style="margin-top:8px;background:#0d3349">⬇ Pull from Gist now</button>

      <div class="csm-section-title" style="margin-top:20px">Danger Zone</div>
      <button class="csm-btn-primary" id="csm-clear-convs" style="background:#9b1c1c;margin-top:0">🗑 Clear all conversations</button>
      <button class="csm-btn-primary" id="csm-clear-all" style="background:#7c1d1d;margin-top:8px">💣 Reset everything</button>

      <div class="csm-section-title" style="margin-top:20px">Export</div>
      <button class="csm-btn-primary" id="csm-export" style="background:#2d2d5e">📋 Copy JSON to clipboard</button>
    `;

    body.querySelector('#csm-save-settings').addEventListener('click', () => {
      data.settings.gistToken = body.querySelector('#csm-gist-token').value.trim();
      data.settings.gistId = body.querySelector('#csm-gist-id').value.trim();
      data.settings.autoSwap = body.querySelector('#csm-auto-swap').checked;
      saveLocal();
      showToast('Settings saved');
    });

    body.querySelector('#csm-push-gist').addEventListener('click', async () => {
      dirty = true;
      await pushToGist();
      showToast(data.settings.gistId ? '✅ Pushed to Gist' : '❌ Set a token first');
    });

    body.querySelector('#csm-pull-gist').addEventListener('click', async () => {
      await pullFromGist();
      showToast('⬇ Pulled from Gist');
      renderPanel();
    });

    body.querySelector('#csm-clear-convs').addEventListener('click', () => {
      if (!confirm('Delete all conversation records?')) return;
      data.conversations = {};
      saveLocal();
      showToast('Conversations cleared');
    });

    body.querySelector('#csm-clear-all').addEventListener('click', () => {
      if (!confirm('Reset ALL data including accounts and settings?')) return;
      data = { accounts: {}, conversations: {}, settings: { gistToken: '', gistId: '', autoSwap: false } };
      saveLocal();
      showToast('Reset complete');
    });

    body.querySelector('#csm-export').addEventListener('click', () => {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => showToast('Copied!'));
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function getCurrentEmail() {
    const acc = detectAccount();
    return acc?.email || null;
  }

  function relTime(ts) {
    if (!ts) return 'unknown';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  // ─── Auto-swap watcher ────────────────────────────────────────────────────────
  let limitWatcherRunning = false;
  function startLimitWatcher() {
    if (limitWatcherRunning) return;
    limitWatcherRunning = true;
    setInterval(() => {
      if (!data.settings.autoSwap) return;
      if (!isLimitReached()) return;
      const currentEmail = getCurrentEmail();
      const next = nextFreshAccount(currentEmail);
      if (next) {
        console.log(`[CSM] Limit reached — auto-swapping to ${next}`);
        swapToAccount(next);
      }
    }, 5_000);
  }

  // ─── Mutation observer for title/model changes ────────────────────────────────
  function watchPageChanges(accountEmail) {
    let lastUrl = window.location.href;
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setTimeout(() => {
          registerCurrentConversation(accountEmail);
          if (document.getElementById(PANEL_ID)?.classList.contains('open')) renderPanel();
        }, 1500);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    loadLocal();
    buildPanel();

    const account = await fetchAccountFromAPI();
    const accountEmail = registerCurrentAccount(account);
    registerCurrentConversation(accountEmail);
    startLimitWatcher();
    watchPageChanges(accountEmail);

    setInterval(pushToGist, SYNC_INTERVAL_MS);
    if (data.settings.gistToken && data.settings.gistId) {
      pullFromGist().then(() => {
        registerCurrentConversation(accountEmail);
      });
    }

    console.log('[CSM] Claude Session Manager initialized — account:', accountEmail || 'unknown');
  }

  // Wait for page to be interactive
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Give React a moment to hydrate
    setTimeout(init, 2000);
  }
})();