# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ElectroSSH is an Electron SSH client: `ssh2` for connections, `xterm.js` 6 for terminals. Plain JavaScript with no framework, bundler, or build step for development; addons load as UMD `<script>` tags straight from `node_modules`.

## Commands

```bash
npm install          # required after pulling; a checkout once had the xterm addons missing
npm start            # run the app
npm run pack         # unpacked build via electron-builder
npm run dist:win     # Windows installer + zip into dist/

npm test             # main-process tests, ~3s (node --test, no extra dependencies)
npm run test:slow    # the handshake-timeout test, ~25s
npm run test:e2e     # drives the real app in Electron; opens its window briefly per file
npm run test:all     # all three

node --test test/main/host-keys.test.js           # one main-process file
node test/e2e/run.js test/e2e/tab-close.e2e.js    # one e2e file
```

There is no linter or type checker. `node --check main.js renderer.js preload.js` catches syntax errors only: a renamed identifier still referenced elsewhere passes it and throws at runtime (this has happened), so grep for old names after a rename.

## Architecture

Three layers, with the security boundary between them (`contextIsolation: true`, `nodeIntegration: false`):

- **`main.js`**: the Electron main process. Owns the window and app menu, every SSH connection, the JSON stores, host key verification, and the close/reload guards.
- **`preload.js`**: exposes `window.electronAPI` via `contextBridge`. All renderer/main traffic goes through it, so a new IPC channel needs changes in all three files.
- **`renderer.js`**: the entire UI inside one `window.onload` closure (no modules): host tree, tabs and terminals, dialogs, settings. `index.html` is static markup; `styles.css` holds design tokens in `:root`.

**Sessions.** The renderer creates a `sessionId` and sends `ssh-connect`. `main.js` keeps `sessions[sessionId] = { conn, stream, size, appliedSize }` and streams back `ssh-data`, `ssh-status` and `ssh-error`. The renderer's `sessions[sessionId]` holds the `Terminal`, its addons, the tab element, the connection config, and `connected`.

**Persistence.** In Electron's `userData`: `saved_hosts.json` (`{ hosts, groups }`), `ssh_keys.json`, `recent_connections.json` (`{ entries }`), and `known_hosts.json` (`{ hosts: { "host:port": { <keyType>: { key, fingerprint, addedAt } } } }`). In renderer `localStorage`: `electrossh.collapsedGroups`, `electrossh.sidebarWidth`, `electrossh.fontSize`. Saved passwords are stored in clear text (see README).

**Window chrome.** `windowChromeMode()` uses `titleBarOverlay` on Windows, `hiddenInset` on macOS, and the native frame on Linux. The renderer fetches the mode over `window-chrome` and sets `body.frameless` plus `overlay-right`/`overlay-left`, which the CSS uses for drag regions and control spacing.

**The menu on Windows.** With the hidden title bar, Electron shows no menu bar on Windows at all: Alt does nothing and `setMenuBarVisibility(true)` doesn't show it either. Menu items are reachable there only through their accelerators (Ctrl+R, Ctrl+, …). Anything people need must also exist in the page. Settings > About carries the Help menu's links, from `app-info` (version, `REPO_URL`, runtime versions and the OS), plus a "Copy details" block for bug reports. The sidebar's version label opens it, as does Help > About ElectroSSH on macOS and Linux.

## Constraints that are easy to break

### xterm
- Keep the `@xterm/*` packages to one release set: `xterm` 6.0.0 with `addon-fit` 0.11.0, `addon-webgl` 0.19.0, `addon-search` 0.16.0, `addon-web-links` 0.12.0. The addons declare a stale `^5` peer range, but their internals target core 6 (pairing webgl 0.19 with core 5.5 breaks `WebglAddon.dispose()`). When upgrading, match versions by npm publish date, not by peer range.
- Search highlighting uses the decoration API, so terminals are created with `allowProposedApi: true`.
- `addon-search` 0.16 records new options before checking whether they changed, so an options-only change never recounts. The match-case/regex toggles call `clearDecorations()` first to force a fresh pass.
- `closeSession` disposes the WebGL addon and the terminal in separate `try` blocks, so a throwing addon can't leak the terminal.
- A hidden terminal can't measure its font. Zoom applies to the visible terminal; `switchTab` applies the pending size before fitting.

