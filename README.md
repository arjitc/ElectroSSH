# ElectroSSH
Electron powered SSH application with Tabs and SSH Key support

> [!WARNING]
> Passwords saved into the application are saved in clear-text currently. Please use with caution.

What works:

- [x] Adding Hosts
- [x] Editing Hosts
- [X] Deleting Hosts
- [X] Adding Groups/Categories
- [x] Searching Hosts 
- [X] SSH Keys
- [X] Right click to paste
- [x] Left click select to copy
- [x] Reconnect option when connection disconnects
- [x] SSH Keepalive for NAT/CGNAT users (hardset to every 15 seconds -- see below)
- [x] Color supported in the console (for htop etc) 

What doesn't work/needs work (contributors welcome!):

- [ ] Editing Group/Category Names
- [ ] Encrypting passwords saved
- [ ] Dark/Light Mode Themes
- [ ] Option to edit SSH Keepalive from default 15 second to user defined option
- [ ] Auto save console log to file on connection
- [ ] Ability to sort the order of the Group/Categories
- [ ] Ability to pin/star/favourite a Group/Category to the top of the list
- [ ] Ability to collapse/expand hosts listed under a Group/Category (to avoid the sidebar becoming way too long)

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



