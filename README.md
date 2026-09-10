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
- [X] Right click to paste (or Ctrl+Shift+V)
- [x] Left click select to copy (or Ctrl+Shift+C)
- [x] Reconnect option when connection disconnects
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

## Screenshots

### Interface on first load


### Creating Groups (Categories) for Hosts


### Adding Hosts



### Connecting to a Host

Double click to launch the session



### Editing or Deleting a Host



