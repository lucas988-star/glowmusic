# Glowstick

A full-screen, glowing "lock screen" that shows what you're playing on Spotify.
Made to run as a Mac desktop wallpaper (with **Plash**) and as a screen saver
(with **WebViewScreenSaver**).

Plain HTML + CSS + JavaScript. No server, no build step, no client secret:
login uses Spotify's *Authorization Code with PKCE* flow in the browser.

| File | What it does |
| --- | --- |
| `index.html` | The page layout |
| `style.css` | The look (glass, glow, animations) |
| `app.js` | Spotify login, polling and everything that moves |

**Features:** clock, current song with big cover, glow in the cover's colour,
live progress bar, play/pause/previous/next (Spotify Premium), "Up next" panel,
synced lyrics (from [LRCLIB](https://lrclib.net)), a soft lava-lamp edge glow that grows when the song gets bigger
(tempo from [ReccoBeats](https://reccobeats.com)), wallpaper and screen saver modes.

Buttons at the top right: **Up next** and **Lyrics** turn the panels on/off
(remembered), **Screen saver link** is explained in section 4.

---

## 1. Run it on your Mac

1. Open **Terminal** and go to this folder, for example:
   ```bash
   cd ~/Documents/Glowdeck/glowmusic
   ```
2. Start a tiny local web server:
   ```bash
   python3 -m http.server 8000 --bind 127.0.0.1
   ```
3. Open **http://127.0.0.1:8000/** in your browser (use `127.0.0.1`, not
   `localhost` — Spotify doesn't accept `localhost`).
4. Click **Log in with Spotify** and accept.
5. Play something in Spotify. It shows up within about 3 seconds.

Stop the server with **Ctrl + C** in Terminal.

## 2. Put it on GitHub Pages

The site lives at **https://lucas988-star.github.io/glowmusic/**.

One-time setup: on GitHub open the repo → **Settings** → **Pages** →
under *Build and deployment* choose **Deploy from a branch**, branch **main**,
folder **/ (root)** → **Save**.

After that, every push to `main` updates the site within a minute or two.

Make sure this exact address is listed as a Redirect URI in your Spotify app
(see Troubleshooting):
`https://lucas988-star.github.io/glowmusic/`

## 3. Use it as your desktop wallpaper (Plash)

1. Install **Plash** from the Mac App Store.
2. Click the Plash icon in the menu bar → **Add Website**.
3. URL: `https://lucas988-star.github.io/glowmusic/?mode=wallpaper`
4. To log in the first time, turn on **Browsing Mode** in the Plash menu,
   click **Log in with Spotify**, then turn Browsing Mode off again.
   Plash remembers the login.

In wallpaper mode the buttons and cursor fade out after 3 seconds without
mouse movement. With Browsing Mode on, move the mouse and they come back —
everything is clickable.

## 4. Use it as your screen saver (WebViewScreenSaver)

The screen saver has its own separate storage, so it can't reuse your Plash or
browser login, and you can't click "Log in" in a screen saver. Instead you give
it a link that already contains your login:

1. Install **WebViewScreenSaver** (e.g. `brew install --cask webviewscreensaver`,
   or download it from its GitHub page), then open
   **System Settings → Screen Saver** and pick **WebViewScreenSaver**.
2. Open Glowstick in your browser (logged in). Set **Up next** / **Lyrics** the
   way you want them in the screen saver.
3. Click **Screen saver link** (top right). The link is copied.
4. In the screen saver's **Options…**, add/replace the address with that link.

> ⚠️ **This link is like a password.** Anyone who has it can see and control
> your Spotify playback. Never share it, post it or put it in this repo.
> If it ever leaks: spotify.com → Account → *Manage apps* → remove access, then
> log in again and make a new link.

If the screen saver later shows "Not logged in", make a new link the same way.

---

## Troubleshooting

**"INVALID_CLIENT: Invalid redirect URI" / redirect URI mismatch**
Go to <https://developer.spotify.com/dashboard> → your app → **Settings** →
**Redirect URIs**. The address in your browser must match one of these
*exactly*, including the trailing `/`:
- `http://127.0.0.1:8000/`
- `https://lucas988-star.github.io/glowmusic/`

If you use another port, add that one too (e.g. `http://127.0.0.1:5500/`).

**"User not registered in the Developer Dashboard" / 403 errors**
New Spotify apps are in *Development mode*: only accounts you add can use them.
Dashboard → your app → **Settings** → **User Management** → add the name and
e-mail of every Spotify account that should log in.

**401 errors / suddenly back on the login screen**
The login expired or was revoked (for example at
spotify.com → Account → *Manage apps*). Just log in again.

**"Spotify asked us to slow down" (429)**
Too many requests (often because the page is open in several places at once).
Glowstick waits as long as Spotify asks, then continues by itself.

**"No active Spotify device" when pressing a button**
Spotify needs a device that is playing (or was just playing). Start a song in
the Spotify app first. Controls need Spotify Premium.

**"You'll have to sing on this one"**
Lyrics come from LRCLIB, a free community database. Some songs aren't there.

**Nothing shows up**
Glowstick shows only the clock when nothing is playing. Start playback in any
Spotify app on any device. Private sessions and ads also show the clock.

**Opened `index.html` by double-clicking**
That won't work — use the local server in step 1 or the GitHub Pages address.
