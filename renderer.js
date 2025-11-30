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
      list.innerHTML = '<div style="color:#aaa;">No keys found. Add or generate one to get started.</div>';
      return;
    }

    list.innerHTML = '';
    sshKeys.forEach((key) => {
      const card = document.createElement('div');
      card.className = 'key-card';

      const header = document.createElement('div');
      header.className = 'key-row';
      const title = document.createElement('div');
      title.textContent = key.name;
      header.appendChild(title);

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = key.discovered ? 'Detected' : 'Saved';
      header.appendChild(badge);
      card.appendChild(header);

      const pathRow = document.createElement('div');
      pathRow.className = 'key-path';
      pathRow.textContent = key.privateKeyPath;
      card.appendChild(pathRow);

      const actions = document.createElement('div');
      actions.className = 'key-actions';

      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '6px';

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
      label.appendChild(document.createTextNode('Use as default'));
      actions.appendChild(label);

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.className = 'cta';
      deleteBtn.title = 'Remove from the app (file on disk stays untouched).';
      deleteBtn.onclick = async () => {
        const confirmed = window.confirm(
          `Remove ${key.name} from Electron SSH Client? This will not delete the file on disk.`
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
    const tabsBar = document.getElementById('tabs-bar');
    const spacer = document.getElementById('toolbar-spacer');
    let tab = document.getElementById('tab-settings');

    if (!tab) {
      tab = document.createElement('div');
      tab.className = 'tab';
      tab.id = 'tab-settings';
      tab.innerHTML = `Settings<span class="close-tab">&times;</span>`;
      tab.onclick = (e) => {
        if (e.target.classList.contains('close-tab')) {
          closeSettingsTab();
        } else {
          switchTab('settings');
        }
      };
      // Place after spacer so it sits on the right side of the bar
      tabsBar.insertBefore(tab, spacer.nextSibling);
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

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'term-banner-dismiss';
    dismissBtn.type = 'button';
    dismissBtn.innerHTML = '&times;';
    dismissBtn.onclick = (ev) => { ev.stopPropagation(); hideBannerForSession(sessionId); };
    btns.appendChild(dismissBtn);

    banner.appendChild(btns);

    s.bannerEl = banner;
    s.bannerMsgEl = msgSpan;
    s.bannerReconnectBtn = reconnectBtn;
    s.bannerDismissBtn = dismissBtn;

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

  function resetSaveModal() {
    document.getElementById('modal-title').textContent = 'Save New Host Configuration';
    document.getElementById('host-id').value = '';
    document.getElementById('save-name').value = '';
    document.getElementById('save-host').value = '';
    document.getElementById('save-port').value = 22;
    document.getElementById('save-user').value = '';
    document.getElementById('save-pass').value = '';
    document.getElementById('save-group').value = activeGroupFilter !== 'all' ? activeGroupFilter : getDefaultGroupId();
    document.getElementById('save-auth').value = 'password';
    document.getElementById('save-key').value = '';
    document.getElementById('btn-save-confirm').textContent = 'Save';
    document.getElementById('btn-delete-host').classList.add('hidden');
    document.getElementById('btn-delete-host').disabled = false;
    document.getElementById('btn-delete-host').textContent = 'Delete';
    modal.classList.remove('hidden');
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
    document.getElementById('modal-title').textContent = 'Edit Host Configuration';
    document.getElementById('host-id').value = host.id;
    document.getElementById('save-name').value = host.name;
    document.getElementById('save-host').value = host.host;
    document.getElementById('save-port').value = host.port || 22;
    document.getElementById('save-user').value = host.username;
    document.getElementById('save-pass').value = host.password || '';
    document.getElementById('save-group').value = host.groupId || getDefaultGroupId();
    document.getElementById('save-auth').value = host.authType || (host.keyId ? 'key' : 'password');
    document.getElementById('save-key').value = host.keyId || '';
    document.getElementById('btn-save-confirm').textContent = 'Save';
    document.getElementById('btn-delete-host').classList.remove('hidden');
    document.getElementById('btn-delete-host').disabled = false;
    document.getElementById('btn-delete-host').textContent = 'Delete';
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
  async function loadHosts(filter = '') {
    const { hosts = [], groups: storedGroups = [] } = await window.electronAPI.getHosts();
    allHosts = hosts;
    groups = storedGroups;
    refreshGroupSelectors();

    const container = document.getElementById('saved-hosts-list');
    container.innerHTML = '';

    const selectedGroupId = document.getElementById('group-filter')?.value || activeGroupFilter;

    const lowerFilter = filter.toLowerCase().trim();
    const filteredHosts = allHosts.filter(host => {
      const matchesGroup = selectedGroupId === 'all' || host.groupId === selectedGroupId;
      if (!lowerFilter) return matchesGroup;
      const matchesSearch = (
        host.name.toLowerCase().includes(lowerFilter) ||
        host.host.toLowerCase().includes(lowerFilter) ||
        host.username.toLowerCase().includes(lowerFilter)
      );
      return matchesGroup && matchesSearch;
    });

    if (filteredHosts.length === 0) {
      if (filter) {
        container.innerHTML = `<div style="color: #aaa; text-align: center; margin-top: 20px;">No matches found.</div>`;
      } else {
        container.innerHTML = `<div style="color: #aaa; text-align: center; margin-top: 20px;">No saved hosts yet.</div>`;
      }
      return;
    }

    const hostsByGroup = new Map();
    filteredHosts.forEach(host => {
      const gid = host.groupId || getDefaultGroupId();
      if (!hostsByGroup.has(gid)) hostsByGroup.set(gid, []);
      hostsByGroup.get(gid).push(host);
    });

    const groupsToRender = [];
    if (selectedGroupId === 'all') {
      groups.forEach(g => {
        if (hostsByGroup.has(g.id)) groupsToRender.push(g);
      });

      // Include any groups that may not be in the stored list (fallback safety)
      hostsByGroup.forEach((_, gid) => {
        if (!groupsToRender.some(g => g.id === gid)) {
          groupsToRender.push({ id: gid, name: getGroupName(gid) });
        }
      });
    } else {
      const matched = groups.find(g => g.id === selectedGroupId) || { id: selectedGroupId, name: getGroupName(selectedGroupId) };
      if (hostsByGroup.has(selectedGroupId)) groupsToRender.push(matched);
    }

    const createHostElement = (host) => {
      const el = document.createElement('div');
      el.dataset.hostId = host.id;
      el.className = 'saved-host-item';
      const key = getKeyById(host.keyId);
      const authLabel = host.authType === 'key' || (host.keyId && host.authType !== 'password')
        ? `SSH Key${key ? ` • ${key.name}` : ''}`
        : 'Password';
      el.innerHTML = `
        <div class="host-top-row">
          <div class="host-name">${host.name}</div>
        </div>
        <div class="host-details">${host.username}@${host.host}:${host.port || 22} • ${authLabel}</div>
        <button class="edit-host-btn" title="Edit Host Configuration" aria-label="Edit Host">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/>
            <path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5v11z"/>
          </svg>
        </button>
      `;

      // Double click to connect
      el.addEventListener('dblclick', () => {
        createSession(buildConfigFromHost(host), host.name);
      });

      // Edit button click to open modal
      const editBtn = el.querySelector('.edit-host-btn');
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditHostModal(host);
      });

      return el;
    };

    groupsToRender.forEach(group => {
      const section = document.createElement('div');
      section.className = 'group-section';

      const header = document.createElement('div');
      header.className = 'group-header';
      header.textContent = group.name;
      section.appendChild(header);

      const hostList = document.createElement('div');
      hostList.className = 'group-hosts';
      hostsByGroup.get(group.id).forEach(host => {
        hostList.appendChild(createHostElement(host));
      });

      section.appendChild(hostList);
      container.appendChild(section);
    });
  }

  document.getElementById('search-input').addEventListener('input', (e) => {
    loadHosts(e.target.value);
  });

  document.getElementById('group-filter').addEventListener('change', (e) => {
    activeGroupFilter = e.target.value;
    loadHosts(document.getElementById('search-input').value);
  });

  document.getElementById('add-group-btn').addEventListener('click', openGroupModal);

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
    };

    if (!hostData.name || !hostData.host || !hostData.username) {
      console.error("Display Name, Host, and Username are required.");
      return;
    }

    await window.electronAPI.saveHost(hostData);
    modal.classList.add('hidden');
    document.getElementById('search-input').value = '';
    loadHosts();
  };

  // Delete Host logic
  document.getElementById('btn-delete-host').onclick = async () => {
    const hostId = document.getElementById('host-id').value;
    const hostName = document.getElementById('save-name').value;

    if (!hostId) {
      console.error("Cannot delete host without an ID.");
      return;
    }

    try {
      const deleteBtn = document.getElementById('btn-delete-host');
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';

      await window.electronAPI.deleteHost(hostId);
      console.log(`Host '${hostName}' (ID: ${hostId}) deleted.`);
      modal.classList.add('hidden');
      document.getElementById('search-input').value = '';
      loadHosts();
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
      password: host.password || ''
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
  function createSession(config = null, title = "New Connection") {
    const sessionId = Date.now().toString();

    // Container & banner
    const termWrapper = document.getElementById('terminals-wrapper');
    const termContainer = document.createElement('div');
    termContainer.className = 'terminal-instance active';
    termContainer.id = `term-${sessionId}`;

    // append container (banner will be inserted by createBanner)
    termWrapper.appendChild(termContainer);

    // Initialize Xterm
    const term = new Terminal({
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 9999,
      theme: { background: '#000000' }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);

    try {
      const webglAddon = new WebglAddon.WebglAddon();
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn("WebGL addon failed to load, falling back to canvas", e);
    }

    // Save session (with bannerEl placeholder)
    sessions[sessionId] = { term, fitAddon, container: termContainer, title, bannerEl: null, tabEl: null, config: config || null };

    // --- Clipboard Copy (Left-Click Selection) ---
    // Copy selected text into system clipboard using navigator.clipboard or electronAPI
    term.onSelectionChange(() => {
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
    });

    // --- Right-click paste: send to backend (works with electronAPI or navigator.clipboard) ---
    termContainer.addEventListener('contextmenu', async (e) => {
      if (activeSessionId !== sessionId) return;
      e.preventDefault();
      e.stopPropagation();

      try {
        const pasteText = await readClipboardText();
        if (!pasteText) return;

        // Convert newlines to '\r' so the backend receives Enter-like input as if typed
        const normalized = pasteText.replace(/\r\n|\r|\n/g, '\r');

        // Send to backend in chunks so large pastes don't overload buffers
        const CHUNK = 2048;
        for (let i = 0; i < normalized.length; i += CHUNK) {
          const chunk = normalized.slice(i, i + CHUNK);
          window.electronAPI.sendInput({ sessionId, data: chunk });
        }

        // Focus the terminal so subsequent keys go to it
        term.focus();
      } catch (err) {
        console.error("Failed to read/paste clipboard:", err);
      }
    });

    // Create Tab UI
    const tabsBar = document.getElementById('tabs-bar');
    const newTabBtn = document.getElementById('new-tab-btn');
    const tabEl = document.createElement('div');
    tabEl.className = 'tab active';
    tabEl.id = `tab-${sessionId}`;
    tabEl.innerHTML = `${title}<span class="close-tab">&times;</span>`;

    tabEl.onclick = (e) => {
      if (e.target.classList.contains('close-tab')) closeSession(sessionId);
      else switchTab(sessionId);
    };
    tabsBar.insertBefore(tabEl, newTabBtn);

    // attach tabEl ref into session
    sessions[sessionId].tabEl = tabEl;

    // Connect after a short delay for stable sizing (store config on session for reconnect)
    setTimeout(() => {
      fitAddon.fit();
      if (config) {
        // Save config for reconnect attempts
        sessions[sessionId].config = config;
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
    if (session) session.container.remove();
    delete sessions[sessionId];

    const remainingIds = Object.keys(sessions);
    if (remainingIds.length > 0) {
      switchTab(remainingIds[remainingIds.length - 1]);
    } else {
      activeSessionId = null;
      document.getElementById('connect-form').classList.remove('hidden');
    }
  }

  // -------------------------
  // Window resize handling
  // -------------------------
  window.addEventListener('resize', () => {
    if (activeSessionId && sessions[activeSessionId]) {
      const s = sessions[activeSessionId];
      s.fitAddon.fit();
      window.electronAPI.resizeTerm({
        sessionId: activeSessionId,
        cols: s.term.cols,
        rows: s.term.rows
      });
    }
  });

  // -------------------------
  // IPC Listeners from main
  // -------------------------
  window.electronAPI.onData(({ sessionId, data }) => {
    const s = sessions[sessionId];
    if (s) s.term.write(data);
  });

  window.electronAPI.onStatus(({ sessionId, status, code, signal, hadError }) => {
    // Connected -> hide banner
    if (status === 'Connected') {
      hideBannerForSession(sessionId);
      return;
    }

    // ignore transient window-change
    if (status === 'window-change') return;

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
      authType: authMethod
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

  // initial load
  loadSSHKeys().finally(() => {
    updateQuickConnectAuthUI();
    loadHosts();
  });
};
