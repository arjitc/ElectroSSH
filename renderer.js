// renderer.js (updated)
// Full renderer file — replaces existing renderer.js
window.onload = function() {
  let sessions = {}; // { sessionId: { term, fitAddon, container, title, bannerEl, tabEl, config } }
  let activeSessionId = null;
  let allHosts = [];
  let groups = [];
  let activeGroupFilter = 'all';
  let sshKeys = [];
  let defaultKeyId = null;
  let defaultSSHDir = '';
  let selectedHostId = null;

  // Seconds between SSH keepalive packets; 0 disables them. Mirrors main.js.
  const DEFAULT_KEEPALIVE = 5;
  const MAX_KEEPALIVE = 3600;

  // -------------------------
  // Sidebar tree state (persisted locally)
  // -------------------------
  const COLLAPSED_KEY = 'electrossh.collapsedGroups';
  const SIDEBAR_WIDTH_KEY = 'electrossh.sidebarWidth';

  let collapsedGroups = new Set();
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    if (Array.isArray(stored)) collapsedGroups = new Set(stored);
  } catch (e) {
    collapsedGroups = new Set();
  }

  function persistCollapsedGroups() {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(collapsedGroups)));
    } catch (e) {
      // storage unavailable — collapse state simply won't survive a restart
    }
  }

  // Inline SVG icons used across the sidebar
  const ICONS = {
    chevron: '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5 10.5 8l-5 4.5"/></svg>',
    folder: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 12.5v-8a1 1 0 0 1 1-1h3l1.4 1.6h5a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-9.4a1 1 0 0 1-1-1Z"/></svg>',
    play: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5 12 8l-7 4.5z"/></svg>',
    pencil: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.6 13.4 4.8 5.6 12.6 2.6 13.4l.8-3z"/></svg>'
  };

  // Terminal palette, tuned to match the app chrome
  const TERMINAL_THEME = {
    background: '#0f1216',
    foreground: '#d7dee6',
    cursor: '#4c8dff',
    cursorAccent: '#0f1216',
    selectionBackground: 'rgba(76, 141, 255, 0.30)',
    black: '#3b4048',
    red: '#f85149',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#4c8dff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#c6cdd5',
    brightBlack: '#6c7783',
    brightRed: '#ff7b72',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79b8ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  };

  // Mirrors the main-process helper so stored/legacy values display sensibly
  function normalizeKeepalive(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_KEEPALIVE;
    if (String(value).trim() === '') return DEFAULT_KEEPALIVE;
    const seconds = Math.floor(Number(value));
    if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_KEEPALIVE;
    return Math.min(seconds, MAX_KEEPALIVE);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // -------------------------
  // Utility clipboard helpers (use electronAPI if provided, otherwise navigator.clipboard)
  // -------------------------
  async function readClipboardText() {
    // prefer electronAPI if available
    try {
      if (window.electronAPI && typeof window.electronAPI.readClipboard === 'function') {
        return await window.electronAPI.readClipboard();
      }
    } catch (e) {
      console.warn('electronAPI.readClipboard failed, falling back to navigator.clipboard', e);
    }

    // fallback to navigator.clipboard
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        return await navigator.clipboard.readText();
      }
    } catch (e) {
      console.warn('navigator.clipboard.readText failed or not permitted', e);
    }

    return '';
  }

  async function writeClipboardText(text) {
    try {
      if (window.electronAPI && typeof window.electronAPI.writeClipboard === 'function') {
        return await window.electronAPI.writeClipboard(text);
      }
    } catch (e) {
      console.warn('electronAPI.writeClipboard failed, falling back to navigator.clipboard', e);
    }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return await navigator.clipboard.writeText(text);
      }
    } catch (e) {
      console.warn('navigator.clipboard.writeText failed or not permitted', e);
    }

    // nothing worked
    return;
  }

  const IS_MAC = /Mac/i.test(navigator.userAgent);

  // Send the clipboard to the remote shell as if it had been typed.
  async function pasteIntoSession(sessionId, term) {
    try {
      const pasteText = await readClipboardText();
      if (!pasteText) return;

      // Convert newlines to '\r' so the backend receives Enter-like input as if typed
      const normalized = pasteText.replace(/\r\n|\r|\n/g, '\r');

      // Send to backend in chunks so large pastes don't overload buffers
      const CHUNK = 2048;
      for (let i = 0; i < normalized.length; i += CHUNK) {
        window.electronAPI.sendInput({ sessionId, data: normalized.slice(i, i + CHUNK) });
      }

      // Focus the terminal so subsequent keys go to it
      term.focus();
    } catch (err) {
      console.error("Failed to read/paste clipboard:", err);
    }
  }

  // -------------------------
  // SSH Key helpers & Settings panel
  // -------------------------
  function getKeyById(id) {
    if (!id) return null;
    return sshKeys.find((k) => k.id === id) || null;
  }

  function renderKeySelectors() {
    const selects = [document.getElementById('inp-key-select'), document.getElementById('save-key')];
    selects.forEach((sel) => {
      if (!sel) return;
      const previous = sel.value;
      sel.innerHTML = '';

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = sshKeys.length ? 'Select a key' : 'No keys available';
      sel.appendChild(placeholder);

      sshKeys.forEach((key) => {
        const opt = document.createElement('option');
        opt.value = key.id;
        const isDefault = key.id === defaultKeyId;
        opt.textContent = isDefault ? `${key.name} (default)` : key.name;
        sel.appendChild(opt);
      });

      if (Array.from(sel.options).some((o) => o.value === previous)) {
        sel.value = previous;
      } else if (defaultKeyId && Array.from(sel.options).some((o) => o.value === defaultKeyId)) {
        sel.value = defaultKeyId;
      }
    });
  }

  function renderKeyList() {
    const list = document.getElementById('key-list');
    if (!list) return;

    if (sshKeys.length === 0) {
      list.innerHTML = '<div class="empty-note">No keys found. Add or generate one to get started.</div>';
      return;
    }

    list.innerHTML = '';
    sshKeys.forEach((key) => {
      const card = document.createElement('div');
      card.className = 'key-card';

      const body = document.createElement('div');
      body.className = 'key-body';

      const header = document.createElement('div');
      header.className = 'key-title';
      const title = document.createElement('span');
      title.textContent = key.name;
      header.appendChild(title);

      const badge = document.createElement('span');
      badge.className = key.id === defaultKeyId ? 'badge accent' : 'badge';
      badge.textContent = key.id === defaultKeyId ? 'Default' : (key.discovered ? 'Detected' : 'Saved');
      header.appendChild(badge);
      body.appendChild(header);

      const pathRow = document.createElement('div');
      pathRow.className = 'key-path';
      pathRow.textContent = key.privateKeyPath;
      body.appendChild(pathRow);

      card.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'key-actions';

      const label = document.createElement('label');
      label.className = 'default-toggle';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'default-key';
      radio.value = key.id;
      radio.checked = key.id === defaultKeyId;
      radio.onchange = async () => {
        await window.electronAPI.setDefaultSSHKey(key.id);
        await loadSSHKeys();
      };
      label.appendChild(radio);
      label.appendChild(document.createTextNode('Default'));
      actions.appendChild(label);

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Remove';
      deleteBtn.className = 'btn btn-danger';
      deleteBtn.title = 'Remove from the app (file on disk stays untouched).';
      deleteBtn.onclick = async () => {
        const confirmed = window.confirm(
          `Remove ${key.name} from ElectroSSH? This will not delete the file on disk.`
        );
        if (!confirmed) return;
        await window.electronAPI.deleteSSHKey(key.id);
        await loadSSHKeys();
      };
      actions.appendChild(deleteBtn);

      card.appendChild(actions);

      list.appendChild(card);
    });
  }

  async function loadSSHKeys() {
    try {
      const result = await window.electronAPI.listSSHKeys();
      sshKeys = result.keys || [];
      defaultKeyId = result.defaultKeyId || null;
      defaultSSHDir = result.defaultSSHDir || defaultSSHDir;
      renderKeySelectors();
      renderKeyList();

      const directoryInput = document.getElementById('new-key-directory');
      if (directoryInput && !directoryInput.value && defaultSSHDir) {
        directoryInput.value = defaultSSHDir;
      }

      updateGenerateKeyNote();
    } catch (err) {
      console.error('Failed to load SSH keys', err);
    }
  }

  function ensureSettingsTab() {
    const slot = document.getElementById('settings-tab-slot');
    let tab = document.getElementById('tab-settings');

    if (!tab) {
      tab = document.createElement('div');
      tab.className = 'tab';
      tab.id = 'tab-settings';
      tab.innerHTML = `<span class="tab-label">Settings</span><span class="close-tab" title="Close">&times;</span>`;
      tab.onclick = (e) => {
        if (e.target.closest('.close-tab')) {
          closeSettingsTab();
        } else {
          switchTab('settings');
        }
      };
      // Sits on the right hand side of the tab bar
      slot.appendChild(tab);
    }

    return tab;
  }

  function openSettingsTab() {
    ensureSettingsTab();
    switchTab('settings');
  }

  function closeSettingsTab() {
    const tab = document.getElementById('tab-settings');
    const view = document.getElementById('settings-view');
    if (tab) tab.remove();
    if (view) view.classList.remove('visible');

    const remainingIds = Object.keys(sessions);
    if (remainingIds.length > 0) {
      switchTab(remainingIds[remainingIds.length - 1]);
    } else {
      activeSessionId = null;
      document.getElementById('connect-form').classList.remove('hidden');
    }
  }

  // -------------------------
  // Banner helpers (inline banner; normal flow)
  // -------------------------
  function createBanner(sessionId) {
    const s = sessions[sessionId];
    if (!s) return null;
    if (s.bannerEl) return s.bannerEl;

    const banner = document.createElement('div');
    banner.className = 'term-banner inline';

    const msgSpan = document.createElement('span');
    msgSpan.className = 'term-banner-msg';
    banner.appendChild(msgSpan);

    const btns = document.createElement('span');
    btns.className = 'term-banner-btns';

    const reconnectBtn = document.createElement('button');
    reconnectBtn.className = 'term-banner-reconnect';
    reconnectBtn.type = 'button';
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.onclick = async (ev) => {
      ev.stopPropagation();
      reconnectBtn.disabled = true;
      reconnectBtn.textContent = 'Reconnecting…';
      const session = sessions[sessionId];
      if (!session || !session.config) {
        msgSpan.textContent = 'No saved connection details for this session';
        setTimeout(() => {
          reconnectBtn.disabled = false;
          reconnectBtn.textContent = 'Reconnect';
        }, 1200);
        return;
      }
      const size = { cols: session.term.cols, rows: session.term.rows };
      try {
        window.electronAPI.connectSSH({ sessionId, config: session.config, size });
        msgSpan.textContent = 'Attempting to reconnect…';
      } catch (err) {
        console.error('reconnect failed', err);
        msgSpan.textContent = `Reconnect failed: ${err.message || err}`;
        reconnectBtn.disabled = false;
        reconnectBtn.textContent = 'Reconnect';
      }
    };
    btns.appendChild(reconnectBtn);

    // The banner only ever appears once the session is dead, so the two useful
    // actions are reconnecting and closing the tab outright.
    const closeBtn = document.createElement('button');
    closeBtn.className = 'term-banner-dismiss';
    closeBtn.type = 'button';
    closeBtn.title = 'Close tab';
    closeBtn.setAttribute('aria-label', 'Close tab');
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = (ev) => { ev.stopPropagation(); closeSession(sessionId); };
    btns.appendChild(closeBtn);

    banner.appendChild(btns);

    s.bannerEl = banner;
    s.bannerMsgEl = msgSpan;
    s.bannerReconnectBtn = reconnectBtn;
    s.bannerCloseBtn = closeBtn;

    // Insert banner as first child in normal flow (before xterm DOM) so it pushes content down
    s.container.insertBefore(banner, s.container.firstChild);

    return banner;
  }

  function showBannerForSession(sessionId, message, type = 'error') {
    const s = sessions[sessionId];
    if (!s) return;
    const banner = createBanner(sessionId);
    if (!banner) return;

    banner.dataset.type = type;
    s.bannerMsgEl.textContent = message || '';
    banner.classList.add('visible');

    // enable/disable reconnect based on stored config
    if (!s.config) {
      s.bannerReconnectBtn.disabled = true;
      s.bannerReconnectBtn.title = 'No saved connection details';
    } else {
      s.bannerReconnectBtn.disabled = false;
      s.bannerReconnectBtn.textContent = 'Reconnect';
    }

    // re-fit after banner added so xterm knows its new height
    setTimeout(() => { try { s.fitAddon.fit(); } catch (e) {} }, 20);
  }

  function hideBannerForSession(sessionId) {
    const s = sessions[sessionId];
    if (!s || !s.bannerEl) return;
    s.bannerEl.classList.remove('visible');

    // re-fit so the terminal recalculates height now banner hidden
    setTimeout(() => { try { s.fitAddon.fit(); } catch (e) {} }, 20);
  }

  // -------------------------
  // Modal Helpers (Host Management)
  // -------------------------
  const modal = document.getElementById('save-host-modal');
  const groupModal = document.getElementById('group-modal');
  const groupNameInput = document.getElementById('group-name-input');
  const groupErrorEl = document.getElementById('group-error');

  // Show only the credential field that matches the chosen auth method
  function updateHostModalAuthUI() {
    const method = document.getElementById('save-auth').value;
    document.getElementById('save-pass-wrapper').classList.toggle('hidden', method === 'key');
    document.getElementById('save-key-wrapper').classList.toggle('hidden', method !== 'key');
  }

  function resetSaveModal(presetGroupId) {
    document.getElementById('modal-title').textContent = 'Add Host';
    document.getElementById('host-id').value = '';
    document.getElementById('save-name').value = '';
    document.getElementById('save-host').value = '';
    document.getElementById('save-port').value = 22;
    document.getElementById('save-user').value = '';
    document.getElementById('save-pass').value = '';
    const fallbackGroup = activeGroupFilter !== 'all' ? activeGroupFilter : getDefaultGroupId();
    document.getElementById('save-group').value = presetGroupId || fallbackGroup;
    document.getElementById('save-auth').value = 'password';
    document.getElementById('save-key').value = '';
    document.getElementById('save-keepalive').value = DEFAULT_KEEPALIVE;
    document.getElementById('host-error').textContent = '';
    document.getElementById('btn-save-confirm').textContent = 'Save';
    document.getElementById('btn-delete-host').classList.add('hidden');
    document.getElementById('btn-delete-host').disabled = false;
    document.getElementById('btn-delete-host').textContent = 'Delete';
    updateHostModalAuthUI();
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('save-name').focus(), 0);
  }

  function openGroupModal() {
    if (!groupModal) return;
    groupNameInput.value = '';
    groupErrorEl.textContent = '';
    groupModal.classList.remove('hidden');
    setTimeout(() => groupNameInput.focus(), 0);
  }

  function closeGroupModal() {
    if (!groupModal) return;
    groupModal.classList.add('hidden');
    groupErrorEl.textContent = '';
  }

  function openEditHostModal(host) {
    renderKeySelectors();
    document.getElementById('modal-title').textContent = 'Edit Host';
    document.getElementById('host-error').textContent = '';
    document.getElementById('host-id').value = host.id;
    document.getElementById('save-name').value = host.name;
    document.getElementById('save-host').value = host.host;
    document.getElementById('save-port').value = host.port || 22;
    document.getElementById('save-user').value = host.username;
    document.getElementById('save-pass').value = host.password || '';
    document.getElementById('save-group').value = host.groupId || getDefaultGroupId();
    document.getElementById('save-auth').value = host.authType || (host.keyId ? 'key' : 'password');
    document.getElementById('save-key').value = host.keyId || '';
    document.getElementById('save-keepalive').value = normalizeKeepalive(host.keepalive);
    document.getElementById('btn-save-confirm').textContent = 'Save';
    document.getElementById('btn-delete-host').classList.remove('hidden');
    document.getElementById('btn-delete-host').disabled = false;
    document.getElementById('btn-delete-host').textContent = 'Delete';
    updateHostModalAuthUI();
    modal.classList.remove('hidden');
  }

  // -------------------------
  // Group Helpers
  // -------------------------
  function getDefaultGroupId() {
    return groups[0]?.id || 'default';
  }

  function getGroupName(groupId) {
    const found = groups.find(g => g.id === groupId);
    return found ? found.name : 'Unknown';
  }

  function refreshGroupSelectors() {
    const filterEl = document.getElementById('group-filter');
    const modalGroupEl = document.getElementById('save-group');

    if (filterEl) {
      const previous = filterEl.value || activeGroupFilter;
      filterEl.innerHTML = '';

      const allOption = document.createElement('option');
      allOption.value = 'all';
      allOption.textContent = 'All Groups';
      filterEl.appendChild(allOption);

      groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        filterEl.appendChild(opt);
      });

      const validValue = Array.from(filterEl.options).some(o => o.value === previous) ? previous : 'all';
      filterEl.value = validValue;
      activeGroupFilter = validValue;
    }

    if (modalGroupEl) {
      const previous = modalGroupEl.value;
      modalGroupEl.innerHTML = '';
      groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        modalGroupEl.appendChild(opt);
      });

      const preferred = activeGroupFilter !== 'all' ? activeGroupFilter : previous || getDefaultGroupId();
      const fallback = groups.find(g => g.id === preferred)?.id || getDefaultGroupId();
      modalGroupEl.value = fallback;
    }
  }

  async function handleCreateGroup() {
    if (!groupNameInput) return;
    const proposed = groupNameInput.value.trim();

    if (!proposed) {
      groupErrorEl.textContent = 'Please enter a group name.';
      groupNameInput.focus();
      return;
    }

    const exists = groups.some(g => g.name.toLowerCase() === proposed.toLowerCase());
    if (exists) {
      groupErrorEl.textContent = 'A group with this name already exists.';
      groupNameInput.focus();
      return;
    }

    const store = await window.electronAPI.saveGroup(proposed);
    groups = store.groups || groups;
    refreshGroupSelectors();

    const newGroup = groups.find(g => g.name.toLowerCase() === proposed.toLowerCase());
    if (newGroup) {
      const filterEl = document.getElementById('group-filter');
      if (filterEl) {
        filterEl.value = newGroup.id;
        activeGroupFilter = newGroup.id;
      }
    }

    closeGroupModal();
    loadHosts(document.getElementById('search-input').value);
  }

  // -------------------------
  // Hosts loading UI
  // -------------------------
  // -------------------------
  // Sidebar host tree
  // -------------------------

  // Hosts that currently have an open session, so the tree can show a live dot
  function connectedHostIds() {
    const ids = new Set();
    Object.values(sessions).forEach((s) => {
      if (s && s.hostId) ids.add(s.hostId);
    });
    return ids;
  }

  function refreshHostConnectionDots() {
    const connected = connectedHostIds();
    document.querySelectorAll('#saved-hosts-list .tree-host').forEach((el) => {
      el.classList.toggle('connected', connected.has(el.dataset.hostId));
    });
  }

  function isGroupCollapsed(groupId) {
    return collapsedGroups.has(groupId);
  }

  function setGroupCollapsed(groupId, collapsed) {
    if (collapsed) collapsedGroups.add(groupId);
    else collapsedGroups.delete(groupId);
    persistCollapsedGroups();
    updateToggleAllButton();
  }

  function updateToggleAllButton() {
    const btn = document.getElementById('toggle-all-groups-btn');
    if (!btn) return;
    const headers = document.querySelectorAll('#saved-hosts-list .tree-group');
    const anyExpanded = Array.from(headers).some((el) => !el.classList.contains('collapsed'));
    btn.dataset.action = anyExpanded ? 'collapse' : 'expand';
    btn.title = anyExpanded ? 'Collapse all groups' : 'Expand all groups';
    btn.setAttribute('aria-label', btn.title);
  }

  // Move focus between the visible rows of the tree with the arrow keys
  function focusableTreeRows() {
    return Array.from(
      document.querySelectorAll('#saved-hosts-list .tree-group-header, #saved-hosts-list .tree-group:not(.collapsed) .tree-host')
    );
  }

  function moveTreeFocus(current, delta) {
    const rows = focusableTreeRows();
    const index = rows.indexOf(current);
    if (index === -1) return;
    const next = rows[index + delta];
    if (next) next.focus();
  }

  function selectHostRow(el) {
    selectedHostId = el.dataset.hostId;
    document.querySelectorAll('#saved-hosts-list .tree-host.selected')
      .forEach((node) => node.classList.remove('selected'));
    el.classList.add('selected');
  }

  function buildHostRow(host, connected) {
    const key = getKeyById(host.keyId);
    const usesKey = host.authType === 'key' || (host.keyId && host.authType !== 'password');
    const authLabel = usesKey ? (key ? `key: ${key.name}` : 'key') : 'password';
    // Only worth showing when it differs from the default
    const keepalive = normalizeKeepalive(host.keepalive);
    const keepaliveLabel = keepalive === DEFAULT_KEEPALIVE
      ? ''
      : ` &middot; <span class="key-chip">${keepalive === 0 ? 'no keep-alive' : `keep-alive ${keepalive}s`}</span>`;

    const el = document.createElement('div');
    el.className = 'tree-host';
    el.dataset.hostId = host.id;
    el.setAttribute('role', 'treeitem');
    el.tabIndex = -1;
    el.title = `${host.username}@${host.host}:${host.port || 22}\nKeep-alive: ${keepalive === 0 ? 'disabled' : `${keepalive}s`}`;
    if (connected.has(host.id)) el.classList.add('connected');
    if (host.id === selectedHostId) el.classList.add('selected');

    el.innerHTML = `
      <span class="status-dot"></span>
      <div class="host-text">
        <div class="host-name">${escapeHtml(host.name)}</div>
        <div class="host-meta">${escapeHtml(host.username)}@${escapeHtml(host.host)}:${escapeHtml(host.port || 22)} &middot; <span class="key-chip">${escapeHtml(authLabel)}</span>${keepaliveLabel}</div>
      </div>
      <div class="host-actions">
        <button class="connect-host-btn" title="Connect" aria-label="Connect">${ICONS.play}</button>
        <button class="edit-host-btn" title="Edit host" aria-label="Edit host">${ICONS.pencil}</button>
      </div>
    `;

    el.addEventListener('click', () => selectHostRow(el));
    el.addEventListener('dblclick', () => {
      createSession(buildConfigFromHost(host), host.name, host.id);
    });

    el.querySelector('.connect-host-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      selectHostRow(el);
      createSession(buildConfigFromHost(host), host.name, host.id);
    });

    el.querySelector('.edit-host-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditHostModal(host);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createSession(buildConfigFromHost(host), host.name, host.id);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveTreeFocus(el, 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveTreeFocus(el, -1);
      }
    });

    return el;
  }

  function buildGroupSection(group, hosts, connected, forceExpanded) {
    const collapsed = forceExpanded ? false : isGroupCollapsed(group.id);

    const section = document.createElement('div');
    section.className = collapsed ? 'tree-group collapsed' : 'tree-group';
    section.dataset.groupId = group.id;

    const header = document.createElement('div');
    header.className = 'tree-group-header';
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-expanded', String(!collapsed));
    header.tabIndex = -1;
    header.innerHTML = `
      <span class="twisty">${ICONS.chevron}</span>
      <span class="group-icon">${ICONS.folder}</span>
      <span class="group-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
      <span class="group-count">${hosts.length}</span>
    `;

    const toggle = () => {
      const nowCollapsed = !section.classList.contains('collapsed');
      section.classList.toggle('collapsed', nowCollapsed);
      header.setAttribute('aria-expanded', String(!nowCollapsed));
      setGroupCollapsed(group.id, nowCollapsed);
    };

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowRight' && section.classList.contains('collapsed')) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowLeft' && !section.classList.contains('collapsed')) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveTreeFocus(header, 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveTreeFocus(header, -1);
      }
    });

    section.appendChild(header);

    const children = document.createElement('div');
    children.className = 'tree-children';
    const inner = document.createElement('div');
    inner.className = 'tree-children-inner';
    inner.setAttribute('role', 'group');

    if (hosts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'group-empty';
      empty.textContent = 'No hosts yet';
      inner.appendChild(empty);
    } else {
      hosts.forEach((host) => inner.appendChild(buildHostRow(host, connected)));
    }

    children.appendChild(inner);
    section.appendChild(children);
    return section;
  }

  async function loadHosts(filter = '') {
    const { hosts = [], groups: storedGroups = [] } = await window.electronAPI.getHosts();
    allHosts = hosts;
    groups = storedGroups;
    refreshGroupSelectors();

    const container = document.getElementById('saved-hosts-list');
    container.innerHTML = '';

    const selectedGroupId = document.getElementById('group-filter')?.value || activeGroupFilter;
    const lowerFilter = filter.toLowerCase().trim();
    const searching = lowerFilter.length > 0;

    const filteredHosts = allHosts.filter(host => {
      const matchesGroup = selectedGroupId === 'all' || host.groupId === selectedGroupId;
      if (!searching) return matchesGroup;
      const matchesSearch = (
        (host.name || '').toLowerCase().includes(lowerFilter) ||
        (host.host || '').toLowerCase().includes(lowerFilter) ||
        (host.username || '').toLowerCase().includes(lowerFilter)
      );
      return matchesGroup && matchesSearch;
    });

    const countLabel = document.getElementById('host-count-label');
    if (countLabel) {
      const total = allHosts.length;
      countLabel.textContent = searching || selectedGroupId !== 'all'
        ? `${filteredHosts.length} of ${total}`
        : `${total} host${total === 1 ? '' : 's'}`;
    }

    if (allHosts.length === 0) {
      container.innerHTML = '<div class="tree-empty"><strong>No saved hosts yet</strong>Use the + button above to add your first host.</div>';
      updateToggleAllButton();
      return;
    }

    if (filteredHosts.length === 0) {
      container.innerHTML = '<div class="tree-empty"><strong>No matches</strong>Try a different search or group.</div>';
      updateToggleAllButton();
      return;
    }

    const hostsByGroup = new Map();
    filteredHosts.forEach(host => {
      const gid = host.groupId || getDefaultGroupId();
      if (!hostsByGroup.has(gid)) hostsByGroup.set(gid, []);
      hostsByGroup.get(gid).push(host);
    });
    hostsByGroup.forEach(list => list.sort((a, b) => (a.name || '').localeCompare(b.name || '')));

    // Which groups get a row: every known group when browsing, only the
    // groups holding a match while searching or filtering.
    const groupsToRender = [];
    const pushGroup = (g) => {
      if (!groupsToRender.some(existing => existing.id === g.id)) groupsToRender.push(g);
    };

    if (selectedGroupId === 'all') {
      groups.forEach(g => {
        if (!searching || hostsByGroup.has(g.id)) pushGroup(g);
      });
    } else {
      const matched = groups.find(g => g.id === selectedGroupId);
      if (matched) pushGroup(matched);
    }

    // Safety net for hosts pointing at a group that is no longer stored
    hostsByGroup.forEach((_, gid) => pushGroup({ id: gid, name: getGroupName(gid) }));

    const connected = connectedHostIds();
    groupsToRender.forEach(group => {
      const groupHosts = hostsByGroup.get(group.id) || [];
      // While searching, always reveal the groups that contain a hit
      container.appendChild(buildGroupSection(group, groupHosts, connected, searching));
    });

    updateToggleAllButton();
  }


  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');

  function syncClearSearchBtn() {
    clearSearchBtn.classList.toggle('visible', searchInput.value.length > 0);
  }

  searchInput.addEventListener('input', (e) => {
    syncClearSearchBtn();
    loadHosts(e.target.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.preventDefault();
      searchInput.value = '';
      syncClearSearchBtn();
      loadHosts();
    }
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    syncClearSearchBtn();
    loadHosts();
    searchInput.focus();
  });

  document.getElementById('group-filter').addEventListener('change', (e) => {
    activeGroupFilter = e.target.value;
    loadHosts(searchInput.value);
  });

  // Collapse / expand every group at once
  document.getElementById('toggle-all-groups-btn').addEventListener('click', (e) => {
    const collapse = e.currentTarget.dataset.action !== 'expand';
    document.querySelectorAll('#saved-hosts-list .tree-group').forEach((section) => {
      section.classList.toggle('collapsed', collapse);
      const header = section.querySelector('.tree-group-header');
      if (header) header.setAttribute('aria-expanded', String(!collapse));
      if (collapse) collapsedGroups.add(section.dataset.groupId);
      else collapsedGroups.delete(section.dataset.groupId);
    });
    persistCollapsedGroups();
    updateToggleAllButton();
  });

  document.getElementById('add-group-btn').addEventListener('click', openGroupModal);

  document.getElementById('open-settings-btn').addEventListener('click', () => openSettingsTab());

  document.getElementById('save-auth').addEventListener('change', updateHostModalAuthUI);

  document.getElementById('btn-group-cancel').addEventListener('click', closeGroupModal);
  document.getElementById('btn-group-confirm').addEventListener('click', handleCreateGroup);
  groupNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateGroup();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGroupModal();
    }
  });

  // Open Add Host modal
  document.getElementById('add-host-btn').onclick = () => { renderKeySelectors(); resetSaveModal(); };

  // Close modal
  document.getElementById('btn-save-cancel').onclick = () => { modal.classList.add('hidden'); };

  // Save/Update Host logic
  document.getElementById('btn-save-confirm').onclick = async () => {
    const hostId = document.getElementById('host-id').value;
    const errorEl = document.getElementById('host-error');

    // A number input hands back '' for anything unparseable, so an empty
    // box simply means "use the default"; negatives and decimals are rejected.
    const keepaliveRaw = document.getElementById('save-keepalive').value.trim();
    let keepalive = DEFAULT_KEEPALIVE;
    if (keepaliveRaw !== '') {
      const parsed = Number(keepaliveRaw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_KEEPALIVE) {
        errorEl.textContent = `Keep-alive must be a whole number of seconds from 0 to ${MAX_KEEPALIVE} (0 disables it).`;
        return;
      }
      keepalive = parsed;
    }

    const hostData = {
      id: hostId || null,
      name: document.getElementById('save-name').value,
      host: document.getElementById('save-host').value,
      port: document.getElementById('save-port').value,
      username: document.getElementById('save-user').value,
      password: document.getElementById('save-pass').value,
      groupId: document.getElementById('save-group').value,
      authType: document.getElementById('save-auth').value,
      keyId: document.getElementById('save-key').value || null,
      keepalive,
    };

    if (!hostData.name || !hostData.host || !hostData.username) {
      errorEl.textContent = 'Display name, host and username are required.';
      return;
    }

    errorEl.textContent = '';
    await window.electronAPI.saveHost(hostData);
    modal.classList.add('hidden');
    // A newly saved host should be visible, so make sure its group is open
    collapsedGroups.delete(hostData.groupId);
    persistCollapsedGroups();
    loadHosts(document.getElementById('search-input').value);
  };

  // Delete Host logic
  document.getElementById('btn-delete-host').onclick = async () => {
    const hostId = document.getElementById('host-id').value;
    const hostName = document.getElementById('save-name').value;

    if (!hostId) {
      console.error("Cannot delete host without an ID.");
      return;
    }

    const confirmed = window.confirm(`Delete "${hostName}"? This cannot be undone.`);
    if (!confirmed) return;

    try {
      const deleteBtn = document.getElementById('btn-delete-host');
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';

      await window.electronAPI.deleteHost(hostId);
      console.log(`Host '${hostName}' (ID: ${hostId}) deleted.`);
      if (selectedHostId === hostId) selectedHostId = null;
      modal.classList.add('hidden');
      loadHosts(document.getElementById('search-input').value);
    } catch (error) {
      console.error("Error deleting host:", error);
      const deleteBtn = document.getElementById('btn-delete-host');
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete Host';
    }
  };

  function buildConfigFromHost(host) {
    if (!host) return null;
    const baseConfig = {
      host: host.host,
      port: host.port || 22,
      username: host.username,
      password: host.password || '',
      keepalive: normalizeKeepalive(host.keepalive)
    };

    const selectedKey = host.keyId ? getKeyById(host.keyId) : getKeyById(defaultKeyId);
    const shouldUseKey = host.authType === 'key' || (!!selectedKey && host.authType !== 'password');
    if (shouldUseKey && selectedKey) {
      baseConfig.authType = 'key';
      baseConfig.keyId = selectedKey.id;
      baseConfig.privateKeyPath = selectedKey.privateKeyPath;
      baseConfig.passphrase = host.passphrase || '';
      baseConfig.password = null;
    } else {
      baseConfig.authType = 'password';
    }

    return baseConfig;
  }

  // -------------------------
  // Create Session (term + banner + handlers)
  // -------------------------
  function createSession(config = null, title = "New Connection", hostId = null) {
    const sessionId = Date.now().toString();

    // Container & banner
    const termWrapper = document.getElementById('terminals-wrapper');
    const termContainer = document.createElement('div');
    termContainer.className = 'terminal-instance active';
    termContainer.id = `term-${sessionId}`;

    // xterm lives in its own child so the banner can sit above it in flow
    const termHost = document.createElement('div');
    termHost.className = 'terminal-host';
    termContainer.appendChild(termHost);

    // append container (banner will be inserted by createBanner)
    termWrapper.appendChild(termContainer);

    // Initialize Xterm
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      drawBoldTextInBrightColors: false,
      macOptionIsMeta: true,
      theme: TERMINAL_THEME
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termHost);

    // The WebGL renderer is much faster, but its context can be lost (GPU
    // reset, driver update). When that happens we drop it and let xterm fall
    // back to the DOM renderer instead of leaving a blank terminal behind.
    let webglAddon = null;
    try {
      webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => {
        console.warn('WebGL context lost, falling back to the DOM renderer');
        try { webglAddon.dispose(); } catch (e) { /* already gone */ }
        const session = sessions[sessionId];
        if (session) session.webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn("WebGL addon failed to load, falling back to canvas", e);
      webglAddon = null;
    }

    // Save session (with bannerEl placeholder)
    sessions[sessionId] = {
      term, fitAddon, webglAddon, container: termContainer, termHost, title,
      bannerEl: null, tabEl: null, config: config || null, hostId
    };

    // --- Clipboard Copy (Left-Click Selection) ---
    // onSelectionChange fires continuously while dragging, so settle first and
    // write the clipboard once the selection stops changing.
    let selectionTimer = null;
    term.onSelectionChange(() => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        try {
          const selection = term.getSelection();
          if (selection && selection.length > 0) {
            writeClipboardText(selection).catch(err => {
              // swallow - user may not permit clipboard write in some contexts
              console.warn('Failed to write selection to clipboard:', err);
            });
          }
        } catch (e) {
          console.warn('Selection copy failed:', e);
        }
      }, 120);
    });

    // --- Ctrl+Shift+C / Ctrl+Shift+V (Cmd+C / Cmd+V on macOS) ---
    // Plain Ctrl+C must stay SIGINT, so only the shifted pair is intercepted.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      const key = (e.key || '').toLowerCase();
      const shortcut = IS_MAC
        ? (e.metaKey && !e.ctrlKey && !e.altKey)
        : (e.ctrlKey && e.shiftKey && !e.altKey);
      if (!shortcut) return true;

      if (key === 'c') {
        const selection = term.getSelection();
        if (!selection) return true;
        writeClipboardText(selection).catch(() => {});
        return false;
      }

      if (key === 'v') {
        pasteIntoSession(sessionId, term);
        return false;
      }

      return true;
    });

    // --- Right-click paste ---
    termContainer.addEventListener('contextmenu', (e) => {
      if (activeSessionId !== sessionId) return;
      e.preventDefault();
      e.stopPropagation();
      pasteIntoSession(sessionId, term);
    });

    // Create Tab UI
    const tabsStrip = document.getElementById('tabs-strip');
    const tabEl = document.createElement('div');
    tabEl.className = 'tab active';
    tabEl.id = `tab-${sessionId}`;
    tabEl.title = title;
    tabEl.innerHTML = `<span class="tab-dot"></span><span class="tab-label">${escapeHtml(title)}</span><span class="close-tab" title="Close">&times;</span>`;

    tabEl.onclick = (e) => {
      if (e.target.closest('.close-tab')) closeSession(sessionId);
      else switchTab(sessionId);
    };
    // Middle-click closes the tab, as in a browser
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeSession(sessionId);
      }
    });
    tabsStrip.appendChild(tabEl);
    tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // attach tabEl ref into session
    sessions[sessionId].tabEl = tabEl;
    refreshHostConnectionDots();

    // Connect after a short delay for stable sizing (store config on session for reconnect)
    sessions[sessionId].connectTimer = setTimeout(() => {
      // The tab can be closed before this fires; connecting now would leave an
      // SSH connection in the main process that nothing will ever close.
      const session = sessions[sessionId];
      if (!session) return;
      session.connectTimer = null;

      try {
        fitAddon.fit();
      } catch (e) {
        console.warn('Initial fit failed', e);
      }

      if (config) {
        // Save config for reconnect attempts
        session.config = config;
        term.write(`Connecting to ${config.host}...\r\n`);
        document.getElementById('connect-form').classList.add('hidden');
        const size = { cols: term.cols, rows: term.rows };
        window.electronAPI.connectSSH({ sessionId, config, size });
      }
      term.focus();
    }, 200);

    // Forward typed keys to backend
    term.onData(data => {
      window.electronAPI.sendInput({ sessionId, data });
    });

    switchTab(sessionId);
  }

  // -------------------------
  // Tab / Session helpers
  // -------------------------
  function switchTab(sessionId) {
    activeSessionId = sessionId;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

    const settingsView = document.getElementById('settings-view');
    if (settingsView) settingsView.classList.remove('visible');

    if (sessionId === 'settings') {
      const tab = document.getElementById('tab-settings');
      if (tab) tab.classList.add('active');
      document.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
      document.getElementById('connect-form').classList.add('hidden');
      if (settingsView) settingsView.classList.add('visible');
      return;
    }

    const tab = document.getElementById(`tab-${sessionId}`);
    if (tab) tab.classList.add('active');

    document.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
    const session = sessions[sessionId];
    if (session) {
      session.container.classList.add('active');
      document.getElementById('connect-form').classList.add('hidden');
      setTimeout(() => {
        session.fitAddon.fit();
        window.electronAPI.resizeTerm({
          sessionId,
          cols: session.term.cols,
          rows: session.term.rows
        });
      }, 100);
    }
  }

  function closeSession(sessionId) {
    window.electronAPI.disconnectSSH(sessionId);
    const tab = document.getElementById(`tab-${sessionId}`);
    if (tab) tab.remove();
    const session = sessions[sessionId];
    if (session) {
      if (session.connectTimer) clearTimeout(session.connectTimer);
      // Dispose the terminal, or every closed tab leaks its listeners and
      // its WebGL context (browsers only allow a handful of those at once).
      // The two disposals are independent: a throwing addon must not stop the
      // terminal itself from being released.
      try {
        if (session.webglAddon) session.webglAddon.dispose();
      } catch (e) {
        console.warn('WebGL addon disposal failed', e);
      }
      try {
        session.term.dispose();
      } catch (e) {
        console.warn('Terminal disposal failed', e);
      }
      session.container.remove();
    }
    delete sessions[sessionId];
    refreshHostConnectionDots();

    const remainingIds = Object.keys(sessions);
    if (remainingIds.length > 0) {
      switchTab(remainingIds[remainingIds.length - 1]);
    } else {
      activeSessionId = null;
      document.getElementById('connect-form').classList.remove('hidden');
    }
  }

  // -------------------------
  // Resize handling
  // -------------------------

  // Refit the visible terminal and tell the remote pty about the new size.
  // Debounced because a window drag fires this continuously, and every call
  // is a reflow plus an IPC round trip.
  let resizeTimer = null;
  function refitActiveTerminal() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const s = sessions[activeSessionId];
      if (!s) return;
      try {
        s.fitAddon.fit();
      } catch (e) {
        return; // container not laid out yet
      }
      window.electronAPI.resizeTerm({
        sessionId: activeSessionId,
        cols: s.term.cols,
        rows: s.term.rows
      });
    }, 80);
  }

  // Push one session's current size to its pty. Only the visible terminal can
  // be measured, so an inactive tab just re-sends the size it already has.
  function syncSessionSize(sessionId) {
    const s = sessions[sessionId];
    if (!s) return;
    if (sessionId === activeSessionId) {
      try {
        s.fitAddon.fit();
      } catch (e) {
        // container not laid out yet; the stored dimensions still apply
      }
    }
    window.electronAPI.resizeTerm({ sessionId, cols: s.term.cols, rows: s.term.rows });
  }

  // A ResizeObserver covers layout changes the window never sees, such as
  // dragging the sidebar divider or showing/hiding the disconnect banner. The
  // window listener stays as a backstop in case observer delivery is throttled.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(refitActiveTerminal).observe(document.getElementById('terminals-wrapper'));
  }
  window.addEventListener('resize', refitActiveTerminal);

  // -------------------------
  // IPC Listeners from main
  // -------------------------
  window.electronAPI.onData(({ sessionId, data }) => {
    const s = sessions[sessionId];
    if (s) s.term.write(data);
  });

  function setTabConnected(sessionId, connected) {
    const s = sessions[sessionId];
    if (s && s.tabEl) s.tabEl.classList.toggle('disconnected', !connected);
  }

  window.electronAPI.onStatus(({ sessionId, status, code, signal, hadError }) => {
    // Connected -> hide banner
    if (status === 'Connected') {
      setTabConnected(sessionId, true);
      hideBannerForSession(sessionId);
      // The window may have been resized during the handshake, so make sure
      // the pty ends up matching the terminal it is actually drawing into.
      syncSessionSize(sessionId);
      return;
    }

    // ignore transient window-change
    if (status === 'window-change') return;

    setTabConnected(sessionId, false);

    // Map statuses to readable messages
    let msg = '';
    if (status === 'Disconnected') msg = 'Disconnected from remote host';
    else if (status === 'Closed') msg = `Connection closed${hadError ? ' (error)' : ''}`;
    else if (status === 'Exit') msg = `Remote exited (code=${code ?? 'unknown'} signal=${signal ?? 'none'})`;
    else msg = `Status: ${status}`;

    showBannerForSession(sessionId, msg, 'error');
  });

  window.electronAPI.onError(({ sessionId, message }) => {
    console.error('ssh-error', sessionId, message);
    setTabConnected(sessionId, false);
    showBannerForSession(sessionId, `Error: ${message}`, 'error');
  });

  // -------------------------
  // Connect UI
  // -------------------------
  function updateQuickConnectAuthUI() {
    const method = document.getElementById('auth-method').value;
    const passWrap = document.getElementById('password-wrapper');
    const keyWrap = document.getElementById('key-wrapper');
    if (method === 'key') {
      passWrap.classList.add('hidden');
      keyWrap.classList.remove('hidden');
    } else {
      passWrap.classList.remove('hidden');
      keyWrap.classList.add('hidden');
    }
  }

  document.getElementById('auth-method').addEventListener('change', updateQuickConnectAuthUI);

  document.getElementById('btn-connect').onclick = () => {
    const hostInput = document.getElementById('inp-host');
    const portInput = document.getElementById('inp-port');
    const userInput = document.getElementById('inp-user');
    const passInput = document.getElementById('inp-pass');
    const keySelect = document.getElementById('inp-key-select');
    const keyPass = document.getElementById('inp-key-passphrase');
    const authMethod = document.getElementById('auth-method').value;

    const config = {
      host: hostInput.value,
      port: portInput.value,
      username: userInput.value,
      password: passInput.value,
      authType: authMethod,
      keepalive: DEFAULT_KEEPALIVE
    };

    if (authMethod === 'key') {
      const selectedKey = getKeyById(keySelect.value) || getKeyById(defaultKeyId);
      if (!selectedKey) {
        keySelect.classList.add('error');
        return;
      }
      keySelect.classList.remove('error');
      config.authType = 'key';
      config.keyId = selectedKey.id;
      config.privateKeyPath = selectedKey.privateKeyPath;
      config.passphrase = keyPass.value;
      config.password = null;
    }

    let isValid = true;
    if (!config.host) {
      hostInput.style.border = '1px solid #ff4444';
      isValid = false;
    } else hostInput.style.border = '';
    if (!config.username) {
      userInput.style.border = '1px solid #ff4444';
      isValid = false;
    } else userInput.style.border = '';
    if (!isValid) return;
    createSession(config, config.host);
  };

  document.getElementById('new-tab-btn').onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
    const settingsView = document.getElementById('settings-view');
    if (settingsView) settingsView.classList.remove('visible');
    document.getElementById('connect-form').classList.remove('hidden');
    activeSessionId = null;
  };

  if (window.electronAPI.onOpenSettings) {
    window.electronAPI.onOpenSettings(() => openSettingsTab());
  }

  document.getElementById('btn-add-existing-key').addEventListener('click', async () => {
    const pathInput = document.getElementById('existing-key-path');
    const nameInput = document.getElementById('existing-key-name');
    const path = (pathInput.value || '').trim();
    const name = (nameInput.value || '').trim();
    if (!path) {
      pathInput.focus();
      return;
    }
    await window.electronAPI.addSSHKey({ privateKeyPath: path, name });
    pathInput.value = '';
    nameInput.value = '';
    await loadSSHKeys();
    loadHosts(document.getElementById('search-input').value);
  });

  const browseExistingBtn = document.getElementById('btn-browse-existing-key');
  if (browseExistingBtn && window.electronAPI.selectSSHKeyFile) {
    browseExistingBtn.addEventListener('click', async () => {
      const selected = await window.electronAPI.selectSSHKeyFile();
      if (selected) {
        document.getElementById('existing-key-path').value = selected;
      }
    });
  }

  function populateKeySizeOptions(type) {
    const select = document.getElementById('new-key-size');
    if (!select) return;

    const addOption = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    };

    select.innerHTML = '';
    if (type === 'rsa') {
      addOption('', 'Default (2048)');
      ['2048', '3072', '4096'].forEach((size) => addOption(size, size));
      select.disabled = false;
    } else if (type === 'ecdsa') {
      addOption('', 'Default (256)');
      ['256', '384', '521'].forEach((size) => addOption(size, size));
      select.disabled = false;
    } else {
      addOption('', 'Not applicable');
      select.disabled = true;
    }
  }

  function updateGenerateKeyNote() {
    const directoryInput = document.getElementById('new-key-directory');
    const note = document.getElementById('generate-key-note');
    if (!directoryInput || !note) return;
    const targetDir = (directoryInput.value || '').trim() || defaultSSHDir || '~/.ssh';
    note.textContent = `Keys are created in ${targetDir}.`;
  }

  populateKeySizeOptions(document.getElementById('new-key-type').value);
  updateGenerateKeyNote();

  const keyTypeSelect = document.getElementById('new-key-type');
  if (keyTypeSelect) {
    keyTypeSelect.addEventListener('change', (e) => {
      populateKeySizeOptions(e.target.value);
    });
  }

  const browseDirBtn = document.getElementById('btn-browse-key-directory');
  if (browseDirBtn && window.electronAPI.selectSSHDirectory) {
    browseDirBtn.addEventListener('click', async () => {
      const selected = await window.electronAPI.selectSSHDirectory();
      if (selected) {
        const dirInput = document.getElementById('new-key-directory');
        dirInput.value = selected;
        updateGenerateKeyNote();
      }
    });
  }

  const dirInput = document.getElementById('new-key-directory');
  if (dirInput) {
    dirInput.addEventListener('input', updateGenerateKeyNote);
  }

  document.getElementById('btn-generate-key').addEventListener('click', async () => {
    const name = document.getElementById('new-key-name').value;
    const type = document.getElementById('new-key-type').value;
    const size = document.getElementById('new-key-size').value;
    const directoryInput = document.getElementById('new-key-directory');
    const directory = (directoryInput.value || '').trim() || defaultSSHDir;
    const passphrase = document.getElementById('new-key-passphrase').value;
    try {
      await window.electronAPI.generateSSHKey({ name, passphrase, type, size, directory });
      document.getElementById('new-key-name').value = '';
      document.getElementById('new-key-passphrase').value = '';
      populateKeySizeOptions(type);
      updateGenerateKeyNote();
      await loadSSHKeys();
      loadHosts(document.getElementById('search-input').value);
    } catch (err) {
      console.error('Key generation failed', err);
      alert(`Key generation failed: ${err.message || err}`);
    }
  });

  // -------------------------
  // Sidebar resizing (drag the divider, width is remembered)
  // -------------------------
  const sidebarEl = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebar-resizer');

  function applySidebarWidth(width) {
    const clamped = Math.min(520, Math.max(200, width));
    sidebarEl.style.width = `${clamped}px`;
    return clamped;
  }

  try {
    const storedWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (Number.isFinite(storedWidth)) applySidebarWidth(storedWidth);
  } catch (e) {
    // ignore unavailable storage
  }

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');

    const onMove = (ev) => {
      applySidebarWidth(ev.clientX - sidebarEl.getBoundingClientRect().left);
    };

    const onUp = () => {
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(parseInt(sidebarEl.style.width, 10)));
      } catch (err) {
        // ignore unavailable storage
      }
      // The terminal needs to re-measure against the new width
      refitActiveTerminal();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Esc closes whichever modal is open; clicking the backdrop does the same
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
  groupModal.addEventListener('mousedown', (e) => {
    if (e.target === groupModal) closeGroupModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modal.classList.contains('hidden')) modal.classList.add('hidden');
    else if (!groupModal.classList.contains('hidden')) closeGroupModal();
  });

  // Flag the body so the CSS can leave room for native window controls
  if (typeof window.electronAPI.getWindowChrome === 'function') {
    window.electronAPI.getWindowChrome().then((mode) => {
      if (!mode || mode === 'native') return;
      document.body.classList.add('frameless', mode);
    }).catch(() => { /* fall back to the default framed layout */ });
  }

  // initial load
  syncClearSearchBtn();
  loadSSHKeys().finally(() => {
    updateQuickConnectAuthUI();
    loadHosts();
  });
};