### SSH connection lifecycle (`ssh-connect` in `main.js`)
- ssh2's `readyTimeout` is `0`, replaced by a handshake timer (`HANDSHAKE_TIMEOUT_MS`) that pauses while a host key prompt is open. ssh2's own timer counts the time a person spends reading the prompt.
- On reconnect, the old connection's `end`/`close` events arrive after the new one has taken the same session id. Handlers act only when `isCurrent()` is true — the shell stream's `data`/`close`/`exit` handlers and the `ready` and shell-open callbacks included. A late `close` from the old stream once reported "Closed" on the new tab and deleted the new session, and the reconnect then failed without a word.
- `Connected` is sent once the shell has opened, not at `ready`, and `term-input` with no stream is dropped silently. Keys typed in between used to come back as `ssh-error`, which marked a working tab disconnected.
- Output is decoded with one `StringDecoder` per stream. SSH splits packets at arbitrary bytes, and decoding chunk by chunk turned a character cut in two into `��`.
- Every message to the page goes through `sendToPage()`, which checks the webContents still exists. A session outlives its window — channels close and errors arrive after the page is gone — and Electron throws on a send to a destroyed webContents. That exception is uncaught in main, so it puts up the "A JavaScript error occurred in the main process" dialog, which blocks the app and, under the e2e harness, looks exactly like a hung test.
- Resizes are never dropped. A `term-resize` that arrives before the shell exists is stored and applied by `applyWindowSize()` when the stream opens (dropping them made htop draw short). The renderer also re-syncs size on `Connected`.
- ssh2 re-runs the host verifier on every rekey. `acceptedHostKey` stops "Connect Once" from prompting again mid-session.
- Keepalive: `normalizeKeepalive()` exists in both `main.js` and `renderer.js`; keep them identical. Default 5s, `0` disables, max 3600. The host dialog and Quick Connect both validate their keep-alive box with `parseKeepaliveInput()` in `renderer.js` (empty means the default; anything else must be a whole number in range).

### Sign-in questions (passphrases, keyboard-interactive)
- `loadPrivateKey()` asks for a key's passphrase through an `auth-prompt` (`kind: 'passphrase'`) when the key is encrypted and none was given, or the given one is wrong: up to `MAX_PASSPHRASE_ATTEMPTS` (3). It runs before `conn.connect`, so cancelling sends nothing to the server. Saved hosts have no passphrase field; this is how their encrypted keys work at all. The passphrase is never written to disk; the renderer keeps it on the tab's `config` so Reconnect doesn't ask again.
- `tryKeyboard` is on. In the `keyboard-interactive` handler, a server asking only for a password gets the saved password, once; anything else (a one-time code, a second factor) becomes an `auth-prompt` (`kind: 'keyboard-interactive'`), and the handshake timer pauses while it waits. Cancelling ends the connection with an `ssh-error`.
- Prompt text, titles and instructions come from the server: the renderer sets them only as text. `echo: false` inputs are password fields.
- `cancelPrompts()` cancels a session's host key and sign-in prompts together; use it wherever a session goes away.
- The renderer queues sign-in questions across tabs, like host key prompts. The auth modal sits before the host key modal in the DOM, so a host key prompt stacks above it; Esc cancels (order: close/reload confirmation, host key, sign-in, then the rest).

### Host keys
- Trust-on-first-use, keyed per `host:port` and per key type. Statuses are `unknown`, `changed` (red warning) and `new-key-type` (amber, e.g. RSA to Ed25519 after an upgrade).
- The key type string comes from the server and is used as a property name, so `describeHostKey()` restricts it to `[A-Za-z0-9@.+-]`. The raw key blob never goes to the renderer.
- The renderer queues prompts across tabs, and focuses the dialog rather than a button so a stray Enter can't accept a key.

### Links
- Terminal output is written by the remote host. `open-external` in `main.js` opens only `http:`/`https:`, because `shell.openExternal` launches any registered protocol handler.
- The window denies `window.open` (`setWindowOpenHandler`) and blocks `will-navigate`. OSC 8 hyperlinks go through the Terminal's `linkHandler`, whose hover text is the real target. Opening a link needs Ctrl+click (Cmd on macOS) because a plain click selects.

### Keyboard
- Plain Ctrl+C/V/F belong to the remote shell; the app uses Ctrl+Shift+C/V/F (Cmd on macOS).
- Zoom, find and Quick Connect (Ctrl+Shift+N; Cmd+N on macOS) are handled in a capture-phase `keydown` on `window`, so xterm never sees them; otherwise Ctrl+- would also send `^_`. Find and Quick Connect do nothing while a dialog is open. The key list for Quick Connect is `QUICK_CONNECT_KEYS`, shared by the shortcuts page and the buttons' tooltips.
- Menu accelerators fire only when xterm doesn't consume the key. With the terminal focused, Ctrl+W and Ctrl+R reach the shell; with focus elsewhere they hit the menu.
- `SHORTCUT_GROUPS` in `renderer.js` is a hand-maintained reference rendered on the Settings > Keyboard Shortcuts page. Update it whenever a binding changes. "Show the menu bar (Alt)" is listed only on Linux (`IS_LINUX`), the one platform where it works.

