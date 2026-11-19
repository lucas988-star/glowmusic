/* Glowstick — Spotify "now playing" desktop.
 * Plain JavaScript, no libraries. Login uses Spotify's Authorization Code
 * flow with PKCE, so no server and no client secret are needed.
 * Tokens are never written to the console.
 */
'use strict';

// ---------------------------------------------------------------- settings
const CONFIG = {
  clientId: '8a933ac9632f4b278e3bdf9070fbe161',
  scopes: 'user-read-currently-playing user-read-playback-state user-modify-playback-state',
};
const POLL_PLAYING_MS = 3000;
const POLL_IDLE_MS = 10000;
const PAUSED_TO_IDLE_MS = 5 * 60 * 1000; // paused this long → show the idle clock
const REFRESH_EARLY_MS = 2 * 60 * 1000;  // refresh the token 2 min before it expires
const DEFAULT_ACCENT = '#aaff59';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const LRCLIB_URL = 'https://lrclib.net/api';

// The page's own address (without file name / query) is the redirect URI:
// http://127.0.0.1:8000/  or  https://lucas988-star.github.io/glowmusic/
const REDIRECT_URI = location.origin + location.pathname.replace(/[^/]*$/, '');

const KEY = {
  tokens: 'glowstick.tokens',
  verifier: 'glowstick.pkce_verifier',
  state: 'glowstick.pkce_state',
  returnQuery: 'glowstick.return_query',
  upnext: 'glowstick.show_upnext',
  lyrics: 'glowstick.show_lyrics',
};

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const els = {
  screen: $('screen'),
  date: $('date'),
  time: $('time'),
  covers: [$('cover0'), $('cover1')],
  bgs: [$('bg0'), $('bg1')],
  ptitle: $('ptitle'),
  partist: $('partist'),
  fill: $('fill'),
  knob: $('knob'),
  elapsed: $('elapsed'),
  total: $('total'),
  prevBtn: $('prevBtn'),
  playBtn: $('playBtn'),
  nextBtn: $('nextBtn'),
  queue: $('queue'),
  lyrwin: $('lyrwin'),
  lyrlist: $('lyrlist'),
  upnextToggle: $('upnextToggle'),
  lyricsToggle: $('lyricsToggle'),
  copyLink: $('copyLink'),
  login: $('login'),
  loginBtn: $('loginBtn'),
  loginMsg: $('loginMsg'),
  status: $('status'),
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full/blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

class AuthError extends Error {}   // login is invalid → show login screen
class NetError extends Error {}    // offline / Spotify unreachable → keep last track

let MODE = 'normal'; // 'normal' | 'wallpaper' | 'screensaver' (set in boot)

// ---------------------------------------------------------------- PKCE login
function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function startLogin() {
  els.loginBtn.disabled = true;
  const verifier = randomString(64);
  const state = randomString(16);
  store.set(KEY.verifier, verifier);
  store.set(KEY.state, state);
  store.set(KEY.returnQuery, location.search); // keep e.g. ?mode=wallpaper
  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: CONFIG.scopes,
    code_challenge_method: 'S256',
    code_challenge: await sha256Base64Url(verifier),
    state,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

// Spotify sends us back to ?code=…&state=…  (or ?error=…)
async function handleLoginRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;

  const expectedState = store.get(KEY.state);
  const verifier = store.get(KEY.verifier);
  const returnQuery = store.get(KEY.returnQuery) || '';
  store.del(KEY.state);
  store.del(KEY.verifier);
  store.del(KEY.returnQuery);
  // Remove ?code=… from the address bar right away.
  history.replaceState(null, '', location.pathname + returnQuery + location.hash);

  const error = params.get('error');
  if (error) throw new AuthError(error === 'access_denied' ? 'Login was cancelled.' : `Spotify said: ${error}`);
  if (!verifier || params.get('state') !== expectedState) {
    throw new AuthError('That login link expired — please try again.');
  }
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  saveTokens(data);
}

// Screen saver link: …#rt=<refresh token>. Store it, then wipe it from the address bar.
function takeTokenFromHash() {
  const rt = new URLSearchParams(location.hash.slice(1)).get('rt');
  if (!rt) return;
  store.set(KEY.tokens, { refresh_token: rt, access_token: '', expires_at: 0 });
  history.replaceState(null, '', location.pathname + location.search);
}

async function tokenRequest(body) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.clientId, ...body }),
    });
  } catch {
    throw new NetError('offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      throw new AuthError(data.error_description || data.error || 'Login failed.');
    }
    throw new NetError(`token endpoint ${res.status}`);
  }
  return data;
}

// ---------------------------------------------------------------- tokens
let refreshTimer = null;
let refreshing = null;

function getTokens() { return store.get(KEY.tokens); }

function saveTokens(data) {
  const old = getTokens() || {};
  store.set(KEY.tokens, {
    access_token: data.access_token,
    // Spotify sometimes returns a new refresh token; otherwise keep the old one.
    refresh_token: data.refresh_token || old.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  });
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const t = getTokens();
  if (!t) return;
  const wait = Math.max(5000, t.expires_at - Date.now() - REFRESH_EARLY_MS);
  refreshTimer = setTimeout(() => {
    refreshTokens().catch((e) => {
      if (e instanceof AuthError) logout('Your Spotify login expired. Please log in again.');
      else refreshTimer = setTimeout(scheduleRefresh, 30000); // offline: try again soon
    });
  }, wait);
}

