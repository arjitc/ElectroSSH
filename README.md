# ElectroSSH
Electron powered SSH application with Tabs and SSH Key support

> [!WARNING]
> Passwords saved into the application are saved in clear-text currently. Please use with caution.

What works:

- [x] Modern dark UI with a collapsible host tree in the sidebar
- [x] Adding Hosts
- [x] Editing Hosts
- [X] Deleting Hosts
- [X] Adding Groups/Categories
- [x] Renaming Groups/Categories (pencil icon in the sidebar, or F2)
- [x] Deleting Groups/Categories (only when the group has no hosts under it)
- [x] Searching Hosts 
- [X] SSH Keys
- [x] Host key verification: asks before trusting a new server, and warns loudly if a known server's key changes
- [X] Right click to paste (or Ctrl+Shift+V)
- [x] Left click select to copy (or Ctrl+Shift+C)
- [x] Clickable links in terminal output: Ctrl+click (Cmd+click on macOS) opens http/https links in your browser
- [x] Find in terminal: Ctrl+Shift+F (Cmd+F on macOS), with match case and regex options
- [x] Terminal font size: Ctrl+= / Ctrl+- / Ctrl+0, or Ctrl+mouse wheel (remembered between sessions)
- [x] Keyboard shortcuts reference in Settings (also under the Settings menu)
- [x] Reconnect option when connection disconnects
- [x] Closing or reloading the app asks for confirmation while SSH sessions are open
- [x] SSH Keepalive for NAT/CGNAT users (per-host, defaults to every 5 seconds, set 0 to disable)
- [x] Color supported in the console (for htop etc)
- [x] Collapse/expand hosts listed under a Group/Category (state is remembered)
- [x] Resizable sidebar

What doesn't work/needs work (contributors welcome!):

- [ ] Encrypting passwords saved
- [ ] Dark/Light Mode Themes
- [ ] Auto save console log to file on connection
- [ ] Ability to sort the order of the Group/Categories
- [ ] Ability to pin/star/favourite a Group/Category to the top of the list

## Terminal engine

The terminal is [xterm.js](https://github.com/xtermjs/xterm.js) 6 (`@xterm/xterm`) with the fit and WebGL addons. The unscoped `xterm`/`xterm-addon-*` packages it used previously are deprecated.

## Building/Installing the application

> [!TIP]
> This is required only if building the latest version of the application off GitHub or if there's no build available for your operating system


```
npm install
```

```
npm run dist:win
```

## Running the application from source

Required only the first time

```
npm install
```

and then,

```
npm start
```

## Running the tests

```
npm test            # main-process tests (a few seconds)
npm run test:slow   # the handshake-timeout test (about 25 seconds)
npm run test:e2e    # end-to-end tests; the app window opens briefly for each file
npm run test:all    # everything
```

The tests run against local SSH servers they start themselves, so no network access or real host is needed.

## Screenshots

### Interface on first load

<img width="2474" height="1737" alt="image" src="https://github.com/user-attachments/assets/8d676076-3f48-490a-8ace-81afe1cc7e87" />


### Creating Groups (Categories) for Hosts

<img width="2474" height="1737" alt="image" src="https://github.com/user-attachments/assets/544d1f06-b180-48c9-816f-50cb7b7d17df" />


### Adding Hosts

<img width="3840" height="2280" alt="image" src="https://github.com/user-attachments/assets/323641ea-111b-4994-80a0-9f3d41dae306" />


### Connecting to a Host

Double click to launch the session

<img width="3840" height="2280" alt="image" src="https://github.com/user-attachments/assets/067a237b-297b-4c38-bc0f-47de238b1c00" />


### Editing or Deleting a Host

<img width="3840" height="2280" alt="image" src="https://github.com/user-attachments/assets/0c3d9392-c9a1-429a-85a0-c9be66c14c72" />


