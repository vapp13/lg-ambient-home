#!/usr/bin/env node
// Rooted TVs only. Keeps Ambient Home's list of the TV's apps and inputs (tv-apps.js, tv-apps.json and tv-icons/ in
// its folder) and Home Helper's list of apps up to date, so apps installed or removed on the TV and devices plugged
// in show up by themselves: no scripts/tv-sync-apps.mjs from the computer. It also keeps Stremio's Continue watching
// (tv-root-stremio.js), and lists and closes running apps for Settings > Running apps. tv-root-boot.sh starts it
// at boot, as root; it reads the TV every 10 seconds with luna-send and writes only when something changed.
'use strict';
const fs = require('fs');
const { execFile } = require('child_process');

const PALM = '/media/developer/apps/usr/palm/applications';
const APP = PALM + '/com.local.ambienthome';
const HELPER_STATE = PALM + '/com.local.nativehome/state';
const PID = '/tmp/ambient-home-live.pid';
const LOG = '/tmp/ambient-home-live.log';
const EVERY = 10000;
// Helper returns to Ambient Home when one of these apps is left for LG Home; not for these.
const NOT_FOR_HELPER = ['com.local.ambienthome', 'com.local.nativehome', 'com.webos.app.home'];

// The last 200 lines, in /tmp (gone at each restart).
function log(message) {
  try {
    let lines = [];
    try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-199); } catch (e) { /* first line */ }
    lines.push(new Date().toISOString() + ' ' + message);
    fs.writeFileSync(LOG, lines.join('\n') + '\n');
  } catch (e) { /* nowhere to say it */ }
}

// One copy only: a second start (install, then boot) leaves the running one alone.
function alreadyRunning() {
  try {
    const pid = +fs.readFileSync(PID, 'utf8');
    return pid !== process.pid && fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').indexOf('tv-root-live') >= 0;
  } catch (e) {
    return false;
  }
}

// luna-send prints nothing when its output is not a terminal, so run it under script, which gives it one.
function luna(uri, params) {
  return new Promise((resolve) => {
    execFile('script', ['-q', '-c', 'luna-send -n 1 -w 8000 ' + uri + " '" + JSON.stringify(params || {}) + "'", '/dev/null'],
      { maxBuffer: 16 << 20, timeout: 20000 }, (err, out) => {
        const text = String(out || '').replace(/\r/g, '');
        try { resolve(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))); } catch (e) { resolve(null); }
      });
  });
}

function writeIfChanged(file, content, owner, mode) {
  try { if (fs.readFileSync(file, 'utf8') === content) return false; } catch (e) { /* new file */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, { mode: mode });
  fs.chmodSync(tmp, mode);
  if (owner) fs.chownSync(tmp, owner[0], owner[1]);
  fs.renameSync(tmp, file);
  return true;
}

function iconName(id) { return id.replace(/[^\w.-]/g, '_') + '.png'; }

// Copies an app's icon from where the TV keeps it, unless the copy is already there and the same size.
function copyIcon(point) {
  const dir = APP + '/tv-icons', dest = dir + '/' + iconName(point.id);
  const src = [point.largeIcon, point.icon].filter((p) => p && p.charAt(0) === '/' && fs.existsSync(p))[0];
  if (!src) return fs.existsSync(dest);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  try { if (fs.statSync(dest).size === fs.statSync(src).size) return true; } catch (e) { /* not copied yet */ }
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o644);
  return true;
}