function refreshTokens() {
  if (!refreshing) {
    refreshing = (async () => {
      const t = getTokens();
      if (!t || !t.refresh_token) throw new AuthError('Not logged in.');
      saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function getAccessToken() {
  const t = getTokens();
  if (!t || !t.refresh_token) throw new AuthError('Not logged in.');
  if (!t.access_token || Date.now() > t.expires_at - 60000) await refreshTokens();
  return getTokens().access_token;
}

// ---------------------------------------------------------------- Spotify API
async function apiFetch(path, options, token) {
  try {
    return await fetch(API_URL + path, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new NetError('offline');
  }
}

async function api(path, options = {}) {
  let res = await apiFetch(path, options, await getAccessToken());
  if (res.status === 401) {               // token rejected → refresh once and retry
    await refreshTokens();
    res = await apiFetch(path, options, getTokens().access_token);
    if (res.status === 401) throw new AuthError('Spotify rejected the login.');
  }
  return res;
}

// ---------------------------------------------------------------- polling
let pollTimer = null;
let polling = false;
let lastPlayingAt = Date.now();

async function poll() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  let delay = POLL_PLAYING_MS;
  try {
    const res = await api('/me/player/currently-playing?additional_types=track,episode');
    if (res.status === 204) {
      showIdle();
      delay = POLL_IDLE_MS;
    } else if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After'), 10);
      delay = (Number.isFinite(retry) ? retry : 10) * 1000;
      setStatus('Spotify asked us to slow down — waiting a moment');
    } else if (res.status === 403) {
      setStatus('Spotify refused access (403) — see README → Troubleshooting');
      delay = 30000;
    } else if (res.ok) {
      setStatus('');
      const data = await res.json();
      if (data && data.item) {
        if (data.is_playing) lastPlayingAt = Date.now();
        if (!data.is_playing && Date.now() - lastPlayingAt > PAUSED_TO_IDLE_MS) showIdle();
        else showTrack(data);
        delay = POLL_PLAYING_MS; // also while paused, so play/pause from the keyboard shows up fast
        // Check again right when the song should end, so the next one appears quickly.
        if (data.is_playing && data.item.duration_ms) {
          delay = Math.min(delay, Math.max(500, data.item.duration_ms - data.progress_ms + 400));
        }
      } else {
        showIdle(); // e.g. an ad or a private session
        delay = POLL_IDLE_MS;
      }
    } else {
      delay = POLL_IDLE_MS; // 5xx: Spotify hiccup, keep showing what we have
    }
  } catch (e) {
    polling = false;
    if (e instanceof AuthError) { logout('Your Spotify login expired. Please log in again.'); return; }
    setStatus('Offline — showing the last track');
    delay = POLL_IDLE_MS;
  }
  polling = false;
  // Hidden page: check rarely (some wallpaper apps report "hidden" even when you can see it).
  pollTimer = setTimeout(poll, document.hidden ? Math.max(delay, 10000) : delay);
}

function stopPolling() {
  clearTimeout(pollTimer);
  clearTimeout(refreshTimer);
}

// ---------------------------------------------------------------- view
const view = { track: null, artUrl: null, front: 0, hasText: false };
// Where playback was at the last poll; the progress bar extrapolates from it.
const playback = { id: null, progressMs: 0, durationMs: 0, isPlaying: false, at: 0 };

function setScreenState(state) {
  const s = els.screen.classList;
  ['boot', 'login', 'idle', 'playing', 'paused'].forEach((c) => s.toggle(`is-${c}`, c === state));
}

let flashUntil = 0;
function setStatus(text) {
  if (!text && Date.now() < flashUntil) return; // let a short message finish
  if (text) els.status.textContent = text;
  els.status.classList.toggle('on', Boolean(text));
}
function flash(text) {
  flashUntil = Date.now() + 4000;
  setStatus(text);
  setTimeout(() => setStatus(''), 4100);
}

function showLogin(message = '') {
  stopPolling();
  setScreenState('login');
  els.login.hidden = false;
  els.loginBtn.disabled = false;
  els.loginMsg.textContent = MODE === 'screensaver'
    ? 'Not logged in. In your browser, open Glowstick and click "Screen saver link" (see README).'
    : message;
  setStatus('');
}

function logout(message) {
  store.del(KEY.tokens);
  showLogin(message);
}

function showIdle() {
  setScreenState('idle');
  view.track = null;
  playback.id = null;
  playback.isPlaying = false;
  els.playBtn.classList.remove('playing');
  setSnow(false);
}

function showTrack(data) {
  const item = data.item;
  const isEpisode = item.type === 'episode';
  const artists = isEpisode ? [(item.show && item.show.name) || ''] : (item.artists || []).map((a) => a.name);
  const images = isEpisode ? (item.images && item.images.length ? item.images : item.show && item.show.images) : item.album && item.album.images;
  const track = {
    id: item.id || item.uri,
    name: item.name || '',
    artist: artists.join(', '),
    firstArtist: artists[0] || '',
    album: isEpisode ? '' : (item.album && item.album.name) || '',
    durationMs: item.duration_ms || 0,
    isEpisode,
  };

  Object.assign(playback, {
    id: track.id,
    progressMs: data.progress_ms || 0,
    durationMs: track.durationMs,
    isPlaying: Boolean(data.is_playing),
    at: performance.now(),
  });
  els.playBtn.classList.toggle('playing', playback.isPlaying);
  setScreenState(data.is_playing ? 'playing' : 'paused');

  if (!view.track || track.id !== view.track.id) {
    view.track = track;
    const sub = track.album ? `${track.artist}  ·  ${track.album}` : track.artist;
    setTrackText(track.name, sub);
    songChanged();
    setSnow(isChristmas(track));
    loadTempo(track);
    els.total.textContent = formatTime(track.durationMs);
    if (prefs.upnext) loadQueue();
    loadLyrics(track); // even when hidden: choruses drive the glow
  }
  setArt(images && images[0] ? images[0].url : null);
}

function setTrackText(title, subtitle) {
  els.ptitle.textContent = title;
  els.partist.textContent = subtitle;
}

// Crossfade: load the new image into the hidden layer, then fade it in on top.
let artToken = 0;
let artCleanup = null;
async function setArt(url) {
  if (url === view.artUrl) return;
  view.artUrl = url;
  const token = ++artToken;
  const back = 1 - view.front;
  const layers = [els.covers[back], els.bgs[back]];
  if (!url) {
    [...els.covers, ...els.bgs].forEach((el) => el.classList.remove('show'));
    setAccent(null);
    glow.target = DEFAULT_PALETTE;
    return;
  }
  layers.forEach((el) => { el.src = url; });
  await Promise.all(layers.map((el) => el.decode().catch(() => {})));
  if (token !== artToken) return; // a newer track arrived meanwhile

  const colors = pickColors(els.covers[back]);
  setAccent(colors && colors.accent);
  glow.target = colors ? colors.palette : DEFAULT_PALETTE;
  [els.covers, els.bgs].forEach((pair) => {
    pair[back].classList.add('top', 'show');
    pair[view.front].classList.remove('top');
  });
  view.front = back;
  clearTimeout(artCleanup);
  artCleanup = setTimeout(() => {
    [els.covers, els.bgs].forEach((pair) => pair[1 - view.front].classList.remove('show'));
  }, 1500);
}

// ---------------------------------------------------------------- colour (M2)
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

// Colours from the cover: one accent (UI) + a 3-colour "lava" palette for the edge glow.
// Palette entries are [hue, saturation %, lightness %].
const DEFAULT_PALETTE = [[95, 100, 67], [150, 80, 60], [60, 90, 65]];
const hsl = ([h, sat, l]) => `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% ${l.toFixed(0)}%)`;
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

function pickColors(img) {
  try {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
    let sumL = 0, tintW = 0, tintH = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
      sumL += l; tintW += s; tintH += h * s;
      const w = s * s * (1 - Math.abs(l - 0.5) * 2); // vivid + mid-bright pixels count most
      if (w < 0.05) continue;
      const b = buckets[Math.floor(h / 30) % 12];
      b.w += w; b.h += h * w; b.s += s * w; b.l += l * w;
    }
    const ranked = buckets.filter((b) => b.w > 0).sort((a, b) => b.w - a.w)
      .map((b) => [b.h / b.w, Math.max(b.s / b.w, 0.65) * 100, Math.min(Math.max(b.l / b.w, 0.5), 0.66) * 100, b.w]);
    if (!ranked.length || ranked[0][3] < size * size * 0.02) {
      // Black/white/grey cover: silvers, a touch warm or cool like the cover.
      const hue = tintW ? tintH / tintW : 0;
      const light = 78 + (sumL / (size * size)) * 14; // darker cover → dimmer silver
      const silver = [hue, tintW ? 10 : 0, light];
      return { accent: hsl(silver), palette: [silver, [hue, 6, light - 14], [hue, 4, 96]] };
    }
    const main = ranked[0].slice(0, 3);
    // Second colour: the next clearly different hue on the cover, else a neighbour of the main one.
    const other = ranked.find((c) => c[3] > ranked[0][3] * 0.12 && hueGap(c[0], main[0]) >= 45);
    const second = other ? other.slice(0, 3) : [(main[0] + 40) % 360, main[1], main[2]];
    const third = [(main[0] + 340) % 360, Math.min(100, main[1] + 10), Math.min(78, main[2] + 14)]; // lighter, warmer
    return { accent: hsl(main), palette: [main, second, third] };
  } catch {
    return null; // canvas blocked (no CORS) → keep default colours
  }
}

function setAccent(color) {
  els.screen.style.setProperty('--accent', color || DEFAULT_ACCENT);
}

// ---------------------------------------------------------------- progress (M3)
function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function currentPosition() {
  const pos = playback.progressMs + (playback.isPlaying ? performance.now() - playback.at : 0);
  return Math.min(pos, playback.durationMs || pos);
}

// ---------------------------------------------------------------- glow
// Lava-lamp edge: a glowing band that swells into slow, soft blobs which drift around the
// screen, merge and split, with the cover's colours flowing through them.
// No audio access on the web, so "how loud" is estimated: the song's energy (ReccoBeats) and
// its shape (calm intro, bigger in repeated parts = choruses, softer outro, from synced lyrics).
const glowEls = [document.querySelector('.artglow')];
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const band = $('glowband');
const ctx = band.getContext('2d');
const SAMPLES = 240;              // points around the edge
const RADIUS = 40;                // corner rounding (matches .edge)
const MARGIN = 12;                // same inset as .edge
// Glow look: soft and blurry ("dream") with many small, quick ripples ("ribbon").
const STYLE = { base: 5, grow: 22, max: 32, blobs: 14, width: [0.007, 0.022], flow: 0.9, speed: 1.4, shadow: 24, alpha: 0.8, blur: 6 };
const MAX_DEPTH = STYLE.max;      // keep blobs out of the corners' centre
const glow = {
  bpm: 0,                         // 0 = tempo unknown
  songEnergy: 0.5,                // 0 (calm) – 1 (loud), whole song
  structure: null,                // from songStructure()
  level: 0.3,                     // smoothed "loudness" 0–1
  surge: 0,                       // extra swell when the song gets bigger, fades out
  switchAt: -1e9,                 // when the last song change happened (ms)
  palette: DEFAULT_PALETTE.map((c) => c.slice()),
  target: DEFAULT_PALETTE,
  flow: 0,                        // how far the colours have flowed around (radians)
  last: 0,
  blobs: [],
};

function newBlob() {
  return {
    u: Math.random(),                          // position around the edge (0–1)
    v: (Math.random() - 0.5) * 0.012,          // drift speed
    size: 0.4 + Math.random() * 0.6,
    width: STYLE.width[0] + Math.random() * (STYLE.width[1] - STYLE.width[0]), // how long the blob is
    phase: Math.random() * Math.PI * 2,
    rate: 0.15 + Math.random() * 0.35,         // how fast it grows and shrinks
  };
}
for (let i = 0; i < STYLE.blobs; i++) glow.blobs.push(newBlob());
if (STYLE.blur) band.style.filter = `blur(${STYLE.blur}px)`;

function resizeGlow() {
  band.width = innerWidth;
  band.height = innerHeight;
}
addEventListener('resize', resizeGlow);
resizeGlow();

// New song: a big lava wave races from the top down both sides, and the blobs reshuffle.
function songChanged() {
  glow.switchAt = performance.now();
  glow.surge = 1;
  glow.blobs.forEach((b) => { b.v = (Math.random() - 0.5) * 0.03; b.phase = Math.random() * Math.PI * 2; });
}

// Point on the rounded frame at fraction u (0–1, clockwise from the top) + inward direction.
function edgePoint(u, w, h) {
  const m = MARGIN, r = RADIUS;
  const W = w - 2 * m - 2 * r, H = h - 2 * m - 2 * r, A = (Math.PI * r) / 2;
  let d = (((u % 1) + 1) % 1) * (2 * (W + H) + 4 * A);
  const arc = (cx, cy, a0) => {
    const a = a0 + d / r;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, -Math.cos(a), -Math.sin(a)];
  };
  if (d < W) return [m + r + d, m, 0, 1]; d -= W;
  if (d < A) return arc(w - m - r, m + r, -Math.PI / 2); d -= A;
  if (d < H) return [w - m, m + r + d, -1, 0]; d -= H;
  if (d < A) return arc(w - m - r, h - m - r, 0); d -= A;
  if (d < W) return [w - m - r - d, h - m, 0, -1]; d -= W;
  if (d < A) return arc(m + r, h - m - r, Math.PI / 2); d -= A;
  if (d < H) return [m, h - m - r - d, 1, 0]; d -= H;
  return arc(m + r, m + r, Math.PI);
}

// Estimated loudness 0–1 at this point of the song.
function songLevel(pos) {
  const base = 0.3 + 0.7 * glow.songEnergy;
  const st = glow.structure;
  let part;
  if (st) {
    if (pos < st.start - 500) part = 0.3;                       // intro
    else if (pos > st.end) part = 0.4;                           // outro
    else part = st.loud.some(([a, b]) => pos >= a && pos < b) ? 1 : 0.62; // chorus / verse
  } else {
    const p = playback.durationMs ? pos / playback.durationMs : 0.5;
    part = p < 0.08 ? 0.3 + p * 5 : p > 0.93 ? 0.4 : 0.72;     // no lyrics: just intro/outro
  }
  return Math.min(1, base * part);
}

const circ = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

// How far the lava reaches in from the frame at u.
function lavaDepth(u, swell, now, w, h) {
  let d = 2.5;
  for (const b of glow.blobs) {
    const x = circ(u, b.u) / b.width;
    d += swell * b.cur * Math.exp(-x * x * 0.5);
  }
  const since = (now - glow.switchAt) / 1000;
  let cap = MAX_DEPTH;
  if (since < 3.5) { // song change: two big waves race from the top centre all the way round and meet at the bottom
    const W = w - 2 * MARGIN - 2 * RADIUS, H = h - 2 * MARGIN - 2 * RADIUS;
    const top = (W / 2) / (2 * (W + H) + 2 * Math.PI * RADIUS);
    const run = Math.min(0.5, since * 0.32);
    const fade = Math.exp(-since * 0.7);
    for (const dir of [1, -1]) {
      const x = circ(u, top + dir * run) / 0.05;
      d += 55 * fade * Math.exp(-x * x * 0.5);
    }
    d += 10 * Math.exp(-since * 2); // whole frame swells for a moment
    cap += 30 * fade;
  }
  return Math.min(cap, d);
}

function drawGlow(now) {
  const dt = Math.min(0.1, (now - glow.last) / 1000);
  glow.last = now;
  const w = band.width, h = band.height;
  const playing = playback.isPlaying && !calm.matches;

  // Loudness: rise fairly quickly (a drop/chorus kicks in), fall slowly.
  const target = playing ? songLevel(currentPosition()) : 0.12;
  if (target > glow.level + 0.2) glow.surge = Math.max(glow.surge, target - glow.level); // the song just got bigger
  glow.level += (target - glow.level) * (1 - Math.exp(-dt * (target > glow.level ? 1.2 : 0.4)));
  glow.surge *= Math.exp(-dt * 0.7);
  const level = Math.min(1.3, glow.level + glow.surge * 0.8);
  const tempo = Math.min(1.4, Math.max(0.7, (glow.bpm || 110) / 110));

  // Blobs drift, grow and shrink — slow when calm, livelier when loud.
  const pace = calm.matches ? 0 : dt * (0.25 + 1.6 * level) * tempo * STYLE.speed;
  for (const b of glow.blobs) {
    b.phase += pace * b.rate * 2;
    b.u = (b.u + b.v * pace * 3 + 1) % 1;
    b.v += (Math.random() - 0.5) * 0.004 * pace;                // wander
    b.v = Math.max(-0.02, Math.min(0.02, b.v));
    b.cur = b.size * Math.max(0, 0.15 + 0.85 * Math.sin(b.phase)); // 0 = blob has melted back in
  }
  const swell = STYLE.base + STYLE.grow * level;

  // Colours slide toward the new cover's palette and flow around the edge.
  glow.palette.forEach((c, i) => {
    const t = glow.target[i];
    const k = 1 - Math.exp(-dt * 1.5);
    let dh = ((t[0] - c[0] + 540) % 360) - 180;                   // shortest way round the colour wheel
    c[0] = (c[0] + dh * k + 360) % 360; c[1] += (t[1] - c[1]) * k; c[2] += (t[2] - c[2]) * k;
  });
  const kick = Math.exp(-Math.max(0, now - glow.switchAt) / 700); // 1 right at a song change, fades out
  glow.flow += pace * STYLE.flow + dt * 5 * kick;                  // colours spin round on a new song
  glowEls.forEach((el) => el.style.setProperty('--pulse', Math.min(1, 0.25 + 0.6 * level).toFixed(3)));

  // Lava shape: the ring between the frame and the wobbly inner edge.
  const outer = [], inner = [];
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / SAMPLES;
    const [x, y, nx, ny] = edgePoint(u, w, h);
    const d = lavaDepth(u, swell, now, w, h);
    outer.push([x - nx, y - ny]);
    inner.push([x + nx * d, y + ny * d]);
  }
  const trace = (pts) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));

  let fill;
  if (ctx.createConicGradient) {
    fill = ctx.createConicGradient(glow.flow, w / 2, h / 2);
    const [a, b, c] = glow.palette.map(hsl);
    [[0, a], [0.2, b], [0.4, c], [0.6, a], [0.8, b], [1, a]].forEach(([o, col]) => fill.addColorStop(o, col));
  } else {
    fill = hsl(glow.palette[0]);
  }
  const strength = els.screen.classList.contains('is-playing') ? 1 : 0.55;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = Math.min(1, STYLE.alpha + 0.2 * level + 0.3 * kick) * strength;
  ctx.shadowColor = hsl(glow.palette[0]);
  ctx.shadowBlur = STYLE.shadow + 22 * level + 40 * kick;
  ctx.fillStyle = fill;
  ctx.beginPath();
  trace(outer); ctx.closePath();
  trace(inner); ctx.closePath();
  ctx.fill('evenodd');
  ctx.restore();
}

