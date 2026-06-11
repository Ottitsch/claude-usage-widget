// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: chart-bar;
//
// claude usage widget
// shows session (5h) + weekly claude usage on the home screen.
// auth: claude code oauth credentials (auto-refreshing).
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

// big live countdown beneath a bar, centered across the bar's full width.
// the container has a fixed size and the timer fills it with center-aligned
// text, which keeps it truly centered and stable as the digits change. huge
// fonts auto-shrink to fit the box, so the layout never overflows.
function addCenteredTimer(stack, win, width, fontSize, boxHeight = 0) {
  if (!win || !win.resetsAt) return;
  const box = stack.addStack();
  box.layoutHorizontally();
  box.centerAlignContent();
  box.size = new Size(width, boxHeight);
  const timer = box.addDate(win.resetsAt);
  timer.applyTimerStyle();
  timer.centerAlignText();
  timer.font = Font.boldSystemFont(fontSize);
  timer.textColor = PALETTE.text;
  timer.lineLimit = 1;
  timer.minimumScaleFactor = 0.2;
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
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.5;
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

function addStaleHeader(widget, stale, fetchedAt) {
  if (!stale) return;
  const header = widget.addText(`as of ${formatTime(fetchedAt)}`);
  header.font = Font.semiboldSystemFont(8);
  header.textColor = PALETTE.subtle;
  widget.addSpacer(2);
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

// dedicated session widget: bar + huge live countdown + reset clock time
function sessionWidget(state) {
  const { data, fetchedAt, stale } = state;
  const widget = newWidget();
  widget.setPadding(12, 14, 12, 14);
  addStaleHeader(widget, stale, fetchedAt);
  const win = data.session;
  if (!win) return messageWidget("no session data", "the usage endpoint returned no 5-hour window");
  widget.addSpacer();
  addUsageRow(widget, "session", win, 132);
  if (win.resetsAt) {
    widget.addSpacer();
    addCenteredTimer(widget, win, 132, 38, 0);
    widget.addSpacer(4);
    addCenteredText(widget, `resets ${formatTime(win.resetsAt)}`, Font.mediumSystemFont(13), PALETTE.subtle);
  }
  widget.addSpacer();
  return widget;
}

// dedicated weekly widget: week (+ opus) bars with reset day + time
function weekWidget(state) {
  const { data, fetchedAt, stale } = state;
  const widget = newWidget();
  widget.setPadding(12, 14, 12, 14);
  addStaleHeader(widget, stale, fetchedAt);
  const wins = [
    ["week", data.week],
    ["week opus", data.weekOpus],
  ].filter(([, w]) => w);
  if (!wins.length) return messageWidget("no weekly data", "the usage endpoint returned no weekly window");
  const compact = wins.length > 1;
  widget.addSpacer();
  wins.forEach(([label, win], i) => {
    if (i > 0) widget.addSpacer(10);
    addUsageRow(widget, label, win, 132);
    if (!win.resetsAt) return;
    if (compact) {
      widget.addSpacer(3);
      addCenteredText(widget, formatResetDate(win.resetsAt), Font.boldSystemFont(16), PALETTE.text);
    } else {
      widget.addSpacer();
      addCenteredText(widget, formatResetDate(win.resetsAt), Font.boldSystemFont(30), PALETTE.text);
      widget.addSpacer(4);
      addCenteredText(widget, `resets in ${formatCountdown(win.resetsAt)}`, Font.mediumSystemFont(13), PALETTE.subtle);
    }
  });
  widget.addSpacer();
  return widget;
}

function smallWidget(state) {
  const { data, fetchedAt, stale } = state;
  const widget = newWidget();
  widget.setPadding(10, 14, 10, 14);
  addStaleHeader(widget, stale, fetchedAt);
  widget.addSpacer();
  if (data.session) {
    addUsageRow(widget, "session", data.session, 132);
    if (data.session.resetsAt) {
      widget.addSpacer(4);
      addCenteredTimer(widget, data.session, 132, 82, 40);
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
  const { data, fetchedAt, stale } = state;
  const widget = newWidget();
  const header = widget.addText(stale ? `claude usage · as of ${formatTime(fetchedAt)}` : "claude usage");
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
        addCenteredTimer(col, win, barWidth, 18);
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
      return messageWidget("setup needed", "open scriptable, run this script, and paste your claude credentials");
    }
    if (e.code === "AUTH") {
      return messageWidget("re-auth needed", "token refresh failed — re-paste credentials from .claude/.credentials.json");
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
        ? "token refresh failed — re-paste credentials"
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
    menu.message = hasCreds ? "credentials stored ✓" : "no credentials stored yet — start with setup";
    menu.addAction(hasCreds ? "re-paste credentials" : "paste credentials");
    menu.addAction("show usage");
    menu.addAction("preview session widget");
    menu.addAction("preview week widget");
    menu.addAction("preview combined small widget");
    menu.addAction("preview medium widget");
    menu.addDestructiveAction("clear stored data");
    menu.addCancelAction("done");
    const choice = await menu.presentSheet();
    if (choice === -1) break;
    if (choice === 0) await pasteCredentials();
    if (choice === 1) await showQuickStatus();
    if (choice === 2) await (await buildWidget("small", "session")).presentSmall();
    if (choice === 3) await (await buildWidget("small", "week")).presentSmall();
    if (choice === 4) await (await buildWidget("small", "")).presentSmall();
    if (choice === 5) await (await buildWidget("medium", "")).presentMedium();
    if (choice === 6) {
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
