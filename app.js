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

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';

// The page's own address (without file name / query) is the redirect URI:
// http://127.0.0.1:8000/  or  https://lucas988-star.github.io/glowmusic/
const REDIRECT_URI = location.origin + location.pathname.replace(/[^/]*$/, '');

const KEY = {
  tokens: 'glowstick.tokens',
  verifier: 'glowstick.pkce_verifier',
  state: 'glowstick.pkce_state',
  returnQuery: 'glowstick.return_query',
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
  pollTimer = setTimeout(poll, delay);
}

function stopPolling() {
  clearTimeout(pollTimer);
  clearTimeout(refreshTimer);
}

// ---------------------------------------------------------------- view
const view = { trackId: null, artUrl: null, front: 0, hasText: false };
// Shared playback info (used by the progress bar in Milestone 3).
const playback = { id: null, progressMs: 0, durationMs: 0, isPlaying: false, at: 0 };

function setScreenState(state) {
  const s = els.screen.classList;
  ['boot', 'login', 'idle', 'playing', 'paused'].forEach((c) => s.toggle(`is-${c}`, c === state));
}

function setStatus(text) {
  if (text) els.status.textContent = text;
  els.status.classList.toggle('on', Boolean(text));
}

function showLogin(message = '') {
  stopPolling();
  setScreenState('login');
  els.login.hidden = false;
  els.loginBtn.disabled = false;
  els.loginMsg.textContent = message;
  setStatus('');
}

function logout(message) {
  store.del(KEY.tokens);
  showLogin(message);
}

function showIdle() {
  setScreenState('idle');
  view.trackId = null;
  playback.isPlaying = false;
}

function showTrack(data) {
  const item = data.item;
  const isEpisode = item.type === 'episode';
  const id = item.id || item.uri;
  const title = item.name || '';
  const artist = isEpisode
    ? (item.show && item.show.name) || ''
    : (item.artists || []).map((a) => a.name).join(', ');
  const album = isEpisode ? '' : (item.album && item.album.name) || '';
  const images = isEpisode ? (item.images && item.images.length ? item.images : item.show && item.show.images) : item.album && item.album.images;
  const art = images && images[0] ? images[0].url : null;

  Object.assign(playback, {
    id,
    progressMs: data.progress_ms || 0,
    durationMs: item.duration_ms || 0,
    isPlaying: Boolean(data.is_playing),
    at: performance.now(),
  });

  setScreenState(data.is_playing ? 'playing' : 'paused');
  if (id !== view.trackId) {
    view.trackId = id;
    setTrackText(title, album ? `${artist}  ·  ${album}` : artist);
  }
  setArt(art);
}

let textTimer = null;
function setTrackText(title, subtitle) {
  clearTimeout(textTimer);
  const apply = () => {
    els.title.textContent = title;
    els.artist.textContent = subtitle;
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
    return;
  }
  layers.forEach((el) => { el.src = url; });
  await Promise.all(layers.map((el) => el.decode().catch(() => {})));
  if (token !== artToken) return; // a newer track arrived meanwhile

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

// ---------------------------------------------------------------- start
async function boot() {
  // Spotify only accepts 127.0.0.1 (not "localhost") as a local redirect.
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  tick();
  els.loginBtn.addEventListener('click', () => startLogin().catch(() => showLogin('Could not start login.')));

  if (location.protocol === 'file:' || !window.crypto || !crypto.subtle) {
    showLogin('Open this page through the local server (see README), not as a file.');
    els.loginBtn.disabled = true;
    return;
  }

  try {
    await handleLoginRedirect();
  } catch (e) {
    showLogin(e instanceof AuthError ? e.message : 'Could not reach Spotify. Check your connection.');
    return;
  }

  if (!getTokens()) { showLogin(); return; }

  els.login.hidden = true;
  setScreenState('idle');
  scheduleRefresh();
  poll();
}

window.addEventListener('online', () => poll());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && getTokens()) poll();
});

boot();