// ---------------------------------------------------------------- Christmas snow
const XMAS = /christmas|xmas|x-mas|jingle|santa|sleigh|mistletoe|navidad|let it snow|winter wonderland|rudolph|reindeer|silent night|holy night|deck the hall|frosty|snowman|little drummer|feliz navidad|\bnoel\b|\bjul\b|julen|julafton|tomte|god jul|nu tändas/i;
function isChristmas(t) { return XMAS.test(`${t.name} ${t.album}`); }

const snowCanvas = $('snow');
const snowCtx = snowCanvas.getContext('2d');
const snow = { on: false, flakes: [], last: 0, running: false };
function setSnow(on) {
  on = on && !calm.matches;
  snowCanvas.classList.toggle('on', on);
  snow.on = on;
  if (on && !snow.running) { snow.running = true; snow.last = performance.now(); requestAnimationFrame(snowFrame); }
}
function newFlake(w, h, anywhere) {
  return { x: Math.random() * w, y: anywhere ? Math.random() * h : -10, r: 1 + Math.random() * 2.6, vy: 25 + Math.random() * 45, sway: Math.random() * 6.3, swaySpeed: 0.5 + Math.random() };
}
function snowFrame(now) {
  const w = (snowCanvas.width = innerWidth), h = (snowCanvas.height = innerHeight);
  const dt = Math.min(0.1, (now - snow.last) / 1000);
  snow.last = now;
  const want = Math.round((w * h) / 9000);
  while (snow.flakes.length < want) snow.flakes.push(newFlake(w, h, true));
  snow.flakes.length = Math.min(snow.flakes.length, want);
  snowCtx.fillStyle = '#fff';
  for (const f of snow.flakes) {
    f.y += f.vy * dt;
    f.sway += f.swaySpeed * dt;
    f.x += Math.sin(f.sway) * 18 * dt;
    if (f.y > h + 10) Object.assign(f, newFlake(w, h, false));
    snowCtx.globalAlpha = 0.35 + f.r / 5;
    snowCtx.beginPath();
    snowCtx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    snowCtx.fill();
  }
  // keep falling until the fade-out is done, then stop drawing
  if (snow.on || getComputedStyle(snowCanvas).opacity > 0.01) requestAnimationFrame(snowFrame);
  else { snow.running = false; snowCtx.clearRect(0, 0, w, h); }
}

