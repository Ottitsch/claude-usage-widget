// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: chart-bar;
//
// claude usage widget
// shows session (5h) + weekly claude usage on the home screen.
// auth: claude oauth — log in from the script itself (auto-refreshing tokens).
// setup: run this script inside the scriptable app and follow the prompts.

const CONFIG = {
  warnAt: 60,           // % where bars turn orange
  dangerAt: 85,         // % where bars turn red
  notifyAt: 90,         // % that triggers a "near limit" notification (once per window)
  resetNotifyAbove: 5, // schedule a "limit reset" notification if usage was above this %
  refreshMinutes: 5,    // requested widget refresh interval (iOS decides the real one)
  tapAction: "refresh", // "refresh" = tap shows fresh usage in scriptable, "claude" = tap opens claude.ai
};

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

const KEY_CREDS = "claude-usage-widget.creds";
const KEY_CACHE = "claude-usage-widget.cache";
const KEY_NOTIFIED = "claude-usage-widget.notified";

const PALETTE = {
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e")),
  text: Color.dynamic(new Color("#000000"), new Color("#ffffff")),
  subtle: Color.dynamic(new Color("#6c6c70"), new Color("#98989f")),
  track: Color.dynamic(new Color("#787880", 0.2), new Color("#787880", 0.36)),
  green: new Color("#30d158"),
  orange: new Color("#ff9f0a"),
  red: new Color("#ff453a"),
};

// ---------- storage ----------

function loadKey(key) {
  if (!Keychain.contains(key)) return null;
  try {
    return JSON.parse(Keychain.get(key));
  } catch (e) {
    return null;
  }
}

function saveKey(key, value) {
  Keychain.set(key, JSON.stringify(value));
}

function clearKey(key) {
  if (Keychain.contains(key)) Keychain.remove(key);
}

// ---------- http ----------

function err(code, message) {
  return Object.assign(new Error(message || code), { code });
}

async function http(url, opts = {}) {
  const req = new Request(url);
  req.method = opts.method || "GET";
  req.headers = opts.headers || {};
  if (opts.body) req.body = opts.body;
  let text;
  try {
    text = await req.loadString();
  } catch (e) {
    throw err("NETWORK", `request failed: ${e}`);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  return { status: req.response.statusCode, json, text };
}

// ---------- auth ----------

function parseCreds(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("clipboard does not contain valid JSON");
  }
  const o = json.claudeAiOauth || json;
  const accessToken = o.accessToken || o.access_token || null;
  const refreshToken = o.refreshToken || o.refresh_token;
  if (!refreshToken) {
    throw new Error("no refresh token found — copy the full contents of your .claude/.credentials.json file");
  }
  let expiresAt = Number(o.expiresAt || o.expires_at) || 0;
  if (!expiresAt && o.expires_in) expiresAt = Date.now() + o.expires_in * 1000;
  return { accessToken, refreshToken, expiresAt };
}

async function refreshTokens(creds) {
  let res;
  try {
    res = await http(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
  } catch (e) {
    throw e; // network error, not an auth failure
  }
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    throw err("AUTH", `token refresh failed (http ${res.status})`);
  }
  creds.accessToken = res.json.access_token;
  if (res.json.refresh_token) creds.refreshToken = res.json.refresh_token;
  creds.expiresAt = Date.now() + (res.json.expires_in || 3600) * 1000;
  saveKey(KEY_CREDS, creds);
  return creds;
}

// ---------- oauth login (pkce) ----------

// scriptable has no crypto api, so pkce needs a self-contained sha-256.
// verified against node crypto and the rfc 7636 test vector.
function sha256Bytes(ascii) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const msg = [];
  for (let i = 0; i < ascii.length; i++) msg.push(ascii.charCodeAt(i) & 0xff);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  msg.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = (msg[i + t * 4] << 24) | (msg[i + t * 4 + 1] << 16) | (msg[i + t * 4 + 2] << 8) | msg[i + t * 4 + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = [];
  for (const x of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    out.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  }
  return out;
}

function base64url(bytes) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += abc[b0 >> 2] + abc[((b0 & 3) << 4) | (b1 == null ? 0 : b1 >> 4)];
    if (b1 != null) out += abc[((b1 & 15) << 2) | (b2 == null ? 0 : b2 >> 6)];
    if (b2 != null) out += abc[b2 & 63];
  }
  return out;
}

