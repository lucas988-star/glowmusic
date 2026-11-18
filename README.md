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

**Status:** Milestone 1 (login + now playing) is done. Colours, progress bar,
controls, up next, lyrics and the wallpaper/screen saver modes are coming next.

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
3. URL: `https://lucas988-star.github.io/glowmusic/`
4. To log in the first time, turn on **Browsing Mode** in the Plash menu,
   click **Log in with Spotify**, then turn Browsing Mode off again.
   Plash remembers the login.

*(A dedicated `?mode=wallpaper` that hides buttons and the cursor arrives in Milestone 6.)*

## 4. Use it as your screen saver (WebViewScreenSaver)

Coming in Milestone 6 (needs a special "screen saver link").

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

**Nothing shows up**
Glowstick shows only the clock when nothing is playing. Start playback in any
Spotify app on any device. Private sessions and ads also show the clock.

**Opened `index.html` by double-clicking**
That won't work — use the local server in step 1 or the GitHub Pages address.
