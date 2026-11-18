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
  info: $('trackinfo'),
  title: $('title'),
  artist: $('artist'),
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
        delay = data.is_playing ? POLL_PLAYING_MS : POLL_IDLE_MS;
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
  pollTimer = setTimeout(poll, document.hidden ? Math.max(delay, 30000) : delay);
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
    els.total.textContent = formatTime(track.durationMs);
    if (prefs.upnext) loadQueue();
    if (prefs.lyrics) loadLyrics(track);
  }
  setArt(images && images[0] ? images[0].url : null);
}

let textTimer = null;
function setTrackText(title, subtitle) {
  clearTimeout(textTimer);
  const apply = () => {
    els.title.textContent = els.ptitle.textContent = title;
    els.artist.textContent = els.partist.textContent = subtitle;
    els.info.classList.remove('fade');
  };
  if (!view.hasText) { view.hasText = true; apply(); return; }
  els.info.classList.add('fade');
  textTimer = setTimeout(apply, 350);
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
    return;
  }
  layers.forEach((el) => { el.src = url; });
  await Promise.all(layers.map((el) => el.decode().catch(() => {})));
  if (token !== artToken) return; // a newer track arrived meanwhile

  setAccent(pickAccent(els.covers[back]));
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

// Most common vivid hue on the cover, pushed to a bright glow-friendly colour.
function pickAccent(img) {
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
    const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w < size * size * 0.02) {
      // Black/white/grey cover: soft silver glow, a touch warm or cool like the cover.
      const hue = tintW ? tintH / tintW : 0;
      const light = 78 + (sumL / (size * size)) * 14; // darker cover → dimmer silver
      return `hsl(${hue.toFixed(0)} ${tintW ? 10 : 0}% ${light.toFixed(0)}%)`;
    }
    const h = best.h / best.w;
    const s = Math.max(best.s / best.w, 0.65) * 100;
    const l = Math.min(Math.max(best.l / best.w, 0.55), 0.68) * 100;
    return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
  } catch {
    return null; // canvas blocked (no CORS) → keep default colour
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
// No audio access on the web, so the glow "reacts" to what we do know about the song:
// every new lyric line gives a flash, a new song sends a wave of light around the screen,
// and in between the band wobbles with random bumps.
const glowEls = [document.querySelector('.artglow')];
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const band = $('glowband');
const sparkCanvas = $('sparks');
const bandCtx = band.getContext('2d');
const sparkCtx = sparkCanvas.getContext('2d');
const SCALE = 0.5;          // draw at half resolution; the CSS blur hides it
const SAMPLES = 180;        // points around the edge
const glow = {
  kick: 0,                  // flash strength, fades out
  pulse: 0.4,
  switchAt: -1e9,           // when the last song change happened (ms)
  phases: [0, 0, 0, 0].map(() => Math.random() * Math.PI * 2),
  color: '#aaff59',
  colorAt: 0,
  last: 0,
  time: 0,
  sparks: [],
};

function resizeGlow() {
  for (const c of [band, sparkCanvas]) {
    c.width = Math.round(innerWidth * SCALE);
    c.height = Math.round(innerHeight * SCALE);
  }
}
addEventListener('resize', resizeGlow);
resizeGlow();

// New song: a wave of light, a flash, new random bumps and a burst of sparks.
function songChanged() {
  glow.switchAt = performance.now();
  glow.kick = 1.6;
  glow.phases = glow.phases.map(() => Math.random() * Math.PI * 2);
  glow.sparks.forEach((p) => { p.life = Math.random() * 0.3; p.speed *= 3; });
}

// Point on the edge rectangle at fraction u (0–1, clockwise from top-left) + inward direction.
function edgePoint(u, w, h, m) {
  const W = w - 2 * m, H = h - 2 * m, P = 2 * (W + H);
  let d = (((u % 1) + 1) % 1) * P;
  if (d < W) return [m + d, m, 0, 1];
  d -= W;
  if (d < H) return [w - m, m + d, -1, 0];
  d -= H;
  if (d < W) return [w - m - d, h - m, 0, -1];
  d -= W;
  return [m, h - m - d, 1, 0];
}

function bandDepth(u, t, base, now) {
  const [a, b, c, e] = glow.phases;
  const TAU = Math.PI * 2;
  // Bumps: a few overlapping waves that drift at different speeds (wraps seamlessly).
  let wobble = 1
    + 0.42 * Math.sin(TAU * 3 * u + a + t * 0.55)
    + 0.30 * Math.sin(TAU * 7 * u + b - t * 0.9)
    + 0.20 * Math.sin(TAU * 13 * u + c + t * 1.7)
    + 0.12 * Math.sin(TAU * 23 * u + e - t * 2.6);
  wobble = Math.max(0.15, wobble);
  let depth = base * wobble * (0.45 + 1.1 * glow.pulse);
  // Song change: two bumps race from the top centre around both sides.
  const since = (now - glow.switchAt) / 1000;
  if (since < 2.5) {
    const top = 0.5 * (band.width - 2 * 6) / (2 * (band.width + band.height - 4 * 6)); // u of top centre
    for (const dir of [1, -1]) {
      const pos = top + dir * since * 0.42;
      let dist = Math.abs(u - pos) % 1;
      dist = Math.min(dist, 1 - dist);
      depth += base * 4 * Math.exp(-since * 1.3) * Math.exp(-(dist * dist) / 0.0022);
    }
  }
  return depth;
}

function drawGlow(now) {
  const dt = Math.min(0.1, (now - glow.last) / 1000);
  glow.last = now;
  const w = band.width, h = band.height, m = 6; // the visible frame is inset 12px (= 6 at half size)
  const playing = playback.isPlaying && !calm.matches;
  if (!calm.matches) glow.time += dt * (playing ? 1 : 0.35); // slower when paused/idle, no jumps
  const t = glow.time;

  // How strong the glow is right now.
  glow.kick *= Math.exp(-dt * 2.5);
  const drift = 0.45 + 0.22 * Math.sin(t * 1.3) * Math.sin(t * 0.41 + 1) + 0.1 * Math.sin(t * 3.1);
  glow.pulse = playing ? Math.min(1.3, drift + glow.kick * 0.7) : 0.25;
  const pulseCss = Math.min(1, glow.pulse).toFixed(3);
  glowEls.forEach((el) => el.style.setProperty('--pulse', pulseCss));

  // Read the (smoothly changing) album colour a few times per second.
  if (now - glow.colorAt > 120) {
    glow.color = getComputedStyle(els.screen).getPropertyValue('--accent').trim() || DEFAULT_ACCENT;
    glow.colorAt = now;
  }

  // Band: everything between the screen edge and a wobbly inner line.
  const base = Math.min(w, h) * 0.035;
  const pts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / SAMPLES;
    const [x, y, nx, ny] = edgePoint(u, w, h, m);
    const d = bandDepth(u, t, base, now);
    pts.push([x, y, nx, ny, d]);
  }
  bandCtx.clearRect(0, 0, w, h);
  const layer = (scale, alpha) => {
    bandCtx.beginPath();
    bandCtx.rect(0, 0, w, h);
    pts.forEach(([x, y, nx, ny, d], i) => {
      const px = x + nx * d * scale, py = y + ny * d * scale;
      if (i) bandCtx.lineTo(px, py); else bandCtx.moveTo(px, py);
    });
    bandCtx.closePath();
    bandCtx.globalAlpha = alpha;
    bandCtx.fill('evenodd');
  };
  const strength = els.screen.classList.contains('is-playing') ? 1 : 0.45;
  bandCtx.fillStyle = glow.color;
  layer(1, 0.5 * strength);                         // soft outer glow
  bandCtx.fillStyle = '#fff';
  layer(0.28, (0.35 + 0.35 * Math.min(1, glow.kick)) * strength); // bright core near the edge
  bandCtx.globalAlpha = 1;

  drawSparks(dt, w, h, m, t, base, now, strength);
}