async function tick() {
  if (!fs.existsSync(APP)) return;
  const [points, inputs] = await Promise.all([
    luna('luna://com.webos.applicationManager/listLaunchPoints'),
    luna('luna://com.webos.service.eim/getAllInputStatus')
  ]);
  if (!points || !points.launchPoints || !inputs || !inputs.devices) { log('the TV did not answer'); return; }
  const apps = [];
  titles = {};
  points.launchPoints.forEach((p) => { titles[p.id] = p.title; });
  inputs.devices.forEach((d) => { if (d.appId) titles[d.appId] = d.label || d.id; });
  points.launchPoints.filter((p) => !p.hidden).forEach((p) => {
    if (copyIcon(p)) apps.push({ id: p.id, title: p.title, icon: 'tv-icons/' + iconName(p.id), color: p.iconColor || p.bgColor || '' });
  });
  const tv = {
    apps: apps,
    inputs: inputs.devices.filter((d) => d.appId).map((d) => ({ appId: d.appId, label: d.label || d.id, connected: !!d.connected }))
  };
  const json = JSON.stringify(tv, null, 1);
  // tv-apps.js loads with the page; tv-apps.json is what the running page checks for changes. Each is checked on
  // its own: installing Ambient Home again brings back the computer's tv-apps.js.
  const page = '// Written on the TV by tv-root-live.js: its apps and inputs.\nwindow.TV_APPS = ' + json + ';\n';
  const changed = writeIfChanged(APP + '/tv-apps.js', page, null, 0o644);
  if (writeIfChanged(APP + '/tv-apps.json', json + '\n', null, 0o644) || changed) {
    log('updated: ' + apps.length + ' apps, ' + tv.inputs.length + ' inputs');
  }
  if (fs.existsSync(HELPER_STATE)) {
    const ids = apps.map((a) => a.id).filter((id) => NOT_FOR_HELPER.indexOf(id) < 0);
    writeIfChanged(HELPER_STATE + '/apps.json', JSON.stringify(ids), [5999, 5000], 0o644);
  }
}

// ---------- Running apps (Settings > Running apps) ----------
// Ambient Home's service leaves requests in its state folder; this answers them as root and keeps running.json in
// Ambient Home's folder: each running app with the memory it uses, and the TV's free memory.
const REQUESTS = '/media/developer/apps/usr/palm/services/com.local.ambienthome.service/state';
let titles = {}, handling = false;
// Running apps without a launch point of their own.
const SYSTEM_TITLES = { 'com.webos.app.home': 'LG Home', 'com.webos.app.voice': 'Voice', 'com.webos.app.livetv': 'Live TV' };

