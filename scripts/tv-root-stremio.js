// Rooted TVs only, used by tv-root-live.js. Builds Ambient Home's Continue watching row from Stremio: it reads the
// Stremio app's own sign-in from the TV's web storage, asks Stremio's server for the library with it, and writes the
// unfinished films and episodes to stremio.json in Ambient Home's folder. The sign-in key stays in this process; the
// file holds only titles, pictures and progress.
'use strict';
const fs = require('fs');
const https = require('https');

const STORAGE = '/var/lib/wam/Default/Local Storage/leveldb';
const ORIGIN = '_file://io.strem.tv-webos';

// ---------- Reading the TV's web storage (LevelDB) ----------
function varint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    b = buf[pos.i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return result;
}

function snappy(src) {
  const pos = { i: 0 }, out = Buffer.alloc(varint(src, pos));
  let o = 0;
  while (pos.i < src.length) {
    const tag = src[pos.i++], type = tag & 3;
    if (type === 0) {
      let len = tag >> 2;
      if (len >= 60) { const n = len - 59; len = src.readUIntLE(pos.i, n); pos.i += n; }
      len += 1;
      src.copy(out, o, pos.i, pos.i + len);
      pos.i += len; o += len;
    } else {
      let len, off;
      if (type === 1) { len = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[pos.i++]; }
      else if (type === 2) { len = (tag >> 2) + 1; off = src.readUInt16LE(pos.i); pos.i += 2; }
      else { len = (tag >> 2) + 1; off = src.readUInt32LE(pos.i); pos.i += 4; }
      for (let k = 0; k < len; k++, o++) out[o] = out[o - off];
    }
  }
  return out;
}

function block(file, offset, size) {
  const raw = file.subarray(offset, offset + size), type = file[offset + size];
  return type === 1 ? snappy(raw) : raw;
}

function blockEntries(data, each) {
  const restarts = data.readUInt32LE(data.length - 4), end = data.length - 4 - restarts * 4, pos = { i: 0 };
  let key = Buffer.alloc(0);
  while (pos.i < end) {
    const shared = varint(data, pos), unshared = varint(data, pos), vlen = varint(data, pos);
    key = Buffer.concat([key.subarray(0, shared), data.subarray(pos.i, pos.i + unshared)]);
    pos.i += unshared;
    each(key, data.subarray(pos.i, pos.i + vlen));
    pos.i += vlen;
  }
}

// Internal keys end with 8 bytes: sequence number << 8 | kind (1 = value, 0 = deleted).
function internal(key) {
  const tail = key.subarray(key.length - 8);
  return { user: key.subarray(0, key.length - 8), seq: tail.readUIntLE(1, 6) * 256 + 0, kind: tail[0] };
}

function readTable(path, keep) {
  const file = fs.readFileSync(path), foot = { i: file.length - 48 };
  varint(file, foot); varint(file, foot);
  const index = block(file, varint(file, foot), varint(file, foot));
  blockEntries(index, (k, handle) => {
    const h = { i: 0 }, data = block(file, varint(handle, h), varint(handle, h));
    blockEntries(data, (key, value) => { const ik = internal(key); keep(ik.user, ik.seq, ik.kind, value); });
  });
}

function readLog(path, keep) {
  const file = fs.readFileSync(path);
  let record = [];
  for (let b = 0; b < file.length; b += 32768) {
    let i = b;
    while (i + 7 <= Math.min(b + 32768, file.length)) {
      const len = file.readUInt16LE(i + 4), type = file[i + 6];
      if (!len && !type) break;
      record.push(file.subarray(i + 7, i + 7 + len));
      i += 7 + len;
      if (type === 1 || type === 4) {
        const batch = Buffer.concat(record), pos = { i: 12 };
        let seq = batch.readUIntLE(0, 6);
        const count = batch.readUInt32LE(8);
        for (let n = 0; n < count && pos.i < batch.length; n++, seq++) {
          const kind = batch[pos.i++], klen = varint(batch, pos), key = batch.subarray(pos.i, pos.i + klen);
          pos.i += klen;
          let value = Buffer.alloc(0);
          if (kind === 1) { const vlen = varint(batch, pos); value = batch.subarray(pos.i, pos.i + vlen); pos.i += vlen; }
          keep(key, seq, kind, value);
        }
        record = [];
      }
    }
  }
}

// Stremio's newest entries, by name. Web storage keys are ORIGIN \0 \1 name; values start with 0 (UTF-16) or 1 (Latin-1).
function stremioStorage() {
  const newest = {};
  const keep = (key, seq, kind, value) => {
    const k = key.toString('latin1');
    if (k.indexOf(ORIGIN) !== 0) return;
    const name = k.slice(k.indexOf('\x00\x01') + 2);
    if (newest[name] && newest[name].seq > seq) return;
    newest[name] = { seq: seq, kind: kind, value: value };
  };
  fs.readdirSync(STORAGE).forEach((f) => {
    try {
      if (/\.ldb$/.test(f)) readTable(STORAGE + '/' + f, keep);
      else if (/\.log$/.test(f)) readLog(STORAGE + '/' + f, keep);
    } catch (e) { /* a file being rewritten: the next round reads it */ }
  });
  const out = {};
  Object.keys(newest).forEach((name) => {
    const e = newest[name];
    if (e.kind !== 1 || !e.value.length) return;
    out[name] = e.value[0] === 0 ? e.value.subarray(1).toString('utf16le') : e.value.subarray(1).toString('latin1');
  });
  return out;
}

