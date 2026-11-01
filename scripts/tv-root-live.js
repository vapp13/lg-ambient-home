#!/usr/bin/env node
// Rooted TVs only. Keeps Ambient Home's list of the TV's apps and inputs (tv-apps.js, tv-apps.json and tv-icons/ in
// its folder) and Home Helper's list of apps up to date, so apps installed or removed on the TV and devices plugged
// in show up by themselves: no scripts/tv-sync-apps.mjs from the computer. tv-root-boot.sh starts it at boot, as
// root; it reads the TV every 10 seconds with luna-send and writes only when something changed.
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

function log(message) {
  try { fs.writeFileSync(LOG, new Date().toISOString() + ' ' + message + '\n'); } catch (e) { /* nowhere to say it */ }
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
function luna(uri) {
  return new Promise((resolve) => {
    execFile('script', ['-q', '-c', 'luna-send -n 1 -w 8000 ' + uri + ' {}', '/dev/null'],
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

if (alreadyRunning()) process.exit(0);
fs.writeFileSync(PID, String(process.pid));
(function loop() {
  tick().catch((e) => log(String(e && e.stack || e))).then(() => setTimeout(loop, EVERY));
})();