// Song tempo + energy from ReccoBeats (free, no key, uses the Spotify track id). Cached per song.
const tempoCache = new Map();
async function loadTempo(track) {
  glow.bpm = 0;
  glow.songEnergy = 0.5;
  if (track.isEpisode || !/^[A-Za-z0-9]{22}$/.test(track.id)) return;
  if (!tempoCache.has(track.id)) {
    const p = fetch(`https://api.reccobeats.com/v1/audio-features?ids=${track.id}`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        const f = data.content && data.content[0];
        return f ? { bpm: Number(f.tempo) || 0, energy: Number(f.energy) || 0.5 } : null;
      });
    p.catch(() => tempoCache.delete(track.id)); // offline: try again next time
    tempoCache.set(track.id, p);
  }
  try {
    const info = await tempoCache.get(track.id);
    if (info && view.track && view.track.id === track.id) {
      glow.bpm = info.bpm;
      glow.songEnergy = info.energy;
    }
  } catch { /* keep the default rhythm */ }
}

let lastElapsed = '';
function frame(now) {
  requestAnimationFrame(frame); // the browser pauses this by itself when the page is hidden
  if (!els.screen.classList.contains('is-login')) drawGlow(now);
  if (!playback.id) return;
  const pos = currentPosition();
  const pct = playback.durationMs ? (pos / playback.durationMs) * 100 : 0;
  els.fill.style.width = `${pct}%`;
  els.knob.style.left = `${pct}%`;
  const elapsed = formatTime(pos);
  if (elapsed !== lastElapsed) els.elapsed.textContent = lastElapsed = elapsed;
  if (prefs.lyrics) updateLyrics(pos);
}