// ---------- Continue watching ----------
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host: 'api.strem.io', path: path, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('Stremio answered ' + res.statusCode)); } });
    });
    req.on('timeout', () => req.destroy(new Error('Stremio did not answer')));
    req.on('error', reject);
    req.end(data);
  });
}

// As in Stremio itself: films and series with a position saved, not removed from the library (or only watched).
function unfinished(item) {
  return item && item.state && item.state.timeOffset > 0 && (item.type === 'movie' || item.type === 'series') &&
    (!item.removed || item.temp);
}

function card(item) {
  const st = item.state, parts = String(st.video_id || '').split(':');
  const left = st.duration > st.timeOffset ? Math.round((st.duration - st.timeOffset) / 60000) : 0;
  const imdb = /^tt\d+$/.test(item._id);
  // Episode ids: tt…:season:episode (Cinemeta), kitsu:show:episode (anime).
  const where = item.type === 'movie' ? 'Film · ' :
    parts.length === 3 && /^tt/.test(parts[0]) ? 'S' + parts[1] + ' · E' + parts[2] + ' · ' :
    parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]) ? 'E' + parts[parts.length - 1] + ' · ' : '';
  return {
    id: item._id, type: item.type, name: item.name, videoId: st.video_id || item._id,
    poster: item.poster || '',
    background: imdb ? 'https://images.metahub.space/background/medium/' + item._id + '/img' : '',
    logo: imdb ? 'https://images.metahub.space/logo/medium/' + item._id + '/img' : '',
    detail: where + (left ? left + ' min left' : 'Almost done'),
    progress: st.duration ? Math.min(1, st.timeOffset / st.duration) : 0,
    lastWatched: st.lastWatched || item._mtime
  };
}

let fromServer = {}, lastServer = 0;

// Writes stremio.json in dir when Continue watching changed. The server is asked at most every 5 minutes; Stremio's
// copy on the TV, read every time, covers what was just watched here.
async function updateContinueWatching(dir, log) {
  const s = stremioStorage();
  let key = null, items = {};
  try { key = JSON.parse(s.profile).auth.key; } catch (e) { /* signed out */ }
  try { items = JSON.parse(s.library_recent).items || {}; } catch (e) { /* no local library */ }
  if (key && Date.now() - lastServer > 5 * 60000) {
    lastServer = Date.now();
    try {
      const res = await post('/api/datastoreGet', { authKey: key, collection: 'libraryItem', ids: [], all: true });
      if (res && res.result) { fromServer = {}; res.result.forEach((i) => { fromServer[i._id] = i; }); }
      else if (log) log('Stremio library: ' + (res && res.error ? res.error.message || 'error' : 'no answer'));
    } catch (e) { if (log) log('Stremio library: ' + e.message); }
  }
  const all = Object.assign({}, fromServer);
  Object.keys(items).forEach((id) => { if (!all[id] || String(items[id]._mtime) > String(all[id]._mtime)) all[id] = items[id]; });
  const list = Object.keys(all).map((id) => all[id]).filter(unfinished)
    .sort((a, b) => String(b.state.lastWatched || b._mtime).localeCompare(String(a.state.lastWatched || a._mtime)))
    .slice(0, 12).map(card);
  const json = JSON.stringify({ signedIn: !!key, items: list }, null, 1) + '\n';
  const file = dir + '/stremio.json';
  try { if (fs.readFileSync(file, 'utf8') === json) return; } catch (e) { /* new file */ }
  fs.writeFileSync(file + '.tmp', json, { mode: 0o644 });
  fs.renameSync(file + '.tmp', file);
  if (log) log('Continue watching: ' + list.length + ' items');
}

module.exports = { stremioStorage: stremioStorage, updateContinueWatching: updateContinueWatching };

// node tv-root-stremio.js --names: what Stremio keeps, without the values. --write DIR: write stremio.json once.
if (require.main === module && process.argv[2] === '--write') {
  updateContinueWatching(process.argv[3], console.log).catch((e) => console.log(String(e)));
}
if (require.main === module && process.argv[2] === '--names') {
  const s = stremioStorage();
  Object.keys(s).forEach((name) => {
    let note = '';
    try { const v = JSON.parse(s[name]); note = v && v.auth ? ' (signed in: ' + !!(v.auth && v.auth.key) + ')' : ''; } catch (e) { /* not JSON */ }
    console.log(name + ': ' + s[name].length + ' characters' + note);
  });
}