// same authorization-code + pkce flow claude code uses to log in. with
// code=true the callback page displays the authorization code for the user
// to copy instead of needing a local http server to catch the redirect.
async function oauthLogin() {
  // uuids come from ios's csprng; two of them = 256 bits of verifier entropy
  const verifier = (UUID.string() + UUID.string()).toLowerCase();
  const state = UUID.string().toLowerCase();
  const url =
    `${AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}` +
    `&code_challenge=${base64url(sha256Bytes(verifier))}&code_challenge_method=S256&state=${state}`;

  const intro = new Alert();
  intro.title = "log in with claude";
  intro.message =
    "a browser sheet will open. log in to claude and approve access, then copy the code it shows and close the sheet to come back here.";
  intro.addAction("open login page");
  intro.addCancelAction("cancel");
  if ((await intro.presentAlert()) === -1) return;

  await Safari.openInApp(url, false);

  const clip = (Pasteboard.paste() || "").trim();
  const ask = new Alert();
  ask.title = "authorization code";
  ask.message = "paste the code from the browser (looks like xxxx#xxxx)";
  ask.addTextField("code", /^[\w-]+#[\w-]+$/.test(clip) ? clip : "");
  ask.addAction("continue");
  ask.addCancelAction("cancel");
  if ((await ask.presentAlert()) === -1) return;
  const input = (ask.textFieldValue(0) || "").trim();
  if (!input) {
    await showInfo("no code", "nothing was entered — run login again and copy the code shown after approving.");
    return;
  }

  const parts = input.split("#");
  let res;
  try {
    res = await http(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: parts[0],
        state: parts[1] || state,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
  } catch (e) {
    await showInfo("login failed", `network error: ${e.message || e}`);
    return;
  }
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    await showInfo(
      "login failed",
      `token exchange returned http ${res.status} — codes are single-use and expire fast, so try logging in again (or use paste credentials as a fallback)`
    );
    return;
  }
  saveKey(KEY_CREDS, {
    accessToken: res.json.access_token,
    refreshToken: res.json.refresh_token || null,
    expiresAt: Date.now() + (res.json.expires_in || 3600) * 1000,
  });
  await showInfo("logged in", "credentials stored in the keychain. tokens will refresh automatically.");
}

// ---------- usage ----------

function clampPct(n) {
  return Math.max(0, Math.min(100, Number(n) || 0));
}

function normalize(json) {
  const win = (o) =>
    o && typeof o.utilization === "number"
      ? {
          utilization: clampPct(o.utilization),
          resetsAt: o.resets_at ? new Date(o.resets_at) : null,
        }
      : null;
  const data = {
    session: win(json.five_hour),
    week: win(json.seven_day),
    weekOpus: win(json.seven_day_opus),
  };
  if (!data.session && !data.week) {
    throw err("HTTP", "usage response had an unexpected shape");
  }
  return data;
}

async function usageRequest(creds) {
  return http(USAGE_URL, {
    headers: {
      "Authorization": `Bearer ${creds.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
  });
}

async function getUsage() {
  let creds = loadKey(KEY_CREDS);
  if (!creds) throw err("SETUP");
  if (!creds.accessToken || Date.now() >= (creds.expiresAt || 0) - 60000) {
    creds = await refreshTokens(creds);
  }
  let res = await usageRequest(creds);
  if (res.status === 401 || res.status === 403) {
    creds = await refreshTokens(creds);
    res = await usageRequest(creds);
  }
  if (res.status !== 200 || !res.json) {
    throw err("HTTP", `usage endpoint returned http ${res.status}`);
  }
  const data = normalize(res.json);
  saveKey(KEY_CACHE, { data, fetchedAt: Date.now() });
  return { data, fetchedAt: new Date(), stale: false };
}

function loadCachedUsage() {
  const cached = loadKey(KEY_CACHE);
  if (!cached) return null;
  const revive = (w) =>
    w ? { utilization: w.utilization, resetsAt: w.resetsAt ? new Date(w.resetsAt) : null } : null;
  return {
    data: {
      session: revive(cached.data.session),
      week: revive(cached.data.week),
      weekOpus: revive(cached.data.weekOpus),
    },
    fetchedAt: new Date(cached.fetchedAt),
    stale: true,
  };
}

// ---------- notifications ----------

async function handleNotifications(data) {
  const windows = [
    ["session", "session", data.session],
    ["week", "weekly", data.week],
    ["weekOpus", "weekly opus", data.weekOpus],
  ];
  const state = loadKey(KEY_NOTIFIED) || {};
  for (const [key, label, win] of windows) {
    if (!win || !win.resetsAt) continue;
    const resetTag = win.resetsAt.toISOString();

    // near-limit alert, once per usage window
    if (win.utilization >= CONFIG.notifyAt && state[key] !== resetTag) {
      const n = new Notification();
      n.identifier = `claude-usage-near-limit-${key}`;
      n.title = "claude usage";
      n.body = `${label} usage at ${Math.round(win.utilization)}% — resets in ${formatCountdown(win.resetsAt)}`;
      await n.schedule();
      state[key] = resetTag;
    }

    // reset alert: same identifier per window, so rescheduling is idempotent
    if (win.utilization >= CONFIG.resetNotifyAbove && win.resetsAt > new Date()) {
      const n = new Notification();
      n.identifier = `claude-usage-reset-${key}`;
      n.title = "claude usage";
      n.body = `${label} limit has reset`;
      n.setTriggerDate(win.resetsAt);
      await n.schedule();
    }
  }
  saveKey(KEY_NOTIFIED, state);
}

// ---------- rendering ----------

function colorFor(pct) {
  if (pct >= CONFIG.dangerAt) return PALETTE.red;
  if (pct >= CONFIG.warnAt) return PALETTE.orange;
  return PALETTE.green;
}

function formatCountdown(date) {
  let s = Math.max(0, (date.getTime() - Date.now()) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(date) {
  const df = new DateFormatter();
  df.useShortTimeStyle();
  return df.string(date);
}

function barImage(pct, width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const radius = height / 2;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), radius, radius);
  ctx.addPath(track);
  ctx.setFillColor(PALETTE.track);
  ctx.fillPath();
  if (pct > 0) {
    const w = Math.max(height, (width * Math.min(pct, 100)) / 100);
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, w, height), radius, radius);
    ctx.addPath(fill);
    ctx.setFillColor(colorFor(pct));
    ctx.fillPath();
  }
  return ctx.getImage();
}

function addUsageHeader(stack, label, win) {
  const head = stack.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  const l = head.addText(label.toUpperCase());
  l.font = Font.semiboldSystemFont(10);
  l.textColor = PALETTE.subtle;
  head.addSpacer();
  const p = head.addText(`${Math.round(win.utilization)}%`);
  p.font = Font.semiboldSystemFont(11);
  p.textColor = colorFor(win.utilization);
}

function addUsageRow(stack, label, win, barWidth) {
  addUsageHeader(stack, label, win);
  stack.addSpacer(3);
  const img = stack.addImage(barImage(win.utilization, barWidth, 7));
  img.imageSize = new Size(barWidth, 7);
}

// big live countdown beneath a bar, centered in the widget. centered two ways
// (flexible spacers around the element, center-aligned text within it) so it
// stays centered no matter how much width ios gives the timer element. the
// scale floor is high on purpose: ios pre-shrinks timer text to reserve room
// for the widest possible time string, and a low floor lets it render tiny.
function addCenteredTimer(stack, win, fontSize) {
  if (!win || !win.resetsAt) return;
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  row.addSpacer();
  const timer = row.addDate(win.resetsAt);
  timer.applyTimerStyle();
  timer.centerAlignText();
  timer.font = Font.boldSystemFont(fontSize);
  timer.textColor = PALETTE.text;
  timer.lineLimit = 1;
  timer.minimumScaleFactor = 0.8;
  row.addSpacer();
}

function formatResetDate(date) {
  const df = new DateFormatter();
  df.dateFormat = "EEE";
  return `${df.string(date).toLowerCase()} ${formatTime(date)}`;
}

function addCenteredText(stack, text, font, color) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  const t = row.addText(text);
  t.centerAlignText();
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.8;
  row.addSpacer();
}

// static weekday + time, for resets that are days away
function addResetDateRow(stack, win, fontSize = 12, centered = false) {
  if (!win || !win.resetsAt) return;
  const text = `resets ${formatResetDate(win.resetsAt)}`;
  if (centered) {
    addCenteredText(stack, text, Font.mediumSystemFont(fontSize), PALETTE.subtle);
    return;
  }
  const t = stack.addText(text);
  t.font = Font.mediumSystemFont(fontSize);
  t.textColor = PALETTE.subtle;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
}

function newWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = PALETTE.bg;
  widget.url =
    CONFIG.tapAction === "claude"
      ? "https://claude.ai"
      : `scriptable:///run/${encodeURIComponent(Script.name())}?action=refresh`;
  widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60000);
  return widget;
}

function messageWidget(title, body) {
  const widget = newWidget();
  const t = widget.addText(title);
  t.font = Font.semiboldSystemFont(13);
  t.textColor = PALETTE.text;
  widget.addSpacer(6);
  const b = widget.addText(body);
  b.font = Font.systemFont(11);
  b.textColor = PALETTE.subtle;
  b.minimumScaleFactor = 0.7;
  return widget;
}

// dedicated session widget: bar + huge live countdown
function sessionWidget(state) {
  const { data } = state;
  const widget = newWidget();
  widget.setPadding(12, 14, 12, 14);
  const win = data.session;
  if (!win) return messageWidget("no session data", "the usage endpoint returned no 5-hour window");
  addUsageRow(widget, "session", win, 132);
  if (win.resetsAt) {
    widget.addSpacer();
    addCenteredTimer(widget, win, 32);
  }
  widget.addSpacer();
  return widget;
}

// dedicated weekly widget: week (+ opus) bars with reset day + time
function weekWidget(state) {
  const { data } = state;
  const widget = newWidget();
  widget.setPadding(12, 14, 12, 14);
  const wins = [
    ["week", data.week],
    ["week opus", data.weekOpus],
  ].filter(([, w]) => w);
  if (!wins.length) return messageWidget("no weekly data", "the usage endpoint returned no weekly window");
  const compact = wins.length > 1;
  wins.forEach(([label, win], i) => {
    if (i > 0) widget.addSpacer(10);
    addUsageRow(widget, label, win, 132);
    if (!win.resetsAt) return;
    if (compact) {
      widget.addSpacer(3);
      addCenteredText(widget, formatResetDate(win.resetsAt), Font.boldSystemFont(16), PALETTE.text);
    } else {
      widget.addSpacer();
      addCenteredText(widget, formatResetDate(win.resetsAt), Font.boldSystemFont(32), PALETTE.text);
    }
  });
  widget.addSpacer();
  return widget;
}

function smallWidget(state) {
  const { data } = state;
  const widget = newWidget();
  widget.setPadding(10, 14, 10, 14);
  widget.addSpacer();
  if (data.session) {
    addUsageRow(widget, "session", data.session, 132);
    if (data.session.resetsAt) {
      widget.addSpacer(4);
      addCenteredTimer(widget, data.session, 26);
    }
    widget.addSpacer(8);
  }
  if (data.week) {
    addUsageRow(widget, "week", data.week, 132);
    widget.addSpacer(2);
    addResetDateRow(widget, data.week);
  }
  widget.addSpacer();
  return widget;
}

function mediumWidget(state) {
  const { data } = state;
  const widget = newWidget();
  const header = widget.addText("claude usage");
  header.font = Font.semiboldSystemFont(9);
  header.textColor = PALETTE.subtle;
  widget.addSpacer();
  const row = widget.addStack();
  row.layoutHorizontally();
  const columns = [
    ["session", data.session, "timer"],
    ["week", data.week, "date"],
    ["week opus", data.weekOpus, "date"],
  ].filter(([, w]) => w);
  const barWidth = columns.length > 2 ? 84 : 124;
  columns.forEach(([label, win, mode], i) => {
    if (i > 0) row.addSpacer(14);
    const col = row.addStack();
    col.layoutVertically();
    if (mode === "timer") {
      addUsageRow(col, label, win, barWidth);
      if (win.resetsAt) {
        col.addSpacer(4);
        addCenteredTimer(col, win, 18);
      }
    } else {
      addUsageRow(col, label, win, barWidth);
      if (win.resetsAt) {
        col.addSpacer(4);
        addResetDateRow(col, win);
      }
    }
  });
  widget.addSpacer();
  return widget;
}

async function buildWidget(family, param) {
  family = family || config.widgetFamily || "small";
  param = String(param != null ? param : args.widgetParameter || "").toLowerCase().trim();
  let state;
  try {
    state = await getUsage();
    await handleNotifications(state.data);
  } catch (e) {
    if (e.code === "SETUP") {
      return messageWidget("setup needed", "open scriptable, run this script, and log in with claude");
    }
    if (e.code === "AUTH") {
      return messageWidget("re-auth needed", "token refresh failed — run the script and log in with claude again");
    }
    state = loadCachedUsage();
    if (!state) {
      return messageWidget("offline", "no connection and no cached usage yet");
    }
  }
  if (param.startsWith("session")) return sessionWidget(state);
  if (param.startsWith("week")) return weekWidget(state);
  return family === "medium" || family === "large" ? mediumWidget(state) : smallWidget(state);
}

// ---------- in-app setup & tools ----------

async function pasteCredentials() {
  const intro = new Alert();
  intro.title = "paste credentials";
  intro.message =
    "on the machine where claude code is logged in, copy the contents of the credentials file to your clipboard, then continue.\n\nwindows: %USERPROFILE%\\.claude\\.credentials.json\nmac/linux: ~/.claude/.credentials.json";
  intro.addAction("read clipboard");
  intro.addCancelAction("cancel");
  if ((await intro.presentAlert()) === -1) return;
  try {
    const creds = parseCreds(Pasteboard.paste() || "");
    saveKey(KEY_CREDS, creds);
    await showInfo("saved", "credentials stored in the keychain. tokens will refresh automatically.");
  } catch (e) {
    await showInfo("could not save", String(e.message || e));
  }
}

async function showQuickStatus() {
  let state;
  let note = null;
  try {
    state = await getUsage();
    await handleNotifications(state.data);
  } catch (e) {
    if (e.code === "SETUP") {
      await runApp();
      return;
    }
    state = loadCachedUsage();
    if (!state) {
      await showInfo("fetch failed", `${e.code || "ERROR"}: ${e.message}`);
      return;
    }
    note =
      e.code === "AUTH"
        ? "token refresh failed — log in again"
        : "offline — showing cached data";
  }
  const lines = [];
  const add = (label, w) => {
    if (!w) return;
    let line = `${label}: ${Math.round(w.utilization)}% used`;
    if (w.resetsAt) line += `\nresets in ${formatCountdown(w.resetsAt)} (${formatTime(w.resetsAt)})`;
    lines.push(line);
  };
  add("session (5h)", state.data.session);
  add("week", state.data.week);
  add("week opus", state.data.weekOpus);
  if (note) lines.push(`⚠️ ${note} — data as of ${formatTime(state.fetchedAt)}`);
  const a = new Alert();
  a.title = note ? "claude usage (cached)" : "claude usage";
  a.message = lines.join("\n\n");
  a.addAction("refresh");
  a.addAction("open claude.ai");
  a.addCancelAction("done");
  const choice = await a.presentAlert();
  if (choice === 0) await showQuickStatus();
  if (choice === 1) Safari.open("https://claude.ai");
}

async function showInfo(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addCancelAction("ok");
  await a.presentAlert();
}

async function runApp() {
  while (true) {
    const hasCreds = !!loadKey(KEY_CREDS);
    const menu = new Alert();
    menu.title = "claude usage widget";
    menu.message = hasCreds ? "credentials stored ✓" : "no credentials stored yet — start with log in";
    menu.addAction(hasCreds ? "log in again with claude" : "log in with claude");
    menu.addAction(hasCreds ? "re-paste credentials" : "paste credentials (from a computer)");
    menu.addAction("show usage");
    menu.addAction("preview session widget");
    menu.addAction("preview week widget");
    menu.addAction("preview combined small widget");
    menu.addAction("preview medium widget");
    menu.addDestructiveAction("clear stored data");
    menu.addCancelAction("done");
    const choice = await menu.presentSheet();
    if (choice === -1) break;
    if (choice === 0) await oauthLogin();
    if (choice === 1) await pasteCredentials();
    if (choice === 2) await showQuickStatus();
    if (choice === 3) await (await buildWidget("small", "session")).presentSmall();
    if (choice === 4) await (await buildWidget("small", "week")).presentSmall();
    if (choice === 5) await (await buildWidget("small", "")).presentSmall();
    if (choice === 6) await (await buildWidget("medium", "")).presentMedium();
    if (choice === 7) {
      clearKey(KEY_CREDS);
      clearKey(KEY_CACHE);
      clearKey(KEY_NOTIFIED);
      await showInfo("cleared", "all stored credentials, cache, and notification state removed.");
    }
  }
}

// ---------- main ----------

if (config.runsInWidget) {
  Script.setWidget(await buildWidget());
} else if (args.queryParameters && args.queryParameters.action === "refresh") {
  await showQuickStatus();
} else {
  await runApp();
}
Script.complete();