// ---------------------------------------------------------------- controls (M3)
const CONTROL = {
  play: ['PUT', '/me/player/play'],
  pause: ['PUT', '/me/player/pause'],
  next: ['POST', '/me/player/next'],
  previous: ['POST', '/me/player/previous'],
  seek: ['PUT', '/me/player/seek'],
};

async function control(action, positionMs) {
  const [method, path] = CONTROL[action];
  let ok = false;
  const query = action === 'seek' ? `?position_ms=${Math.round(positionMs)}` : '';
  try {
    const res = await api(path + query, { method });
    ok = res.ok;
    if (res.status === 404) flash('No active Spotify device — start playing in Spotify first');
    else if (res.status === 403) flash('Spotify said no (Premium is needed for controls)');
    else if (res.status === 429) flash('Too many clicks — wait a moment');
    else if (res.ok && (action === 'play' || action === 'pause')) {
      // Update right away instead of waiting for the next poll.
      Object.assign(playback, { progressMs: currentPosition(), at: performance.now(), isPlaying: action === 'play' });
      els.playBtn.classList.toggle('playing', playback.isPlaying);
      setScreenState(playback.isPlaying ? 'playing' : 'paused');
      if (playback.isPlaying) lastPlayingAt = Date.now();
    } else if (res.ok && action === 'seek') {
      Object.assign(playback, { progressMs: positionMs, at: performance.now() });
      const old = els.lyrlist.querySelector('.active');
      if (old) old.classList.remove('active');
      lyr.idx = -2; // re-centre the lyrics at the new spot
    }
  } catch (e) {
    if (e instanceof AuthError) { logout('Your Spotify login expired. Please log in again.'); return false; }
    flash('Offline — could not reach Spotify');
  }
  setTimeout(poll, 600);
  return ok;
}