### Closing and reloading
- macOS keeps the app running after its window closes; the `activate` handler (registered once the app is ready, since `activate` can fire during launch) opens a new window when there is none. `reopen-window.e2e.js` emits the event by hand, so it runs on every platform.
- The window `close` handler asks while SSH sessions are open, which covers Ctrl+W, the title bar button, Alt+F4 and Quit. Reload and Force Reload are custom menu items that go through `reloadWindow()`, not the built-in roles. `did-start-loading` disconnects any sessions left by the page being replaced (a reload used to leave authenticated shells running).
- `confirmSessionLoss()` shows an in-app dialog, which must acknowledge within `SESSION_LOSS_ACK_MS` (1.5s); otherwise a native dialog is used. The close path must never depend on the renderer alone, or a hung or crashed page makes the window impossible to close.
- In the renderer, `askSessionLoss()` shows one question at a time; a new question replaces the old one, which resolves as Cancel. Closing a tab (`requestCloseSession`) asks only when `session.connected` is true.

### Connection dots
- A tab's dot is amber and pulsing while connecting (`.connecting`, set in `createSession` and by Reconnect through `setTabConnecting()`), green once the shell opens, red once the session drops (`.disconnected`). `setTabConnected()` clears `.connecting` and refreshes the tree.
- A saved host's dot in the tree is green only while one of its tabs is live (`session.connected`), not merely open.

### Recent connections and Quick Connect
- `main.js` records a connection on ssh2's `ready` (`recordRecentConnection()`), so failed attempts never appear, and keeps the newest 10. Entries are built from a fixed set of fields, so a password, passphrase or key path can't reach the file. The keep-alive is among them, so reopening a one-off session restores it; entries written before that have none, and fall back to the default.
- The renderer sends `hostId` with `ssh-connect`. A saved host's entry follows it by id: the home view shows its current name, and a click reconnects it. One-off entries, and saved hosts deleted since, reopen Quick Connect filled in (keep-alive included), because their passwords were never stored.
- Quick Connect is a modal (`#quick-connect-modal`) opened by the lightning buttons in the sidebar and on the home view. The home view (`#home-view`) is shown through `setHomeVisible()` whenever no tab is, and reloads the list each time.

### Host right-click menu and the clipboard
- Right-clicking a saved host opens `#host-context-menu`, an in-page menu (not a native one) built by `openHostMenu()`. It copies the address ("Copy IP address", or "Copy hostname" for a DNS name), the display name or the SSH port, and leaves a brief "Copied …" note. Shift+F10 and the Menu key open it from the host row's `keydown`.
- Copying goes through main's `clipboard-write` (Electron's `clipboard`), because `navigator.clipboard.writeText` refuses while the window isn't focused. `writeClipboardText()` resolves true only once the text is on the clipboard. Reading for right-click paste goes through `clipboard-read` for the same reason.

### Paste
- Right-click paste reads the clipboard and calls `term.paste()`, which turns line endings into `\r` and, when the remote program has turned on bracketed paste (bash, zsh, vim), wraps the text so a multi-line paste arrives as one block instead of running line by line. Never write pasted text to the stream directly.
- Ctrl+Shift+V (Cmd+V) is left to the browser's native paste event, which xterm handles itself. The key handler returns `false` only so the keystroke doesn't reach the shell; pasting there as well pasted everything twice.

### Groups
- `readHostStore()` re-creates the `default` group whenever it is missing, so it can't be deleted. `delete-group` refuses groups that still have hosts; this is enforced in `main.js`, not only by the disabled button.

