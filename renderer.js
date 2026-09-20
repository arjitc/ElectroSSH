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
  let recentConnections = null; // the home view's list; null until first loaded

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

  // Inline SVG icons: Lucide shapes on Lucide's 24x24 grid. The stroke width
  // follows the display size, so every icon reads at the same weight however
  // large it is drawn. The same sizes and widths are used in index.html.
  const ICON_STROKE = { 12: 2.9, 14: 2.5, 16: 2.2, 18: 1.9 };
  const icon = (size, body) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="${ICON_STROKE[size]}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  const ICONS = {
    chevron: icon(12, '<path d="m9 18 6-6-6-6"/>'),
    folder: icon(14, '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
    play: icon(14, '<polygon points="6 3 20 12 6 21"/>'),
    pencil: icon(14, '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
    bolt: icon(14, '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'),
    server: icon(14, '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'),
    close: icon(12, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    copy: icon(14, '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    sliders: icon(12, '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/>'
      + '<line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/>'
      + '<line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
    // A list with chevrons, and a tree: clearer here than Lucide's converging
    // chevrons-down-up, which reads as an X at this size
    collapseAll: icon(16, '<path d="m3 10 2.5-2.5L3 5"/><path d="m3 19 2.5-2.5L3 14"/><path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/>'),
    expandAll: icon(16, '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>')
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

  // What the host dialog and Quick Connect accept in their keep-alive box.
  // A number input hands back '' for anything unparseable, so an empty box
  // simply means "use the default"; negatives and decimals are rejected.
  // Returns the number of seconds, or null for a value that isn't allowed.
  function parseKeepaliveInput(input) {
    const raw = input.value.trim();
    if (raw === '') return DEFAULT_KEEPALIVE;
    const seconds = Number(raw);
    return Number.isInteger(seconds) && seconds >= 0 && seconds <= MAX_KEEPALIVE ? seconds : null;
  }
  const KEEPALIVE_ERROR = `Keep-alive must be a whole number of seconds from 0 to ${MAX_KEEPALIVE} (0 disables it).`;

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
        if (await window.electronAPI.writeClipboard(text)) return true;
      }
    } catch (e) {
      console.warn('electronAPI.writeClipboard failed, falling back to navigator.clipboard', e);
    }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn('navigator.clipboard.writeText failed or not permitted', e);
    }

    // nothing worked
    return false;
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
  // Terminal font size (Ctrl+= / Ctrl+- / Ctrl+0, or Ctrl+wheel)
  // -------------------------
  const FONT_SIZE_KEY = 'electrossh.fontSize';
  const DEFAULT_FONT_SIZE = 13;
  const MIN_FONT_SIZE = 8;
  const MAX_FONT_SIZE = 32;

  let terminalFontSize = DEFAULT_FONT_SIZE;
  try {
    const stored = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
    if (stored >= MIN_FONT_SIZE && stored <= MAX_FONT_SIZE) terminalFontSize = stored;
  } catch (e) {
    // storage unavailable: use the default
  }

  let zoomIndicatorTimer = null;
  function flashZoomIndicator(text) {
    const el = document.getElementById('zoom-indicator');
    if (!el) return;
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(zoomIndicatorTimer);
    zoomIndicatorTimer = setTimeout(() => el.classList.remove('visible'), 900);
  }

  // One size for every terminal. Only the visible one is updated now: a hidden
  // terminal can't measure its font, so the rest pick it up in switchTab.
  function setTerminalFontSize(size) {
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
    if (next !== terminalFontSize) {
      terminalFontSize = next;
      try { localStorage.setItem(FONT_SIZE_KEY, String(next)); } catch (e) { /* not persisted */ }
      const active = sessions[activeSessionId];
      if (active) {
        active.term.options.fontSize = next;
        refitActiveTerminal(); // cols/rows change, and the remote pty must hear about it
      }
    }
    const limit = next === MAX_FONT_SIZE ? ' (max)' : next === MIN_FONT_SIZE ? ' (min)' : '';
    flashZoomIndicator(`Font size ${next}${limit}`);
  }

  // -------------------------
  // Links in terminal output
  // -------------------------
  // A plain click selects text (and copies it), so opening a link takes
  // Ctrl+click (Cmd+click on macOS), as in VS Code and Windows Terminal. The
  // main process opens only http/https; this check just keeps the hint honest.
  const LINK_MODIFIER_LABEL = IS_MAC ? 'Cmd' : 'Ctrl';

  function isWebUrl(uri) {
    try {
      const { protocol } = new URL(uri);
      return protocol === 'http:' || protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function showLinkHint(event, uri) {
    const hint = document.getElementById('link-hint');
    if (!hint) return;
    const openable = isWebUrl(uri);
    document.getElementById('link-hint-url').textContent = uri;
    document.getElementById('link-hint-action').textContent = openable
      ? `${LINK_MODIFIER_LABEL}+click to open in your browser`
      : 'Only http and https links can be opened';
    hint.classList.toggle('blocked', !openable);
    hint.classList.add('visible');

    // Keep it on screen, just below and right of the pointer
    const gap = 14;
    const rect = hint.getBoundingClientRect();
    const x = Math.min(event.clientX + gap, window.innerWidth - rect.width - 8);
    const y = event.clientY + gap + rect.height > window.innerHeight - 8
      ? event.clientY - rect.height - gap
      : event.clientY + gap;
    hint.style.left = `${Math.max(8, x)}px`;
    hint.style.top = `${Math.max(8, y)}px`;
  }

  function hideLinkHint() {
    const hint = document.getElementById('link-hint');
    if (hint) hint.classList.remove('visible');
  }

  function openTerminalLink(event, uri) {
    if (!(IS_MAC ? event.metaKey : event.ctrlKey)) return;
    if (!isWebUrl(uri)) return;
    hideLinkHint();
    window.electronAPI.openExternal(uri).catch((err) => console.warn('Could not open link', err));
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
      tab.innerHTML = `<span class="tab-icon">${ICONS.sliders}</span>`
        + `<span class="tab-label">Settings</span><span class="close-tab" title="Close">${ICONS.close}</span>`;
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

  function openSettingsTab(page) {
    ensureSettingsTab();
    switchTab('settings');
    if (page) showSettingsPage(page);
  }

  // -------------------------
  // Settings pages
  // -------------------------
  const SETTINGS_PAGES = ['keys', 'shortcuts'];

  function showSettingsPage(page) {
    const target = SETTINGS_PAGES.includes(page) ? page : 'keys';
    SETTINGS_PAGES.forEach((p) => {
      const selected = p === target;
      document.getElementById(`settings-page-${p}`).classList.toggle('active', selected);
      const tab = document.getElementById(`settings-nav-${p}`);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
  }

  document.querySelectorAll('.settings-nav-item').forEach((tab) => {
    tab.addEventListener('click', () => showSettingsPage(tab.dataset.page));
    // Left/right move between pages, as in any tab strip
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = SETTINGS_PAGES.indexOf(tab.dataset.page);
      const next = SETTINGS_PAGES[(i + (e.key === 'ArrowRight' ? 1 : SETTINGS_PAGES.length - 1)) % SETTINGS_PAGES.length];
      showSettingsPage(next);
      document.getElementById(`settings-nav-${next}`).focus();
    });
  });

  // -------------------------
  // Keyboard shortcuts reference
  // -------------------------
  // One list, rendered into Settings. Each entry mirrors a real binding
  // elsewhere in this file (or the app menu in main.js); keep them in step.
  // A combo is an array of keys; an entry may list several alternatives.
  // Keys in MOUSE_ACTIONS render as mouse actions rather than key caps.
  const MOD = IS_MAC ? 'Cmd' : 'Ctrl';
  // Plain Ctrl+N belongs to the shell, so Windows and Linux add Shift
  const QUICK_CONNECT_KEYS = IS_MAC ? ['Cmd', 'N'] : ['Ctrl', 'Shift', 'N'];
  const MOUSE_ACTIONS = new Set(['Click', 'Double-click', 'Right-click', 'Middle-click', 'Scroll up', 'Scroll down', 'Select text']);

  const SHORTCUT_GROUPS = [
    {
      title: 'Terminal',
      items: [
        { action: 'Copy selection', combos: [IS_MAC ? ['Cmd', 'C'] : ['Ctrl', 'Shift', 'C'], ['Select text']] },
        { action: 'Paste', combos: [IS_MAC ? ['Cmd', 'V'] : ['Ctrl', 'Shift', 'V'], ['Right-click']] },
        { action: 'Open a link in your browser', combos: [[MOD, 'Click']], note: 'http and https links only' },
        { action: 'Find in terminal', combos: [IS_MAC ? ['Cmd', 'F'] : ['Ctrl', 'Shift', 'F']] },
        { action: 'Larger text', combos: [[MOD, '='], [MOD, 'Scroll up']] },
        { action: 'Smaller text', combos: [[MOD, '-'], [MOD, 'Scroll down']] },
        { action: 'Reset text size', combos: [[MOD, '0']] }
      ],
      footnote: IS_MAC
        ? null
        : 'Plain Ctrl+C, Ctrl+V, Ctrl+F and Ctrl+N go to the remote shell, so copy, paste, find and Quick Connect add Shift.'
    },
    {
      title: 'Find bar',
      items: [
        { action: 'Next match', combos: [['Enter']] },
        { action: 'Previous match', combos: [['Shift', 'Enter']] },
        { action: 'Close the find bar', combos: [['Esc']] }
      ]
    },
    {
      title: 'Host list',
      items: [
        { action: 'Connect to a host', combos: [['Double-click'], ['Enter']] },
        {
          action: 'Copy a host\'s address, name or port',
          combos: IS_MAC ? [['Right-click']] : [['Right-click'], ['Shift', 'F10']],
          note: 'Opens a menu on the host'
        },
        { action: 'Move between hosts and groups', combos: [['↑'], ['↓']] },
        { action: 'Expand or collapse a group', combos: [['→'], ['←']] },
        { action: 'Rename a group', combos: [['F2']] },
        { action: 'Clear the search box', combos: [['Esc']] }
      ],
      footnote: 'Click a host or group first to steer the list with the keyboard.'
    },
    {
      title: 'Tabs and dialogs',
      items: [
        { action: 'Close a tab', combos: [['Middle-click']], note: 'On the tab itself. Asks first while its session is connected' },
        { action: 'Close or cancel a dialog', combos: [['Esc']] },
        { action: 'Confirm a group name', combos: [['Enter']] },
        { action: 'Connect from Quick Connect', combos: [['Enter']] }
      ],
      footnote: 'A host key prompt never accepts on Enter, so a stray keypress can\'t trust a key you haven\'t read.'
    },
    {
      title: 'Application',
      items: [
        { action: 'Quick Connect', combos: [QUICK_CONNECT_KEYS], note: 'Works from inside the terminal too' },
        { action: 'Open Settings', combos: [[MOD, ',']] },
        ...(IS_MAC ? [] : [
          { action: 'Show the menu bar', combos: [['Alt']] },
          { action: 'Full screen', combos: [['F11']], note: 'While the terminal isn\'t focused; there F11 goes to the shell' }
        ])
      ],
      // Mirrors the close/reload confirmation in main.js
      footnote: IS_MAC
        ? 'Cmd+W closes the window and Cmd+R reloads the app. Both ask first while SSH sessions are open.'
        : 'Outside the terminal, Ctrl+W closes the app and Ctrl+R reloads it. Both ask first while SSH sessions are open; inside the terminal those keys go to the shell.'
    }
  ];

  function renderShortcutCombo(keys) {
    const combo = document.createElement('span');
    combo.className = 'shortcut-combo';
    keys.forEach((key, i) => {
      if (i > 0) {
        const plus = document.createElement('span');
        plus.className = 'plus';
        plus.textContent = '+';
        combo.appendChild(plus);
      }
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      if (MOUSE_ACTIONS.has(key)) kbd.className = 'mouse';
      combo.appendChild(kbd);
    });
    return combo;
  }

  function renderShortcutsPage() {
    const container = document.getElementById('shortcut-groups');
    if (!container) return;
    container.innerHTML = '';

    SHORTCUT_GROUPS.forEach((group) => {
      const section = document.createElement('section');
      section.className = 'shortcut-group';
      const heading = document.createElement('h4');
      heading.textContent = group.title;
      section.appendChild(heading);

      group.items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'shortcut-row';

        const action = document.createElement('div');
        action.className = 'shortcut-action';
        action.textContent = item.action;
        if (item.note) {
          const note = document.createElement('small');
          note.textContent = item.note;
          action.appendChild(note);
        }

        const keys = document.createElement('div');
        keys.className = 'shortcut-keys';
        item.combos.forEach((combo, i) => {
          const el = renderShortcutCombo(combo);
          if (i > 0) {
            const or = document.createElement('span');
            or.className = 'or';
            or.textContent = 'or';
            el.prepend(or);
          }
          keys.appendChild(el);
        });

        row.appendChild(action);
        row.appendChild(keys);
        section.appendChild(row);
      });

      if (group.footnote) {
        const footnote = document.createElement('p');
        footnote.className = 'shortcut-footnote';
        footnote.textContent = group.footnote;
        section.appendChild(footnote);
      }
      container.appendChild(section);
    });
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
      setHomeVisible(true);
      closeFind();
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
        window.electronAPI.connectSSH({ sessionId, config: session.config, size, hostId: session.hostId });
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

  // The same modal creates a group and renames one; `editingGroupId` decides.
  let editingGroupId = null;

  // Total hosts in a group, ignoring the current search/filter
  function hostCountForGroup(groupId) {
    return allHosts.filter(h => (h.groupId || 'default') === groupId).length;
  }

  // A group can only be deleted once it is empty, and the built-in Default
  // group never can. Both cases disable the button and say why.
  function updateGroupDeleteButton(group) {
    const btn = document.getElementById('btn-group-delete');
    const note = document.getElementById('group-delete-note');
    if (!btn || !note) return;

    if (!group) {
      btn.classList.add('hidden');
      note.classList.add('hidden');
      note.textContent = '';
      return;
    }

    const count = hostCountForGroup(group.id);
    let blockedReason = '';
    if (group.id === 'default') {
      blockedReason = 'The Default group is built in and cannot be deleted.';
    } else if (count > 0) {
      blockedReason = `This group cannot be deleted because it has ${count} host${count === 1 ? '' : 's'} under it. Move or delete them first.`;
    }

    btn.classList.remove('hidden');
    btn.disabled = Boolean(blockedReason);
    btn.title = blockedReason || `Delete "${group.name}"`;
    note.textContent = blockedReason;
    note.classList.toggle('hidden', !blockedReason);
  }

  function openGroupModal(group) {
    if (!groupModal) return;
    editingGroupId = group ? group.id : null;

    document.getElementById('group-modal-title').textContent = group ? 'Rename Group' : 'Create Group';
    document.getElementById('group-modal-hint').textContent = group
      ? 'Hosts stay in the group; only its name changes.'
      : 'Groups keep the host tree tidy as your list grows.';
    document.getElementById('btn-group-confirm').textContent = group ? 'Rename' : 'Create Group';

    groupNameInput.value = group ? group.name : '';
    groupErrorEl.textContent = '';
    updateGroupDeleteButton(group);
    groupModal.classList.remove('hidden');
    setTimeout(() => {
      groupNameInput.focus();
      groupNameInput.select();
    }, 0);
  }

  function closeGroupModal() {
    if (!groupModal) return;
    groupModal.classList.add('hidden');
    groupErrorEl.textContent = '';
    editingGroupId = null;
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

  async function handleDeleteGroup() {
    if (!editingGroupId) return;
    const groupId = editingGroupId;
    const group = groups.find(g => g.id === groupId);
    const label = group ? group.name : 'this group';

    if (!window.confirm(`Delete the group "${label}"? This cannot be undone.`)) return;

    const result = await window.electronAPI.deleteGroup(groupId);
    if (!result || !result.ok) {
      // The main process re-checks, so this covers a group that gained hosts
      // in another window while the modal was open.
      groupErrorEl.textContent = result && result.reason === 'has-hosts'
        ? 'This group now has hosts under it and can no longer be deleted.'
        : 'This group could not be deleted.';
      if (result && result.store) {
        groups = result.store.groups || groups;
        updateGroupDeleteButton(groups.find(g => g.id === groupId));
      }
      return;
    }

    groups = result.store.groups || groups;
    collapsedGroups.delete(groupId);
    persistCollapsedGroups();
    if (activeGroupFilter === groupId) activeGroupFilter = 'all';
    refreshGroupSelectors();
    closeGroupModal();
    loadHosts(document.getElementById('search-input').value);
  }

  async function handleGroupSubmit() {
    if (!groupNameInput) return;
    const proposed = groupNameInput.value.trim();

    if (!proposed) {
      groupErrorEl.textContent = 'Please enter a group name.';
      groupNameInput.focus();
      return;
    }

    // A group may keep its own name; only clashes with *other* groups matter
    const exists = groups.some(
      g => g.id !== editingGroupId && g.name.toLowerCase() === proposed.toLowerCase()
    );
    if (exists) {
      groupErrorEl.textContent = 'A group with this name already exists.';
      groupNameInput.focus();
      return;
    }

    if (editingGroupId) {
      const store = await window.electronAPI.renameGroup({ groupId: editingGroupId, name: proposed });
      groups = store.groups || groups;
      refreshGroupSelectors();
      closeGroupModal();
      loadHosts(document.getElementById('search-input').value);
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
    btn.innerHTML = anyExpanded ? ICONS.collapseAll : ICONS.expandAll;
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

  // -------------------------
  // Host right-click menu: copy a saved host's address, name or port
  // -------------------------
  const hostMenu = document.getElementById('host-context-menu');
  const copyToast = document.getElementById('copy-toast');
  let hostMenuReturnFocus = null;
  let copyToastTimer = null;

  // IPv4, or anything with a colon (IPv6); everything else is a hostname
  function looksLikeIpAddress(value) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
  }

  /** Open the menu for `host` at (x, y), flipping it back inside the window near an edge. */
  function openHostMenu(host, x, y, rowEl) {
    const address = String(host.host || '');
    const items = [
      { id: 'address', label: looksLikeIpAddress(address) ? 'Copy IP address' : 'Copy hostname', value: address },
      { id: 'name', label: 'Copy display name', value: String(host.name || '') },
      { id: 'port', label: 'Copy SSH port', value: String(host.port || 22) }
    ];
    hostMenu.innerHTML = '';
    items.forEach((item) => {
      const button = document.createElement('button');
      button.className = 'context-menu-item';
      button.dataset.copy = item.id;
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      button.disabled = !item.value;
      button.innerHTML = `<span class="context-menu-icon">${ICONS.copy}</span>`
        + `<span class="context-menu-label">${escapeHtml(item.label)}</span>`
        + `<span class="context-menu-value">${escapeHtml(item.value)}</span>`;
      button.addEventListener('mouseenter', () => { if (!button.disabled) button.focus(); });
      button.addEventListener('click', () => copyFromHostMenu(item.value));
      hostMenu.appendChild(button);
    });

    hostMenuReturnFocus = rowEl;
    hostMenu.classList.remove('hidden');
    const { width, height } = hostMenu.getBoundingClientRect();
    const left = x + width > window.innerWidth - 4 ? x - width : x;
    const top = y + height > window.innerHeight - 4 ? y - height : y;
    hostMenu.style.left = `${Math.max(4, left)}px`;
    hostMenu.style.top = `${Math.max(4, top)}px`;
    const first = hostMenu.querySelector('.context-menu-item:not(:disabled)');
    if (first) first.focus();
  }

  function closeHostMenu(restoreFocus = false) {
    if (hostMenu.classList.contains('hidden')) return;
    hostMenu.classList.add('hidden');
    if (restoreFocus && hostMenuReturnFocus && hostMenuReturnFocus.isConnected) hostMenuReturnFocus.focus();
    hostMenuReturnFocus = null;
  }

  async function copyFromHostMenu(value) {
    const { left, top } = hostMenu.getBoundingClientRect();
    closeHostMenu(true);
    const copied = await writeClipboardText(value);
    showCopyToast(copied ? `Copied ${value}` : 'Could not copy to the clipboard', left, top);
  }

  // A brief note where the menu was, since copying is otherwise invisible
  function showCopyToast(text, x, y) {
    copyToast.textContent = text;
    const width = copyToast.offsetWidth;
    copyToast.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    copyToast.style.top = `${Math.max(4, y)}px`;
    copyToast.classList.add('visible');
    clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => copyToast.classList.remove('visible'), 1400);
  }

  hostMenu.addEventListener('keydown', (e) => {
    const items = [...hostMenu.querySelectorAll('.context-menu-item:not(:disabled)')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = index === -1 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
      items[next].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      // Esc here closes only the menu, not a dialog behind it
      e.preventDefault();
      e.stopPropagation();
      closeHostMenu(true);
    }
  });
  // A click anywhere else, scrolling the list, or leaving the window closes it
  document.addEventListener('mousedown', (e) => {
    if (!hostMenu.contains(e.target)) closeHostMenu();
  }, true);
  document.getElementById('saved-hosts-list').addEventListener('scroll', () => closeHostMenu());
  window.addEventListener('blur', () => closeHostMenu());
  window.addEventListener('resize', () => closeHostMenu());

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
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectHostRow(el);
      openHostMenu(host, e.clientX, e.clientY, el);
    });
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
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        // The keyboard's way to the right-click menu, anchored under the row
        e.preventDefault();
        selectHostRow(el);
        const rect = el.getBoundingClientRect();
        openHostMenu(host, rect.left + 16, rect.bottom, el);
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
      <button class="rename-group-btn" title="Rename group" aria-label="Rename group">${ICONS.pencil}</button>
      <span class="group-count">${hosts.length}</span>
    `;

    header.querySelector('.rename-group-btn').addEventListener('click', (e) => {
      e.stopPropagation(); // don't collapse the group on the way through
      openGroupModal(group);
    });

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
      } else if (e.key === 'F2') {
        e.preventDefault();
        openGroupModal(group);
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
    renderRecentConnections(); // saved hosts show there under their current names
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

    // An empty *group* still gets rendered below, so its row stays reachable
    // for renaming; only a fruitless search has nothing to show.
    if (filteredHosts.length === 0 && searching) {
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

  // Wrapped, or the click event would be passed in as the group to rename
  document.getElementById('add-group-btn').addEventListener('click', () => openGroupModal());

  document.getElementById('open-settings-btn').addEventListener('click', () => openSettingsTab());

  document.getElementById('save-auth').addEventListener('change', updateHostModalAuthUI);

  document.getElementById('btn-group-cancel').addEventListener('click', closeGroupModal);
  document.getElementById('btn-group-confirm').addEventListener('click', handleGroupSubmit);
  document.getElementById('btn-group-delete').addEventListener('click', handleDeleteGroup);
  groupNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGroupSubmit();
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

    const keepalive = parseKeepaliveInput(document.getElementById('save-keepalive'));
    if (keepalive === null) {
      errorEl.textContent = KEEPALIVE_ERROR;
      return;
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
      fontSize: terminalFontSize,
      lineHeight: 1.2,
      drawBoldTextInBrightColors: false,
      macOptionIsMeta: true,
      theme: TERMINAL_THEME,
      // The search addon highlights every match with xterm's decoration API,
      // which is gated behind this flag. The addon ships in lockstep with the
      // core, so the "proposed" API it relies on can't drift out from under it.
      allowProposedApi: true,
      // OSC 8 hyperlinks (ls --hyperlink, compiler output). Without this,
      // xterm falls back to confirm() + window.open(). The text passed here is
      // the link's real target, which can differ from what's displayed.
      linkHandler: {
        activate: (event, uri) => openTerminalLink(event, uri),
        hover: (event, uri) => showLinkHint(event, uri),
        leave: () => hideLinkHint(),
        allowNonHttpProtocols: false
      }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termHost);

    // Plain URLs in the output become Ctrl+clickable
    term.loadAddon(new WebLinksAddon.WebLinksAddon(
      (event, uri) => openTerminalLink(event, uri),
      { hover: (event, uri) => showLinkHint(event, uri), leave: () => hideLinkHint() }
    ));

    const searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults((result) => {
      if (sessionId === activeSessionId) renderSearchCount(result);
    });

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
      term, fitAddon, webglAddon, searchAddon, container: termContainer, termHost, title,
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
    tabEl.innerHTML = `<span class="tab-dot"></span>`
      + `<span class="tab-label">${escapeHtml(title)}</span><span class="close-tab" title="Close">${ICONS.close}</span>`;

    // Both ask first while the session is still connected
    tabEl.onclick = (e) => {
      if (e.target.closest('.close-tab')) requestCloseSession(sessionId);
      else switchTab(sessionId);
    };
    // Middle-click closes the tab, as in a browser
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        requestCloseSession(sessionId);
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
        setHomeVisible(false);
        const size = { cols: term.cols, rows: term.rows };
        window.electronAPI.connectSSH({ sessionId, config, size, hostId });
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
      setHomeVisible(false);
      if (settingsView) settingsView.classList.add('visible');
      closeFind();
      return;
    }

    const tab = document.getElementById(`tab-${sessionId}`);
    if (tab) tab.classList.add('active');

    document.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
    const session = sessions[sessionId];
    if (session) {
      session.container.classList.add('active');
      setHomeVisible(false);
      setTimeout(() => {
        if (sessions[sessionId] !== session) return; // closed in the meantime
        // Pick up a zoom change made while this terminal was hidden
        if (session.term.options.fontSize !== terminalFontSize) {
          session.term.options.fontSize = terminalFontSize;
        }
        session.fitAddon.fit();
        window.electronAPI.resizeTerm({
          sessionId,
          cols: session.term.cols,
          rows: session.term.rows
        });
      }, 100);
    }
    onActiveTerminalChanged();
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
      setHomeVisible(true);
      closeFind();
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
  // Find in terminal (Ctrl+Shift+F, or Cmd+F on macOS)
  // -------------------------
  // One bar, always searching whichever terminal is visible. Plain Ctrl+F is
  // left alone: in a shell it's readline's "forward one character".
  const findBar = document.getElementById('term-search');
  const findInput = document.getElementById('term-search-input');
  const findCount = document.getElementById('term-search-count');
  const findOptions = { caseSensitive: false, regex: false };

  // Decoration colours must be #RRGGBB, so these are pre-blended dark tones
  // rather than translucent overlays.
  const FIND_DECORATIONS = {
    matchBackground: '#1d3557',
    matchBorder: '#3b6fc4',
    matchOverviewRuler: '#4c8dff',
    activeMatchBackground: '#6b4a0c',
    activeMatchBorder: '#e3b341',
    activeMatchColorOverviewRuler: '#e3b341'
  };
  // The addon stops counting at its highlight limit
  const FIND_RESULT_LIMIT = 1000;

  function isFindOpen() {
    return !findBar.classList.contains('hidden');
  }

  function renderSearchCount({ resultIndex, resultCount }) {
    const hasQuery = findInput.value.length > 0;
    findCount.classList.toggle('none', hasQuery && resultCount === 0);
    if (!hasQuery) {
      findCount.textContent = '';
    } else if (resultCount === 0) {
      findCount.textContent = 'No results';
    } else {
      const total = resultCount >= FIND_RESULT_LIMIT ? `${FIND_RESULT_LIMIT}+` : String(resultCount);
      findCount.textContent = resultIndex >= 0 ? `${resultIndex + 1} of ${total}` : `${total} matches`;
    }
  }

  function clearFindHighlights(exceptSessionId) {
    Object.entries(sessions).forEach(([id, s]) => {
      if (id !== exceptSessionId && s.searchAddon) s.searchAddon.clearDecorations();
    });
  }

  function runFind(direction = 'next', incremental = false) {
    const s = sessions[activeSessionId];
    if (!s) return;
    const query = findInput.value;
    findInput.classList.remove('invalid');

    if (!query) {
      s.searchAddon.clearDecorations();
      renderSearchCount({ resultIndex: -1, resultCount: 0 });
      return;
    }
    // The addon builds a RegExp from the query and would throw on a bad one
    if (findOptions.regex) {
      try {
        new RegExp(query);
      } catch (e) {
        findInput.classList.add('invalid');
        s.searchAddon.clearDecorations();
        findCount.textContent = 'Invalid regex';
        findCount.classList.add('none');
        return;
      }
    }

    const options = { ...findOptions, incremental, decorations: FIND_DECORATIONS };
    const found = direction === 'prev'
      ? s.searchAddon.findPrevious(query, options)
      : s.searchAddon.findNext(query, options);
    if (!found) renderSearchCount({ resultIndex: -1, resultCount: 0 });
  }

  function openFind() {
    const s = sessions[activeSessionId];
    if (!s) return;
    findBar.classList.remove('hidden');
    // Seed with a one-line selection, the way editors do
    const selection = s.term.getSelection();
    if (selection && !selection.includes('\n') && selection.length <= 200) findInput.value = selection;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind('next', true);
  }

  function closeFind() {
    if (!isFindOpen()) return;
    findBar.classList.add('hidden');
    findInput.classList.remove('invalid');
    clearFindHighlights();
    findCount.textContent = '';
    const s = sessions[activeSessionId];
    if (s) s.term.focus();
  }

  // Called when the visible terminal changes
  function onActiveTerminalChanged() {
    if (!isFindOpen()) return;
    if (!sessions[activeSessionId]) {
      closeFind();
      return;
    }
    clearFindHighlights(activeSessionId);
    runFind('next', true);
  }

  findInput.addEventListener('input', () => runFind('next', true));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      // Only from the find box: Esc inside the terminal belongs to the shell
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  });
  document.getElementById('term-search-next').addEventListener('click', () => runFind('next'));
  document.getElementById('term-search-prev').addEventListener('click', () => runFind('prev'));
  document.getElementById('term-search-close').addEventListener('click', closeFind);

  [['term-search-case', 'caseSensitive'], ['term-search-regex', 'regex']].forEach(([id, option]) => {
    const btn = document.getElementById(id);
    btn.addEventListener('click', () => {
      findOptions[option] = !findOptions[option];
      btn.setAttribute('aria-pressed', String(findOptions[option]));
      // addon-search 0.16 records the new options before checking whether
      // they changed, so an options-only change never re-highlights or
      // recounts. Clearing drops its cached term and forces a fresh pass.
      const s = sessions[activeSessionId];
      if (s) s.searchAddon.clearDecorations();
      runFind('next', true);
      findInput.focus();
    });
  });

  // -------------------------
  // App shortcuts that work inside the terminal: find, zoom, Quick Connect
  // -------------------------
  // Handled in the capture phase so xterm never sees them; otherwise Ctrl+-
  // would also reach the shell as ^_.
  window.addEventListener('keydown', (e) => {
    const mod = IS_MAC ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
    if (!mod || e.altKey) return;
    const key = e.key;

    if (key.toLowerCase() === 'f' && (IS_MAC || e.shiftKey)) {
      // Don't pull focus out from under an open dialog
      if (!sessions[activeSessionId] || document.querySelector('.modal-overlay:not(.hidden)')) return;
      e.preventDefault();
      e.stopPropagation();
      openFind();
      return;
    }

    if (key.toLowerCase() === 'n' && (IS_MAC || e.shiftKey)) {
      // Not over another dialog: a host key prompt or a confirmation comes first
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;
      e.preventDefault();
      e.stopPropagation();
      openQuickConnect();
      return;
    }

    if (key === '=' || key === '+' || e.code === 'NumpadAdd') {
      setTerminalFontSize(terminalFontSize + 1);
    } else if (key === '-' || key === '_' || e.code === 'NumpadSubtract') {
      setTerminalFontSize(terminalFontSize - 1);
    } else if (key === '0' || e.code === 'Numpad0') {
      setTerminalFontSize(DEFAULT_FONT_SIZE);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Ctrl+wheel zooms too. Trackpads send many small deltas, so step once per
  // mouse-notch's worth of movement. On macOS a pinch arrives as ctrl+wheel.
  let zoomWheelDelta = 0;
  document.getElementById('terminals-wrapper').addEventListener('wheel', (e) => {
    const zooming = IS_MAC ? (e.metaKey || e.ctrlKey) : e.ctrlKey;
    if (!zooming) return;
    e.preventDefault();
    e.stopPropagation();
    zoomWheelDelta += e.deltaY;
    if (Math.abs(zoomWheelDelta) >= 60) {
      setTerminalFontSize(terminalFontSize + (zoomWheelDelta < 0 ? 1 : -1));
      zoomWheelDelta = 0;
    }
  }, { passive: false, capture: true });

  // -------------------------
  // IPC Listeners from main
  // -------------------------
  window.electronAPI.onData(({ sessionId, data }) => {
    const s = sessions[sessionId];
    if (s) s.term.write(data);
  });

  // Tracks whether a tab's session is live. Only a live one makes closing the
  // tab ask first; a tab that is still connecting, or has dropped, just closes.
  function setTabConnected(sessionId, connected) {
    const s = sessions[sessionId];
    if (!s) return;
    s.connected = connected;
    if (s.tabEl) s.tabEl.classList.toggle('disconnected', !connected);
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
  // Host key verification
  // -------------------------
  // The main process asks before trusting a server key it hasn't seen, or one
  // that differs from what was saved. Several tabs can be connecting at once,
  // so prompts queue and are answered one at a time; [0] is the one on screen.
  const hostKeyModal = document.getElementById('host-key-modal');
  const hostKeyDialog = hostKeyModal.querySelector('.host-key-dialog');
  const hostKeyQueue = [];

  function hostKeyTarget(prompt) {
    const s = sessions[prompt.sessionId];
    const user = s && s.config && s.config.username ? `${s.config.username}@` : '';
    const address = `${user}${prompt.host}:${prompt.port}`;
    return s && s.title && s.title !== prompt.host ? `${s.title}  ·  ${address}` : address;
  }

  function renderHostKeyPrompt(prompt) {
    const acceptBtn = document.getElementById('btn-host-key-accept');
    const lead = document.getElementById('host-key-lead');
    const title = document.getElementById('host-key-title');
    const changed = prompt.status === 'changed';

    hostKeyDialog.classList.toggle('is-changed', changed);
    hostKeyDialog.classList.toggle('is-new-type', prompt.status === 'new-key-type');
    document.getElementById('host-key-target').textContent = hostKeyTarget(prompt);
    document.getElementById('host-key-type').textContent = prompt.keyType;
    document.getElementById('host-key-fingerprint').textContent = prompt.fingerprint;

    // A changed key shows both fingerprints, saved above presented
    ['host-key-previous-label', 'host-key-previous'].forEach((id) => {
      document.getElementById(id).classList.toggle('hidden', !changed);
    });
    document.getElementById('host-key-previous').textContent = changed ? prompt.previousFingerprint : '';
    document.getElementById('host-key-fingerprint-label').textContent = changed ? 'New fingerprint' : 'Fingerprint';

    if (changed) {
      title.textContent = 'Warning: host key has changed';
      lead.innerHTML = '<strong>The key this server presented does not match the one saved for it.</strong> '
        + 'Someone could be intercepting your connection (a man-in-the-middle attack). This can also happen '
        + 'if the server was reinstalled or its keys were rotated. Do not continue unless you know why the key changed.';
      acceptBtn.textContent = 'Accept New Key';
      acceptBtn.className = 'btn btn-danger';
    } else if (prompt.status === 'new-key-type') {
      const known = (prompt.knownKeyTypes || []).map(escapeHtml).join(', ');
      title.textContent = 'New host key type';
      lead.innerHTML = `This server is already known, but it presented a <strong>${escapeHtml(prompt.keyType)}</strong> key `
        + `and only <strong>${known}</strong> is on record. This usually follows a server or client upgrade. `
        + 'Verify the fingerprint before trusting it.';
      acceptBtn.textContent = 'Accept & Save';
      acceptBtn.className = 'btn btn-primary';
    } else {
      title.textContent = 'Verify host key';
      lead.innerHTML = '<strong>ElectroSSH has no record of this server\'s key.</strong> '
        + 'Compare the fingerprint with one from your server administrator or provider console. '
        + 'Accept to save it; future connections will be checked against it.';
      acceptBtn.textContent = 'Accept & Save';
      acceptBtn.className = 'btn btn-primary';
    }

    const waiting = hostKeyQueue.length - 1;
    const queueNote = document.getElementById('host-key-queue');
    queueNote.textContent = waiting > 0 ? `${waiting} more host key${waiting === 1 ? '' : 's'} waiting after this one.` : '';
    queueNote.classList.toggle('hidden', waiting <= 0);
  }

  function showNextHostKeyPrompt() {
    const prompt = hostKeyQueue[0];
    if (!prompt) {
      hostKeyModal.classList.add('hidden');
      return;
    }
    renderHostKeyPrompt(prompt);
    // Bring the asking tab forward so it's obvious which connection this is
    if (sessions[prompt.sessionId] && activeSessionId !== prompt.sessionId) switchTab(prompt.sessionId);
    hostKeyModal.classList.remove('hidden');
    // Focus the dialog rather than a button: the prompt can appear while
    // someone is typing, and a stray Enter must not accept an unread key.
    setTimeout(() => hostKeyDialog.focus(), 0);
  }

  function answerHostKeyPrompt(decision) {
    const prompt = hostKeyQueue.shift();
    if (!prompt) return;
    window.electronAPI.respondHostKey({ requestId: prompt.requestId, decision });

    const s = sessions[prompt.sessionId];
    if (s && decision === 'accept') s.term.write('Host key accepted and saved.\r\n');
    if (s && decision === 'once') s.term.write('Host key accepted for this connection only.\r\n');
    showNextHostKeyPrompt();
  }

  if (typeof window.electronAPI.onHostKeyPrompt === 'function') {
    window.electronAPI.onHostKeyPrompt((prompt) => {
      hostKeyQueue.push(prompt);
      const s = sessions[prompt.sessionId];
      if (s) s.term.write('Waiting for you to verify the host key...\r\n');
      if (hostKeyQueue.length === 1) showNextHostKeyPrompt();
      else renderHostKeyPrompt(hostKeyQueue[0]); // refresh the "n more waiting" note
    });

    // The tab closed or the server gave up while the prompt was waiting
    window.electronAPI.onHostKeyPromptCancel(({ requestId }) => {
      const index = hostKeyQueue.findIndex((p) => p.requestId === requestId);
      if (index === -1) return;
      hostKeyQueue.splice(index, 1);
      if (index === 0) showNextHostKeyPrompt();
      else renderHostKeyPrompt(hostKeyQueue[0]);
    });
  }

  // -------------------------
  // "Disconnect?" confirmation
  // -------------------------
  // One dialog, two callers: main.js asks before closing or reloading the app
  // while sessions are open, and a tab's close button asks before dropping a
  // live session. Only one question is on screen at a time; if another
  // arrives (Ctrl+W while the tab dialog is up), it replaces the first, which
  // counts as Cancel.
  const sessionLossModal = document.getElementById('session-loss-modal');
  const SESSION_LOSS_LIST_LIMIT = 6;
  let sessionLossPending = null;   // { resolve } for the question on screen
  let sessionLossReturnFocus = null;

  function sessionAddress(s) {
    return s.config
      ? `${s.config.username ? s.config.username + '@' : ''}${s.config.host}:${s.config.port || 22}`
      : '';
  }

  function renderSessionLossList(sessionIds) {
    const list = document.getElementById('session-loss-list');
    list.innerHTML = '';
    const known = sessionIds.map((id) => sessions[id]).filter(Boolean);
    known.slice(0, SESSION_LOSS_LIST_LIMIT).forEach((s) => {
      const item = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      const address = sessionAddress(s);
      // A quick-connect tab is titled with its host, so the name would just
      // repeat the address; show the address alone in that case.
      const name = document.createElement('span');
      name.className = 'session-name';
      const titleIsHost = s.config && s.title === s.config.host;
      name.textContent = titleIsHost ? address : s.title;
      item.append(dot, name);
      if (address && !titleIsHost) {
        const addressEl = document.createElement('span');
        addressEl.className = 'session-address';
        addressEl.textContent = address;
        item.appendChild(addressEl);
      }
      list.appendChild(item);
    });
    const hidden = sessionIds.length - Math.min(known.length, SESSION_LOSS_LIST_LIMIT);
    if (hidden > 0) {
      const more = document.createElement('li');
      more.className = 'more';
      more.textContent = `and ${hidden} more`;
      list.appendChild(more);
    }
    list.classList.toggle('hidden', list.children.length === 0);
  }

  // Resolves true for the confirm button, false for Cancel, Esc, a click
  // outside, or being replaced by another question.
  function askSessionLoss({ title, lead, confirmLabel, sessionIds }) {
    return new Promise((resolve) => {
      if (sessionLossPending) sessionLossPending.resolve(false);
      else sessionLossReturnFocus = document.activeElement;
      sessionLossPending = { resolve };

      document.getElementById('session-loss-title').textContent = title;
      document.getElementById('session-loss-lead').textContent = lead;
      document.getElementById('btn-session-loss-confirm').textContent = confirmLabel;
      renderSessionLossList(sessionIds);
      sessionLossModal.classList.remove('hidden');
      // Cancel has focus, so Enter keeps everything open
      setTimeout(() => document.getElementById('btn-session-loss-cancel').focus(), 0);
    });
  }

  function settleSessionLoss(confirmed) {
    const pending = sessionLossPending;
    if (!pending) return;
    sessionLossPending = null;
    sessionLossModal.classList.add('hidden');
    // Put focus back where it was (usually the terminal); if that tab has just
    // been closed, its element is gone and the check skips it
    if (sessionLossReturnFocus && document.contains(sessionLossReturnFocus)) sessionLossReturnFocus.focus();
    sessionLossReturnFocus = null;
    pending.resolve(confirmed);
  }

  // --- asked by main.js: close or reload the whole app
  // Acknowledging straight away tells main this dialog is up; if it hears
  // nothing it falls back to a native one, so a hung page can't trap the window.
  let appPromptRequestId = null;

  if (typeof window.electronAPI.onSessionLossPrompt === 'function') {
    window.electronAPI.onSessionLossPrompt(({ requestId, action, sessionIds }) => {
      window.electronAPI.ackSessionLossPrompt(requestId);
      appPromptRequestId = requestId;
      const reload = action === 'reload';
      const count = sessionIds.length;
      const sessionsText = `${count} open SSH session${count === 1 ? '' : 's'}`;
      askSessionLoss({
        title: reload ? 'Reload ElectroSSH?' : 'Close ElectroSSH?',
        lead: reload
          ? `Reloading will disconnect ${sessionsText} and close ${count === 1 ? 'its tab' : 'their tabs'}.`
          : `Closing will disconnect ${sessionsText}.`,
        confirmLabel: reload ? 'Reload and Disconnect' : 'Close and Disconnect',
        sessionIds
      }).then((confirmed) => {
        if (appPromptRequestId === requestId) appPromptRequestId = null;
        window.electronAPI.respondSessionLossPrompt(requestId, confirmed);
      });
    });

    // main gave up waiting and used its native dialog instead
    window.electronAPI.onSessionLossPromptCancel(({ requestId }) => {
      if (requestId === appPromptRequestId) settleSessionLoss(false);
    });
  }

  // --- a tab's close button, while its session is still connected
  async function requestCloseSession(sessionId) {
    const s = sessions[sessionId];
    if (!s) return;
    if (!s.connected) {
      closeSession(sessionId); // nothing live to lose
      return;
    }
    const confirmed = await askSessionLoss({
      title: 'Close this tab?',
      lead: 'Its SSH session is still connected. Closing the tab will disconnect it.',
      confirmLabel: 'Close and Disconnect',
      sessionIds: [sessionId]
    });
    if (confirmed && sessions[sessionId]) closeSession(sessionId);
  }

  document.getElementById('btn-session-loss-cancel').addEventListener('click', () => settleSessionLoss(false));
  document.getElementById('btn-session-loss-confirm').addEventListener('click', () => settleSessionLoss(true));
  sessionLossModal.addEventListener('mousedown', (e) => {
    if (e.target === sessionLossModal) settleSessionLoss(false);
  });

  document.getElementById('btn-host-key-accept').addEventListener('click', () => answerHostKeyPrompt('accept'));
  document.getElementById('btn-host-key-once').addEventListener('click', () => answerHostKeyPrompt('once'));
  document.getElementById('btn-host-key-reject').addEventListener('click', () => answerHostKeyPrompt('reject'));

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
    const keepaliveInput = document.getElementById('inp-keepalive');
    const keepalive = parseKeepaliveInput(keepaliveInput);

    const config = {
      host: hostInput.value,
      port: portInput.value,
      username: userInput.value,
      password: passInput.value,
      authType: authMethod,
      keepalive
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
    const keepaliveError = document.getElementById('quick-connect-error');
    if (keepalive === null) {
      keepaliveInput.style.border = '1px solid #ff4444';
      keepaliveError.textContent = KEEPALIVE_ERROR;
      keepaliveError.classList.remove('hidden');
      isValid = false;
    } else {
      keepaliveInput.style.border = '';
      keepaliveError.classList.add('hidden');
    }
    if (!isValid) return;
    closeQuickConnect();
    createSession(config, config.host);
  };

  document.getElementById('new-tab-btn').onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
    const settingsView = document.getElementById('settings-view');
    if (settingsView) settingsView.classList.remove('visible');
    setHomeVisible(true);
    activeSessionId = null;
    closeFind();
  };

  // -------------------------
  // Quick Connect dialog and the home view's recent connections
  // -------------------------
  const quickConnectModal = document.getElementById('quick-connect-modal');

  /**
   * Open Quick Connect: empty from a lightning button, or filled in from a
   * recent one-off session. Passwords are never stored, so that one is
   * always asked for again.
   */
  function openQuickConnect(prefill = null) {
    const hostInput = document.getElementById('inp-host');
    const userInput = document.getElementById('inp-user');
    const passInput = document.getElementById('inp-pass');
    const authSelect = document.getElementById('auth-method');
    const keySelect = document.getElementById('inp-key-select');

    hostInput.value = prefill ? prefill.host : '';
    document.getElementById('inp-port').value = prefill ? String(prefill.port || 22) : '22';
    userInput.value = prefill ? prefill.username : '';
    // A recent one-off session comes back with the keep-alive it used
    const keepaliveInput = document.getElementById('inp-keepalive');
    keepaliveInput.value = String(prefill && prefill.keepalive != null
      ? normalizeKeepalive(prefill.keepalive) : DEFAULT_KEEPALIVE);
    authSelect.value = prefill && prefill.authType === 'key' ? 'key' : 'password';
    if (prefill && getKeyById(prefill.keyId)) keySelect.value = prefill.keyId;
    passInput.value = '';
    document.getElementById('inp-key-passphrase').value = '';
    hostInput.style.border = '';
    userInput.style.border = '';
    keepaliveInput.style.border = '';
    document.getElementById('quick-connect-error').classList.add('hidden');
    keySelect.classList.remove('error');
    updateQuickConnectAuthUI();

    quickConnectModal.classList.remove('hidden');
    // Start at the first thing left to fill in
    const next = !prefill ? hostInput
      : authSelect.value === 'password' ? passInput
        : keySelect.value ? document.getElementById('btn-connect') : keySelect;
    next.focus();
  }

  function closeQuickConnect() {
    quickConnectModal.classList.add('hidden');
    // Don't leave secrets sitting in the form
    document.getElementById('inp-pass').value = '';
    document.getElementById('inp-key-passphrase').value = '';
  }

  // The home view fills the terminal area whenever no tab is shown
  function setHomeVisible(visible) {
    document.getElementById('home-view').classList.toggle('hidden', !visible);
    if (visible) loadRecentConnections();
  }

  async function loadRecentConnections() {
    try {
      recentConnections = await window.electronAPI.getRecentConnections();
    } catch (e) {
      console.warn('Could not load recent connections', e);
      recentConnections = [];
    }
    renderRecentConnections();
  }

  // "just now", "5 min ago", "3 hr ago", "2 days ago", then the date
  function formatLastConnected(timestamp, now = Date.now()) {
    const minutes = Math.floor((now - timestamp) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    const date = new Date(timestamp);
    const options = { day: 'numeric', month: 'short' };
    if (date.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString(undefined, options);
  }

  // A saved host shows under its current name and address. One-off sessions,
  // and saved hosts deleted since, use what was recorded.
  function describeRecentConnection(entry) {
    const saved = entry.hostId ? allHosts.find((h) => h.id === entry.hostId) : null;
    if (saved) {
      return { saved, name: saved.name || saved.host, meta: `${saved.username}@${saved.host}:${saved.port || 22}` };
    }
    const address = `${entry.username}@${entry.host}:${entry.port || 22}`;
    return {
      saved: null,
      name: entry.name || entry.host,
      meta: entry.hostId ? `${address} · no longer saved` : `${address} · Quick Connect`
    };
  }

  function openRecentConnection(entry) {
    const saved = entry.hostId ? allHosts.find((h) => h.id === entry.hostId) : null;
    if (saved) createSession(buildConfigFromHost(saved), saved.name, saved.id);
    else openQuickConnect(entry);
  }

  function renderRecentConnections() {
    const list = document.getElementById('recent-list');
    if (!list || !recentConnections) return;
    list.innerHTML = '';
    document.getElementById('btn-clear-recent').classList.toggle('hidden', recentConnections.length === 0);

    if (recentConnections.length === 0) {
      list.innerHTML = '<div class="recent-empty"><strong>No recent connections yet</strong>'
        + 'Connect to a saved host, or use Quick Connect for a one-off session.</div>';
      return;
    }

    const now = Date.now();
    recentConnections.forEach((entry) => {
      const { saved, name, meta } = describeRecentConnection(entry);
      const row = document.createElement('div');
      row.className = 'recent-row';
      row.setAttribute('role', 'listitem');
      row.innerHTML = `
        <button class="recent-open" title="${escapeHtml(saved ? `Connect to ${name}` : 'Open in Quick Connect')}">
          <span class="recent-icon${saved ? '' : ' quick'}">${saved ? ICONS.server : ICONS.bolt}</span>
          <span class="recent-text">
            <span class="recent-name">${escapeHtml(name)}</span>
            <span class="recent-meta">${escapeHtml(meta)}</span>
          </span>
          <span class="recent-time" title="Last connected ${escapeHtml(new Date(entry.lastConnected).toLocaleString())}">${escapeHtml(formatLastConnected(entry.lastConnected, now))}</span>
        </button>
        <button class="recent-remove" title="Remove from recent connections" aria-label="Remove ${escapeHtml(name)} from recent connections">${ICONS.close}</button>
      `;
      row.querySelector('.recent-open').addEventListener('click', () => openRecentConnection(entry));
      row.querySelector('.recent-remove').addEventListener('click', async () => {
        recentConnections = await window.electronAPI.removeRecentConnection(entry.id).catch(() => recentConnections);
        renderRecentConnections();
      });
      list.appendChild(row);
    });
  }

  document.getElementById('quick-connect-btn').addEventListener('click', () => openQuickConnect());
  ['quick-connect-btn', 'home-quick-connect-btn'].forEach((id) => {
    document.getElementById(id).title = `Quick Connect (${QUICK_CONNECT_KEYS.join('+')})`;
  });
  document.getElementById('home-quick-connect-btn').addEventListener('click', () => openQuickConnect());
  document.getElementById('btn-quick-cancel').addEventListener('click', closeQuickConnect);
  // Enter anywhere in the form connects; a focused button keeps its own Enter
  quickConnectModal.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    document.getElementById('btn-connect').click();
  });
  document.getElementById('btn-clear-recent').addEventListener('click', async () => {
    recentConnections = await window.electronAPI.clearRecentConnections().catch(() => recentConnections);
    renderRecentConnections();
  });

  if (window.electronAPI.onOpenSettings) {
    // The Settings menu can ask for a specific page ('keys' or 'shortcuts')
    window.electronAPI.onOpenSettings((page) => openSettingsTab(page));
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
  quickConnectModal.addEventListener('mousedown', (e) => {
    if (e.target === quickConnectModal) closeQuickConnect();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The close/reload confirmation stacks on top of everything; Esc cancels
    if (!sessionLossModal.classList.contains('hidden')) settleSessionLoss(false);
    // A host key prompt sits above everything else; Esc means "don't trust it"
    else if (!hostKeyModal.classList.contains('hidden')) answerHostKeyPrompt('reject');
    else if (!modal.classList.contains('hidden')) modal.classList.add('hidden');
    else if (!groupModal.classList.contains('hidden')) closeGroupModal();
    else if (!quickConnectModal.classList.contains('hidden')) closeQuickConnect();
  });

  // Flag the body so the CSS can leave room for native window controls
  if (typeof window.electronAPI.getWindowChrome === 'function') {
    window.electronAPI.getWindowChrome().then((mode) => {
      if (!mode || mode === 'native') return;
      document.body.classList.add('frameless', mode);
    }).catch(() => { /* fall back to the default framed layout */ });
  }

  // Version beside the app name, from package.json
  if (typeof window.electronAPI.getAppVersion === 'function') {
    window.electronAPI.getAppVersion().then((version) => {
      if (!version) return;
      const label = document.getElementById('app-version');
      label.textContent = `v${version}`;
      label.classList.remove('hidden');
    }).catch(() => { /* leave the label hidden */ });
  }

  // initial load
  renderShortcutsPage();
  showSettingsPage('keys');
  syncClearSearchBtn();
  loadSSHKeys().finally(() => {
    updateQuickConnectAuthUI();
    // Hosts first, so saved hosts in the recent list show their names
    loadHosts().finally(loadRecentConnections);
  });

  // Keep "5 min ago" honest while the home view sits open
  setInterval(() => {
    if (!document.getElementById('home-view').classList.contains('hidden')) renderRecentConnections();
  }, 60000);
};