// ---------------------------------------------------------------- up next (M4)
// shortcut: Spotify has no "play queue item N", so we press Next N times (those songs count as skipped).
let skipping = false;
async function skipAhead(steps) {
  if (skipping) return;
  skipping = true;
  for (let i = 0; i < steps; i++) {
    if (!(await control('next'))) break;
  }
  skipping = false;
}

function trackRow(item, current, steps) {
  const row = document.createElement('div');
  row.className = current ? 'row current' : 'row';
  if (!current) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = 'Play this';
    row.addEventListener('click', () => skipAhead(steps));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); skipAhead(steps); } });
  }
  const images = item.album ? item.album.images : item.images || (item.show && item.show.images) || [];
  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.alt = '';
  if (images.length) thumb.src = images[images.length - 1].url; // smallest size
  const text = document.createElement('div');
  const song = document.createElement('div');
  song.className = 'song';
  song.textContent = item.name;
  const by = document.createElement('div');
  by.className = 'small';
  by.textContent = item.artists ? item.artists.map((a) => a.name).join(', ') : (item.show && item.show.name) || '';
  text.append(song, by);
  row.append(thumb, text);
  return row;
}

async function loadQueue() {
  try {
    const res = await api('/me/player/queue');
    if (!res.ok) return;
    const data = await res.json();
    const rows = [];
    if (data.currently_playing) rows.push(trackRow(data.currently_playing, true));
    (data.queue || []).slice(0, 5).forEach((item, i) => rows.push(trackRow(item, false, i + 1)));
    els.queue.replaceChildren(...rows);
  } catch (e) {
    if (e instanceof AuthError) logout('Your Spotify login expired. Please log in again.');
    // offline: keep the old list
  }
}

// ---------------------------------------------------------------- lyrics (M5)
const lyricsCache = new Map(); // track id → Promise<{synced, lines, note?} | null>
const lyr = { id: null, lines: [], synced: false, idx: -1, maxScroll: 0 };

// "[01:02.50] words" → [{ t: 62500, text: 'words' }]
function parseLrc(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}
console.assert(parseLrc('[00:01.50]a\n[01:02][01:03]b').map((l) => l.t).join() === '1500,62000,63000', 'parseLrc');