// Little specks of light floating in the glow band.
function drawSparks(dt, w, h, m, t, base, now, strength) {
  if (!glow.sparks.length) {
    for (let i = 0; i < 46; i++) glow.sparks.push({ life: Math.random(), u: 0, off: 0, speed: 0, size: 0 });
  }
  sparkCtx.clearRect(0, 0, w, h);
  if (calm.matches) return;
  sparkCtx.fillStyle = '#fff';
  for (const p of glow.sparks) {
    p.life += dt * (0.25 + 0.5 * glow.pulse);
    if (p.life >= 1) Object.assign(p, { life: 0, u: Math.random(), off: Math.random(), speed: (Math.random() - 0.5) * 0.02, size: 0.5 + Math.random() * 1.1 });
    p.u += p.speed * dt;
    p.speed *= Math.exp(-dt * 0.5);
    const [x, y, nx, ny] = edgePoint(p.u, w, h, m);
    const d = bandDepth(p.u, t, base, now) * (0.2 + p.off * 1.1);
    sparkCtx.globalAlpha = Math.sin(p.life * Math.PI) * (0.4 + 0.6 * Math.min(1, glow.pulse)) * strength;
    sparkCtx.beginPath();
    sparkCtx.arc(x + nx * d, y + ny * d, p.size, 0, Math.PI * 2);
    sparkCtx.fill();
  }
  sparkCtx.globalAlpha = 1;
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
  const query = action === 'seek' ? `?position_ms=${Math.round(positionMs)}` : '';
  try {
    const res = await api(path + query, { method });
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
    if (e instanceof AuthError) { logout('Your Spotify login expired. Please log in again.'); return; }
    flash('Offline — could not reach Spotify');
  }
  setTimeout(poll, 600);
}

// ---------------------------------------------------------------- up next (M4)
function trackRow(item, current) {
  const row = document.createElement('div');
  row.className = current ? 'row current' : 'row';
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
    (data.queue || []).slice(0, 5).forEach((item) => rows.push(trackRow(item, false)));
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
  if (exact && (exact.syncedLyrics || exact.plainLyrics || exact.instrumental)) return exact;
  const list = (await fetchLrclib('search', { track_name: track.name, artist_name: track.firstArtist })) || [];
  const close = list.filter((x) => Math.abs((x.duration || 0) - seconds) <= 4);
  const pool = close.length ? close : list;
  return pool.find((x) => x.syncedLyrics) || pool.find((x) => x.plainLyrics) || null;
}

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

async function loadLyrics(track) {
  lyr.id = track.id;
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
  if (idx >= 0) { active.classList.add('active'); glow.kick = Math.max(glow.kick, 1); }
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