### Icons
- All icons are inline SVG with [Lucide](https://lucide.dev) shapes on Lucide's `0 0 24 24` grid, `fill="none"`, `stroke="currentColor"`, round caps and joins. No icon library or font is loaded.
- Stroke width follows the display size so every icon reads at the same weight: 12 → 2.9, 14 → 2.5, 16 → 2.2, 18 → 1.9, 32 → 1.1 (the About page's logo). `ICON_STROKE` and the `icon()` helper in `renderer.js` apply this; `index.html` spells it out per SVG.
- The sidebar's collapse-all toggle uses `list-collapse`/`list-tree` rather than Lucide's `chevrons-down-up`, whose converging chevrons read as an X at 16px. `updateToggleAllButton()` swaps it with the state.
- A few icons exist in both `index.html` and the `ICONS` map (the bolt, the ×, the plus): keep them in step.

## Quirks

- Working-tree files use CRLF (git autocrlf). Scripted string replacements must match `\r\n`.
- `main.js` indents its IPC section as though it were nested, but it is module-level; functions declared there are callable from `createWindow`.
- The version beside the app name in the sidebar comes from `package.json` (the `app-version` IPC channel), so a release only needs the bump there. It is a button that opens Settings > About. `main.js` reads `package.json` itself because `app.getVersion()` reports Electron's version under the e2e harness.

## Verifying changes

- **`test/main/`** (`npm test`): `test/helpers/main-harness.js` stubs `electron` through `Module._load`, loads a fresh `main.js` against a temporary `userData`, and calls the captured `ipcMain` handlers directly. `test/helpers/ssh-server.js` wraps ssh2's `Server` as a local SSH endpoint with a host key the test controls, and records pty sizes, window changes and connections accepted. It accepts any login by default; its `authenticate` option makes it a keyboard-interactive, two-factor or key-only server.
- **`test/e2e/`** (`npm run test:e2e`): `run.js` starts one Electron process per `*.e2e.js` file. `harness.js` repoints `BrowserWindow.prototype.loadFile` at the project, loads `main.js`, drives the page with `webContents.sendInputEvent`, inspects it with `executeJavaScript`, and scripts `dialog.showMessageBox`. Each check prints as soon as it's known, so a hung file shows how far it got.
- **Checking that a test catches a bug:** set `ELECTROSSH_MAIN` to another build of `main.js` (e.g. one taken from an older commit), saved in the project root so it finds `preload.js`. Both harnesses load it instead of `main.js`.

Limits of synthetic input in the e2e tests:

- Keys and clicks aimed at the page are reliable. Keys that only work by reaching the application menu (Ctrl+W/Ctrl+R with focus outside the terminal) are not delivered consistently, so tests trigger the menu item or `win.close()` directly and assert the accelerator strings separately.
- Pointer moves from `sendInputEvent` don't reach xterm's link hover detection; `links.e2e.js` dispatches a DOM `mousemove` instead. Clicks do work.
- `executeJavaScript` on a destroyed webContents never settles. The harness's `js()` refuses up front and times out.
- With no windows left, the test process's event loop can stall, e.g. after `forcefullyCrashRenderer()` and a window close. The harness keeps a hidden spare window. `app.quit()` closes that spare too, so quitting tests call `keepAlive()` to put it back.
- A crashed renderer freezes the main process while Windows deals with the crash: timers stop firing for anything from two seconds to past the runner's timeout (18s and 12s have both been measured), so a passing test can look hung. Disabling crash dumps (`disable-breakpad` in the harness) keeps dumps out of the temp directories but does not reliably shorten the freeze. What covers it: `waitFor()` takes a final look after its deadline, and `run.js` re-runs a file that timed out without failing a check.

`host-menu.e2e.js` and `paste.e2e.js` use the real system clipboard, since that is what the features do. They save the clipboard before they run and put it back afterwards.

A test server that accepts any login can hide a broken auth path: a host whose key the page doesn't know silently falls back to password auth, and such a server lets it in. Tests of key or keyboard-interactive login use `authenticate` to accept only that method.

Scratch scripts run under Electron (screenshots, one-off probes) need absolute paths to the project's modules, and a `process.on('uncaughtException')` that logs and exits; otherwise an error opens a modal dialog on the desktop. `capturePage()` on a window behind others can return a stale frame, so bring it to the front and call `webContents.invalidate()` before capturing.

**Renderer only** (no test in the repo): serve the project directory and inject a stub `window.electronAPI` before `renderer.js` loads.

## History

The original app was built with Gemini. Since then (details in `git log`):

- **UI:** redesigned UI with a collapsible host tree and a resizable sidebar; group rename and delete.
- **SSH behaviour:** per-host keepalive; fix for pty sizes dropped during the handshake; host key verification; passphrase prompts for encrypted keys; keyboard-interactive and two-factor login.
- **Review fixes:** bracketed paste and the Ctrl+Shift+V double paste; UTF-8 split across packets; the reconnect race; input before the shell opened; connection dots; reopening the window on macOS; the Help menu.
- **Terminal:** migration to the `@xterm/*` 6 packages; clickable links, find, and font zoom.
- **Settings and safety:** keyboard shortcuts page; confirmation before closing or reloading the app, or closing a connected tab.
- **Home:** recent connections on the home view; Quick Connect moved to a dialog behind a lightning button, with its own keep-alive setting; app version beside the name.
- **Copying:** right-click menu on a saved host for its address, display name or SSH port, copied through Electron's clipboard in main.