async function fetchLrclib(path, params) {
  const res = await fetch(`${LRCLIB_URL}/${path}?${new URLSearchParams(params)}`); // throws when offline
  return res.ok ? res.json() : null;
}

async function findLyrics(track) {
  const seconds = Math.round(track.durationMs / 1000);
  const exact = await fetchLrclib('get', {
    track_name: track.name, artist_name: track.firstArtist, album_name: track.album, duration: seconds,
  });
  if (exact && exact.instrumental) return exact;
  const list = (await fetchLrclib('search', { track_name: track.name, artist_name: track.firstArtist })) || [];
  const close = list.filter((x) => Math.abs((x.duration || 0) - seconds) <= 4);
  const pool = [exact, ...(close.length ? close : list)].filter((x) => x && (x.syncedLyrics || x.plainLyrics));
  // LRCLIB entries are sometimes vandalised with another song's words, so prefer lyrics that sing the title.
  const real = pool.filter((x) => singsTitle(track.name, x.plainLyrics || x.syncedLyrics));
  const best = real.length ? real : pool;
  return best.find((x) => x.syncedLyrics) || best[0] || null;
}

const plainText = (t) => t.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
// "Winter Wonderland - 2020 Remaster (feat. X)" → "winter wonderland", then look for it in the lyrics.
function singsTitle(title, lyrics) {
  const core = plainText(title.replace(/\s+-\s.*$/, '').replace(/\(.*?\)|\[.*?\]/g, ''));
  return core.length > 0 && plainText(lyrics || '').includes(core);
}
console.assert(singsTitle('Winter Wonderland - Remastered', 'Walking in a winter wonderland!') && !singsTitle('Winter Wonderland', 'Anh hẹn em pickleball'), 'singsTitle');

function getLyrics(track) {
  if (!lyricsCache.has(track.id)) {
    const p = findLyrics(track).then((d) => {
      if (!d) return null;
      if (d.syncedLyrics) return { synced: true, lines: parseLrc(d.syncedLyrics) };
      if (d.plainLyrics) return { synced: false, lines: d.plainLyrics.split('\n').map((text) => ({ t: 0, text: text.trim() })) };
      if (d.instrumental) return { synced: false, lines: [], note: 'Instrumental' };
      return null;
    });
    p.catch(() => lyricsCache.delete(track.id)); // offline: try again next time
    lyricsCache.set(track.id, p);
  }
  return lyricsCache.get(track.id);
}

function lyricsNote(text) {
  const note = document.createElement('div');
  note.className = 'lyrnote';
  note.textContent = text;
  els.lyrlist.replaceChildren(note);
  els.lyrlist.style.transform = '';
  lyr.lines = [];
}

// Rough song shape from synced lyrics: when singing starts/ends, and where lines repeat
// (choruses — usually the loudest parts). Returns times in ms.
function songStructure(lines) {
  const sung = lines.filter((l) => l.text);
  if (sung.length < 4) return null;
  const key = (t) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const count = new Map();
  sung.forEach((l) => { const k = key(l.text); if (k.length > 3) count.set(k, (count.get(k) || 0) + 1); });
  const loud = [];
  lines.forEach((l, i) => {
    if (!l.text || (count.get(key(l.text)) || 0) < 2) return;
    const end = lines[i + 1] ? lines[i + 1].t : l.t + 4000;
    const last = loud[loud.length - 1];
    if (last && l.t - last[1] < 6000) last[1] = end; else loud.push([l.t, end]);
  });
  return { start: sung[0].t, end: sung[sung.length - 1].t + 4000, loud };
}
console.assert(JSON.stringify(songStructure(parseLrc('[00:10]verse one\n[00:20]la la chorus\n[00:24]verse two\n[00:30]more verse\n[00:40]la la chorus\n[00:44]end'))) === '{"start":10000,"end":48000,"loud":[[20000,24000],[40000,44000]]}', 'songStructure');

async function loadLyrics(track) {
  lyr.id = track.id;
  glow.structure = null;
  if (track.isEpisode) { lyricsNote('No lyrics for podcasts'); return; }
  lyricsNote('Loading lyrics…');
  let result;
  try { result = await getLyrics(track); } catch { result = undefined; }
  if (!view.track || view.track.id !== track.id) return; // song changed meanwhile
  if (result === undefined) { lyricsNote('Lyrics unavailable offline'); return; }
  if (!result) { lyricsNote("You'll have to sing on this one"); return; }
  if (result.note) { lyricsNote(result.note); return; }

  els.lyrlist.replaceChildren(...result.lines.map((l) => {
    const div = document.createElement('div');
    div.className = 'line';
    div.textContent = l.text || '♪';
    return div;
  }));
  els.lyrlist.classList.toggle('plain', !result.synced);
  Object.assign(lyr, { lines: result.lines, synced: result.synced, idx: -1, maxScroll: 0 });
  if (result.synced) glow.structure = songStructure(result.lines);
  els.lyrlist.style.transform = '';
  requestAnimationFrame(() => { lyr.maxScroll = Math.max(0, els.lyrlist.scrollHeight - els.lyrwin.clientHeight); });
}

