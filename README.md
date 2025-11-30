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