function memoryKb(pid) {
  try { return +(/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')) || [0, 0])[1]; } catch (e) { return 0; }
}

async function running() {
  const [run, front] = await Promise.all([
    luna('luna://com.webos.applicationManager/running'),
    luna('luna://com.webos.applicationManager/getForegroundAppInfo')
  ]);
  if (!run || !run.running) return null;
  return run.running.map((a) => {
    const pids = [a.processid, a.webprocessid].filter((p, i, all) => p && all.indexOf(p) === i);
    return {
      id: a.id, title: titles[a.id] || SYSTEM_TITLES[a.id] || a.id, kb: pids.reduce((sum, p) => sum + memoryKb(p), 0),
      onScreen: !!front && front.appId === a.id,
      // Left alone by Close all background apps: Ambient Home, LG's own home and overlays such as voice.
      system: a.id === 'com.local.ambienthome' || a.defaultWindowType !== 'card'
    };
  });
}

// Keep closed, in two layers. LG's preload manager restarts some apps (LG Channels, YouTube, the browser…) in the
// background a few seconds after they close, so their preloading is switched off through its own policy, which LG
// keeps across restarts; only what was switched off here is switched back on. Then any kept-closed app that has
// been off screen for 15 seconds is closed. Opening one still works; it only does not linger.
const KEEP_CLOSED = '/var/lib/webosbrew/ambient-home/keep-closed.json';
const NEVER_KEEP_CLOSED = ['com.local.ambienthome', 'com.local.nativehome', 'com.webos.app.home'];
const PRELOAD = 'luna://com.webos.service.preloadmanager/';
const offScreenSince = {}, closedAt = {};

function keepClosedState() {
  try {
    const s = JSON.parse(fs.readFileSync(KEEP_CLOSED, 'utf8'));
    return { closed: s.closed || [], preloadOff: s.preloadOff || [] };
  } catch (e) {
    return { closed: [], preloadOff: [] };
  }
}

function keepClosedList() { return keepClosedState().closed; }

async function preloadEnabled(id) {
  const policy = await luna(PRELOAD + 'getPreloadPolicy');
  const app = policy && (policy.applications || []).filter((a) => a.id === id)[0];
  return app ? app.isEnabled : null;
}

function setPreload(id, on) { return luna(PRELOAD + 'setPreloadPolicy', { application: { id: id, isEnabled: on } }); }

async function setKeepClosed(id, on) {
  const s = keepClosedState();
  s.closed = s.closed.filter((x) => x !== id);
  if (on) {
    s.closed.push(id);
    if (await preloadEnabled(id) === true) {
      await setPreload(id, false);
      if (s.preloadOff.indexOf(id) < 0) s.preloadOff.push(id);
    }
  } else if (s.preloadOff.indexOf(id) >= 0) {
    await setPreload(id, true);
    s.preloadOff = s.preloadOff.filter((x) => x !== id);
  }
  fs.writeFileSync(KEEP_CLOSED, JSON.stringify(s));
  log((on ? 'keeping closed: ' : 'no longer keeping closed: ') + id);
}

// Once a minute: preloading switched off here stays off (a firmware update could reset LG's policy).
async function keepPreloadOff() {
  const s = keepClosedState();
  for (const id of s.preloadOff) if (s.closed.indexOf(id) >= 0 && await preloadEnabled(id) === true) await setPreload(id, false);
}

// Closes the kept-closed apps that are due; true when it closed any. An app that comes straight back three times in
// ten minutes is left alone for ten minutes, rather than closed and restarted in a loop.
async function enforceKeepClosed(apps) {
  const list = keepClosedList(), now = Date.now();
  let closed = false;
  Object.keys(offScreenSince).forEach((id) => { if (!apps.some((a) => a.id === id)) delete offScreenSince[id]; });
  for (const a of apps) {
    if (a.onScreen || !offScreenSince[a.id]) offScreenSince[a.id] = now;
    if (list.indexOf(a.id) < 0 || a.onScreen || now - offScreenSince[a.id] < 15000) continue;
    const recent = (closedAt[a.id] || []).filter((t) => now - t < 600000);
    if (recent.length >= 3) continue;
    await closeApp(a.id);
    closedAt[a.id] = recent.concat(now);
    delete offScreenSince[a.id];
    log('kept closed: ' + a.id + (recent.length === 2 ? ' (it keeps coming back; leaving it for 10 minutes)' : ''));
    closed = true;
  }
  return closed;
}

async function writeRunning() {
  if (!fs.existsSync(APP)) return;
  let apps = await running();
  if (!apps) return;
  if (await enforceKeepClosed(apps)) {
    await new Promise((r) => setTimeout(r, 800));
    apps = (await running()) || apps;
  }
  const list = keepClosedList();
  apps.forEach((a) => { a.keepClosed = list.indexOf(a.id) >= 0; });
  // Kept-closed apps that are not running stay listed, so the setting can be turned off again.
  list.filter((id) => !apps.some((a) => a.id === id))
    .forEach((id) => apps.push({ id: id, title: titles[id] || SYSTEM_TITLES[id] || id, kb: 0, notRunning: true, keepClosed: true }));
  const mem = fs.readFileSync('/proc/meminfo', 'utf8');
  const kb = (name) => +((new RegExp(name + ':\\s+(\\d+)').exec(mem) || [0, 0])[1]);
  apps.sort((a, b) => b.kb - a.kb);
  writeIfChanged(APP + '/running.json', JSON.stringify({ time: Date.now(), totalKb: kb('MemTotal'),
    availableKb: kb('MemAvailable'), apps: apps }, null, 1) + '\n', null, 0o644);
}

function closeApp(id) { return luna('luna://com.webos.applicationManager/closeByAppId', { id: id }); }

// Requests: refresh, close (one app) or closeBackground. Checked every second.
async function handleRequests() {
  if (handling) return;
  handling = true;
  try {
    let files = [];
    try { files = fs.readdirSync(REQUESTS).filter((f) => /^request-[\w.-]+\.json$/.test(f)).sort(); } catch (e) { return; }
    if (!files.length) return;
    for (const f of files) {
      let req = {};
      try { req = JSON.parse(fs.readFileSync(REQUESTS + '/' + f, 'utf8')); } catch (e) { /* half written: dropped */ }
      try { fs.unlinkSync(REQUESTS + '/' + f); } catch (e) { /* gone already */ }
      if (req.action === 'close' && /^[\w.-]+$/.test(req.id || '') && req.id !== 'com.local.ambienthome') {
        await closeApp(req.id);
        log('closed ' + req.id);
      } else if (req.action === 'keepClosed' && /^[\w.-]+$/.test(req.id || '') && NEVER_KEEP_CLOSED.indexOf(req.id) < 0) {
        await setKeepClosed(req.id, req.on === true);
        if (req.on === true) await closeApp(req.id);
      } else if (req.action === 'closeBackground') {
        const apps = (await running()) || [];
        for (const a of apps) if (!a.system && !a.onScreen) await closeApp(a.id);
        log('closed background apps');
      }
    }
    await new Promise((r) => setTimeout(r, 800));
    await writeRunning();
  } catch (e) {
    log(String(e && e.stack || e));
  } finally {
    handling = false;
  }
}

// ---------- Power on: Ambient Home first ----------
// At power-on LG opens LG Home (Home Auto Launch on) or the last input (off), and Home Helper replaces it with
// Ambient Home only seconds later. When the Home button is set to Ambient Home (and Helper was not stopped with Home
// pressed three times), and the remote's power button turned the TV on (not, say, a console over HDMI-CEC): launch
// Ambient Home as the button is pressed, and for 20 seconds bring it straight back over whatever LG opens.
function homeIsOurs() {
  try {
    if (fs.existsSync(HELPER_STATE + '/blocked')) return false;
    return JSON.parse(fs.readFileSync(HELPER_STATE + '/home-control.json', 'utf8')).enabled === true;
  } catch (e) {
    return false;
  }
}

let poweringOnUntil = 0;
// Stopped with this script (an install starts a new copy), so they do not linger.
const subscriptions = [];
process.on('SIGTERM', () => {
  // Closing script's terminal hangs up the luna-send inside it.
  subscriptions.forEach((s) => s.kill());
  process.exit(0);
});

function openAmbientHome(why) {
  luna('luna://com.webos.applicationManager/launch', { id: 'com.local.ambienthome' }).then(() => log('power on: opened Ambient Home (' + why + ')'));
}

// Runs luna-send subscribed to uri, calling each(line) for each update; restarts it if it ends.
function subscribe(uri, each) {
  const sub = require('child_process').spawn('script', ['-q', '-c', 'luna-send -i ' + uri + " '{\"subscribe\":true}'", '/dev/null'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  subscriptions.push(sub);
  let buffer = '';
  sub.stdout.on('data', (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      each(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  sub.on('exit', () => setTimeout(() => subscribe(uri, each), 5000));
}

function watchPower() {
  subscribe('luna://com.webos.service.tvpower/power/getPowerState', (line) => {
    if (line.indexOf('"Prepare Power On"') < 0 || line.indexOf('"remoteKey"') < 0 || !homeIsOurs()) return;
    poweringOnUntil = Date.now() + 20000;
    openAmbientHome('power button');
  });
  subscribe('luna://com.webos.applicationManager/getForegroundAppInfo', (line) => {
    const m = /"appId":"([^"]+)"/.exec(line);
    if (!m || m[1] === 'com.local.ambienthome' || Date.now() > poweringOnUntil || !homeIsOurs()) return;
    poweringOnUntil = 0;
    openAmbientHome('over ' + m[1]);
  });
}

// Stremio's Continue watching (tv-root-stremio.js), once a minute.
let rounds = 0;
function stremio() {
  if (rounds++ % 6 || !fs.existsSync(APP)) return Promise.resolve();
  return keepPreloadOff().then(() => require('./tv-root-stremio.js').updateContinueWatching(APP, log));
}

if (alreadyRunning()) process.exit(0);
fs.writeFileSync(PID, String(process.pid));
(function loop() {
  tick().then(stremio).then(writeRunning).catch((e) => log(String(e && e.stack || e))).then(() => setTimeout(loop, EVERY));
})();
setInterval(handleRequests, 1000);
watchPower();