function updateLyrics(pos) {
  if (!lyr.lines.length || lyr.id !== playback.id) return;
  if (!lyr.synced) { // unsynced: scroll slowly along with the song
    const y = Math.round(lyr.maxScroll * (pos / (playback.durationMs || 1)));
    els.lyrlist.style.transform = `translateY(${-y}px)`;
    return;
  }
  let idx = -1;
  while (idx + 1 < lyr.lines.length && lyr.lines[idx + 1].t <= pos + 250) idx++;
  if (idx === lyr.idx) return;
  const nodes = els.lyrlist.children;
  if (nodes[lyr.idx]) nodes[lyr.idx].classList.remove('active');
  lyr.idx = idx;
  const active = nodes[Math.max(idx, 0)];
  if (idx >= 0) active.classList.add('active');
  // Centre the current line in the window.
  const y = active.offsetTop + active.offsetHeight / 2 - els.lyrwin.clientHeight / 2;
  els.lyrlist.style.transform = `translateY(${-Math.max(0, y)}px)`;
}

// ---------------------------------------------------------------- toggles
const prefs = { upnext: false, lyrics: false };

function setPref(name, on) {
  prefs[name] = on;
  store.set(KEY[name], on);
  els[`${name}Toggle`].setAttribute('aria-pressed', String(on));
  els.screen.classList.toggle(`show-${name}`, on);
  if (on && view.track) {
    if (name === 'upnext') loadQueue();
    else loadLyrics(view.track);
  }
}

// Screen saver link = this page in screen saver mode + your login + current toggles.
async function copyScreenSaverLink() {
  const t = getTokens();
  if (!t || !t.refresh_token) return;
  const query = new URLSearchParams({ mode: 'screensaver', upnext: prefs.upnext ? 1 : 0, lyrics: prefs.lyrics ? 1 : 0 });
  const url = `${REDIRECT_URI}?${query}#rt=${encodeURIComponent(t.refresh_token)}`;
  try {
    await navigator.clipboard.writeText(url);
    flash('Screen saver link copied — keep it private, it works like a password');
  } catch {
    window.prompt('Copy this screen saver link (keep it private):', url);
  }
}

// ---------------------------------------------------------------- clock
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function partOfDay(h) {
  if (h >= 5 && h < 12) return 'Morning';
  if (h >= 12 && h < 17) return 'Afternoon';
  if (h >= 17 && h < 22) return 'Evening';
  return 'Night';
}

function tick() {
  const now = new Date();
  els.time.textContent = timeFmt.formatToParts(now)
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value).join('').trim();
  const parts = Object.fromEntries(dateFmt.formatToParts(now).map((p) => [p.type, p.value]));
  els.date.textContent = `${parts.weekday} ${partOfDay(now.getHours())}  ·  ${parts.month} ${parts.day}`;
  setTimeout(tick, 1000 - now.getMilliseconds() + 10);
}

// ---------------------------------------------------------------- modes (M6)
function setupMode() {
  const query = new URLSearchParams(location.search);
  MODE = ['wallpaper', 'screensaver'].includes(query.get('mode')) ? query.get('mode') : 'normal';
  els.screen.classList.add(`mode-${MODE}`);

  // Toggles: ?upnext=1&lyrics=0 in the address wins over what was saved.
  for (const name of ['upnext', 'lyrics']) {
    const fromUrl = query.get(name);
    setPref(name, fromUrl !== null ? fromUrl === '1' : store.get(KEY[name]) === true);
  }

  if (MODE === 'wallpaper') {
    // Hide buttons + cursor after 3 s without mouse movement.
    let timer = null;
    const wake = () => {
      els.screen.classList.remove('chrome-hidden');
      clearTimeout(timer);
      timer = setTimeout(() => els.screen.classList.add('chrome-hidden'), 3000);
    };
    ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((e) => addEventListener(e, wake, { passive: true }));
    wake();
  }
}

// ---------------------------------------------------------------- start
async function boot() {
  // Spotify only accepts 127.0.0.1 (not "localhost") as a local redirect.
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  tick();
  els.loginBtn.addEventListener('click', () => startLogin().catch(() => showLogin('Could not start login.')));
  els.playBtn.addEventListener('click', () => control(playback.isPlaying ? 'pause' : 'play'));
  els.prevBtn.addEventListener('click', () => control('previous'));
  els.nextBtn.addEventListener('click', () => control('next'));
  $('progress').addEventListener('click', (e) => {
    if (!playback.durationMs) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    control('seek', frac * playback.durationMs);
  });
  els.upnextToggle.addEventListener('click', () => setPref('upnext', !prefs.upnext));
  els.lyricsToggle.addEventListener('click', () => setPref('lyrics', !prefs.lyrics));
  els.copyLink.addEventListener('click', copyScreenSaverLink);
  requestAnimationFrame(frame);

  if (location.protocol === 'file:' || !window.crypto || !crypto.subtle) {
    setupMode();
    showLogin('Open this page through the local server (see README), not as a file.');
    els.loginBtn.disabled = true;
    return;
  }

  takeTokenFromHash();
  try {
    await handleLoginRedirect();
  } catch (e) {
    setupMode();
    showLogin(e instanceof AuthError ? e.message : 'Could not reach Spotify. Check your connection.');
    return;
  }
  setupMode(); // after the redirect, so ?mode=… is back in the address

  if (!getTokens()) { showLogin(); return; }

  els.login.hidden = true;
  setScreenState('idle');
  scheduleRefresh();
  poll();
}

window.addEventListener('online', () => { if (getTokens() && els.login.hidden) poll(); });
document.addEventListener('visibilitychange', () => {
  els.screen.classList.toggle('is-hidden', document.hidden);
  if (!document.hidden && getTokens() && els.login.hidden) poll();
});

boot();
