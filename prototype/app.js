/* Ambient Home: the home screen on top of the living lakeside (scene.js): app and input rows, panels, settings,
   the Home button and the idle screen. Written in ES5 style for the TV's web engine. */
(function () {
  'use strict';

  var C = window.HOME_CONFIG;
  var ART = window.HOME_ART;

  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 27: 'back', 8: 'back', 461: 'back' };

  var stage = byId('stage');
  var ui = byId('ui');
  // The idle screen's delay: Settings' choice, kept on the TV, or config.js until one is made.
  var IDLE = 'ambientHome.idleMinutes';
  var idleMinutes = (function () {
    var saved = null;
    try { saved = localStorage.getItem(IDLE); } catch (e) { /* not saved */ }
    return saved !== null && /^\d+$/.test(saved) ? +saved : C.idleMinutes;
  })();
  var scope = ui, current = null, page = 'a', stack = [], memory = {};
  var moving = null, okDown = false, holdTimer = null;
  var idleOn = false, idleTimer = null, idleMover = null, sleepTimer = null, toastTimer = null, helpTimer = null, launchTimer = null;
  var lastWheel = 0, lastActivity = 0;

  // ---------- Helpers ----------
  function byId(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setData(e, data) { Object.keys(data).forEach(function (k) { if (data[k] != null) e.dataset[k] = data[k]; }); }
  function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function each(nodes, fn) { Array.prototype.forEach.call(nodes, fn); }
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function rand(min, max) { return min + Math.random() * (max - min); }

  // The TV canvas is always 1920x1080; in a browser it is scaled to fit the window.
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
  }

  // ---------- Building the screen ----------
  var SHINE = '<span class="shine-clip"><i class="shine"></i></span>';
  var ALL_APPS = { glyph: 'allapps', bg: ['#33405a', '#161c29'], fg: '#e2e8f4', accent: '#64748b' };

  // mode: 'dock' on the home screen, 'grid' in the All apps sheet.
  function iconTile(app, data, mode) {
    var t = el('div', 'app-icon' + (mode === 'grid' ? ' in-grid' : ''));
    setData(t, data);
    t.style.setProperty('--glow', rgba(app.accent, 0.55));
    t.innerHTML = ART.appIcon(app, mode);
    return t;
  }

  function appTile(id, row, mode) {
    var app = C.apps[id];
    return iconTile(app, { row: row, action: 'app', id: id, title: app.title, subtitle: app.subtitle || 'App', accent: app.accent }, mode);
  }

  function allAppsTile() {
    return iconTile(ALL_APPS, { row: 1, action: 'allapps', title: 'All apps', subtitle: Object.keys(C.apps).length + ' apps on this TV',
      accent: ALL_APPS.accent }, 'dock');
  }

  function inputTile(inp) {
    var ps5 = inp.art === 'ps5', t = el('div', 'input-tile' + (ps5 ? ' input-ps5' : ''));
    setData(t, { row: 2, action: 'input', id: inp.id, title: inp.title, subtitle: inp.subtitle + ' · press ' + inp.key + ' on the remote', accent: inp.accent });
    t.innerHTML = (ps5 ? '<i class="ps5-glow"></i>' : '') +
      '<div class="input-art">' + ART[inp.art](ART.uid()) + '</div>' +
      '<div class="input-text"><div class="input-name">' + esc(inp.title) + '</div><div class="input-sub">' + esc(inp.subtitle) + '</div></div>' +
      '<div class="input-key">' + esc(inp.key) + '</div>' + SHINE;
    return t;
  }

  function mediaCard(item) {
    var t = el('div', 'media-card');
    setData(t, { row: 3, action: 'media', id: item.id, accent: item.colors[2] });
    t.innerHTML = '<div class="media-face">' + ART.poster(ART.uid(), item) + '<i class="shine"></i></div>' +
      '<div class="media-info"><div class="media-title">' + esc(item.title) + '</div>' +
      '<div class="media-detail">' + esc(item.detail) + '</div>' +
      '<div class="media-progress"><span style="width:' + Math.round(item.progress * 100) + '%"></span></div></div>';
    return t;
  }

  function homeTile(item) {
    var t = el('div', 'home-tile' + (item.type === 'scene' ? ' home-scene' : ''));
    setData(t, { row: 4, action: 'home', id: item.id, accent: item.type === 'scene' ? '#6366f1' : '#f5b942' });
    renderHomeTile(t, item);
    return t;
  }

  function renderHomeTile(t, item) {
    t.classList.toggle('is-on', item.type === 'light' && item.on);
    var status = item.type === 'scene' ? item.detail : item.on ? 'On · ' + item.level + '%' : 'Off';
    t.innerHTML = '<div class="home-icon">' + (item.type === 'scene' ? ART.scene() : ART.bulb()) + '</div>' +
      '<div class="home-name">' + esc(item.name) + '</div><div class="home-state">' + esc(status) + '</div>' + SHINE;
  }

  function buildRows() {
    var apps = byId('appsTrack'), media = byId('mediaTrack'), home = byId('homeTrack');
    savedDockOrder(C.dock).forEach(function (id) { apps.appendChild(appTile(id, 1, 'dock')); });
    if (allAppsShortcut()) apps.appendChild(allAppsTile());
    buildInputs();
    if (C.media.show !== false) C.media.items.forEach(function (item) { media.appendChild(mediaCard(item)); });
    if (C.home.show !== false) C.home.items.forEach(function (item) { home.appendChild(homeTile(item)); });
    byId('mediaChip').textContent = C.media.source + ' · demo';
    byId('homeChip').textContent = C.home.source + ' · demo';
    // A row turned off in the config leaves the screen; Up and Down skip it, as they skip any row without tiles.
    var below = [];
    [['media', 'Continue watching'], ['home', 'Home']].forEach(function (r) {
      if (C[r[0]].show === false) { byId(r[0] + 'Label').style.display = byId(r[0] + 'Row').style.display = 'none'; }
      else below.push(r[1]);
    });
    below.push('All apps');
    byId('pageA').querySelector('.more-hint').innerHTML = '&darr;&nbsp; ' + below.join(' &middot; ');
    byId('settingsButton').innerHTML = ART.gear();
  }

  // ---------- Arranging apps: hold OK on an app for its menu ----------
  // Move picks the app up: Left and Right move it (Up and Down too in All apps), OK or Back puts it down.
  // Add to / Remove from Home screen pins it to the end of the Apps row or takes it off. Both orders are kept in
  // this app's storage on the TV; apps installed later go at the end of All apps.
  var DOCK_ORDER = 'ambientHome.dockOrder', GRID_ORDER = 'ambientHome.gridOrder', DOCK_MAX = 8, menuApp = null;

  function loadOrder(name) {
    try { var saved = JSON.parse(localStorage.getItem(name)); return saved instanceof Array ? saved : null; }
    catch (e) { return null; }
  }

  // Puts back saved ids that are not on screen now and that keep(id) says to keep, each after the id it followed
  // before, so an app that is reinstalled or unhidden returns to its place.
  function mergeOrder(saved, shown, keep) {
    var out = shown.slice();
    (saved || []).forEach(function (id, i) {
      if (out.indexOf(id) >= 0 || !keep(id)) return;
      var j = i - 1;
      while (j >= 0 && out.indexOf(saved[j]) < 0) j--;
      out.splice(j < 0 ? 0 : out.indexOf(saved[j]) + 1, 0, id);
    });
    return out;
  }

  // The Apps row keeps the places of pinned apps that are uninstalled; All apps keeps those of every app not shown.
  function saveDock() {
    return saveOrder(DOCK_ORDER, mergeOrder(loadOrder(DOCK_ORDER), dockIds(), function (id) { return !C.apps[id]; }));
  }

  function saveGrid() {
    var shown = [];
    each(byId('allAppsGrid').querySelectorAll('.app-icon'), function (t) { shown.push(t.dataset.id); });
    return saveOrder(GRID_ORDER, mergeOrder(loadOrder(GRID_ORDER), shown, function () { return true; }));
  }

  function saveOrder(name, order) {
    try { localStorage.setItem(name, JSON.stringify(order)); return true; } catch (e) { return false; }
  }

  function savedDockOrder(dock) {
    var saved = loadOrder(DOCK_ORDER);
    return (saved || dock).filter(function (id) { return C.apps[id] && !isHidden(id); });
  }

  // ---------- Hidden apps: Hide app in an app's menu; Settings > Hidden apps brings them back ----------
  // Hiding only leaves Ambient Home's lists: the app stays installed and in LG's own launcher.
  var HIDDEN = 'ambientHome.hiddenApps';

  function hiddenIds() { return (loadOrder(HIDDEN) || []).filter(function (id) { return C.apps[id]; }); }
  function isHidden(id) { return hiddenIds().indexOf(id) >= 0; }

  function hideApp(e) {
    var id = e.dataset.id, hidden = hiddenIds(), grid = byId('allAppsGrid'), focus = null;
    saveGrid();
    hidden.push(id);
    saveOrder(HIDDEN, hidden);
    // Focus moves to the next app in whichever list the hidden app was focused in.
    each(byId('appsTrack').querySelectorAll('[data-action="app"]'), function (t) {
      if (t.dataset.id !== id) return;
      var next = t.nextSibling || t.previousSibling;
      if (current === t) focus = next;
      if (memory['ui:1'] === t) memory['ui:1'] = next;
      t.parentNode.removeChild(t);
    });
    saveDock();
    each(grid.querySelectorAll('.app-icon'), function (t) {
      if (t.dataset.id !== id) return;
      var item = t.parentNode, next = item.nextSibling || item.previousSibling;
      if (current === t) focus = next && next.querySelector('.app-icon');
      grid.removeChild(item);
    });
    assignGridRows(grid);
    if (!current || !document.body.contains(current)) {
      setFocus(focus || memory['ui:1'] || byId('appsTrack').firstChild || byId('inputsTrack').firstChild);
    }
    showHiddenCount();
    toast(e.dataset.title + ' hidden. Settings > Hidden apps brings it back');
  }

  function openHiddenApps() {
    var list = byId('hiddenGrid'), ids = hiddenIds();
    if (!ids.length) { toast('No hidden apps'); return; }
    list.innerHTML = '';
    ids.forEach(function (id) {
      var app = C.apps[id], item = el('div', 'grid-item');
      item.appendChild(iconTile(app, { row: 0, action: 'unhide', id: id, title: app.title }, 'grid'));
      item.appendChild(el('div', 'grid-name', esc(app.title)));
      list.appendChild(item);
    });
    openOverlay(byId('hiddenApps'));
    assignGridRows(list, 0);
  }

  function unhideApp(e) {
    var id = e.dataset.id, list = byId('hiddenGrid'), item = e.parentNode, next = item.nextSibling || item.previousSibling;
    saveOrder(HIDDEN, hiddenIds().filter(function (h) { return h !== id; }));
    list.removeChild(item);
    byId('allAppsGrid').innerHTML = '';
    buildAllApps();
    assignGridRows(byId('allAppsGrid'));
    showHiddenCount();
    toast(e.dataset.title + ' is back in All apps');
    if (next) { assignGridRows(list, 0); setFocus(next.querySelector('.app-icon')); }
    else closeOverlay();
  }

  function showHiddenCount() {
    var n = hiddenIds().length;
    byId('hiddenCount').textContent = n ? n + (n === 1 ? ' app' : ' apps') : 'None';
  }

  function savedGridOrder(ids) {
    var saved = (loadOrder(GRID_ORDER) || []).filter(function (id) { return ids.indexOf(id) >= 0; });
    return saved.concat(ids.filter(function (id) { return saved.indexOf(id) < 0; }));
  }

  function dockIds() {
    var ids = [];
    each(byId('appsTrack').children, function (t) { if (t.dataset.action === 'app') ids.push(t.dataset.id); });
    return ids;
  }

  function inGrid(e) { return e.parentNode.classList.contains('grid-item'); }

  function canArrange(e) { return !stack.length && !!e && e.dataset.action === 'app'; }

  function openAppMenu(e) {
    var pinned = dockIds().indexOf(e.dataset.id) >= 0;
    menuApp = e;
    byId('appMenuTitle').textContent = e.dataset.title;
    byId('appMenuPin').textContent = pinned ? 'Remove from Home screen' : 'Add to Home screen';
    openOverlay(byId('appMenu'));
  }

  function togglePin(e) {
    var track = byId('appsTrack'), id = e.dataset.id, tile = null;
    each(track.children, function (t) { if (t.dataset.action === 'app' && t.dataset.id === id) tile = t; });
    if (tile) {
      var next = tile.nextSibling || tile.previousSibling;
      track.removeChild(tile);
      if (current === tile) setFocus(next);
      if (memory['ui:1'] === tile) memory['ui:1'] = next;
      toast(e.dataset.title + ' removed from the Home screen');
    } else if (dockIds().length >= DOCK_MAX) {
      toast('The Apps row is full: remove an app from it first');
      return;
    } else {
      track.insertBefore(appTile(id, 1, 'dock'), track.querySelector('[data-action="allapps"]'));
      toast(e.dataset.title + ' added to the Home screen');
    }
    saveDock();
  }

  // ---------- Inputs: hold OK on one to rename or hide it; Settings > Inputs can show all of them ----------
  // An input with no device name and nothing connected is unused and stays off the screen, as a hidden one does,
  // until the TV sees something connected to it.
  var INPUT_NAMES = 'ambientHome.inputNames', HIDDEN_INPUTS = 'ambientHome.hiddenInputs',
    SHOWN_INPUTS = 'ambientHome.shownInputs', ALL_INPUTS = 'ambientHome.allInputs', menuInput = null;

  function inputNames() {
    try { return JSON.parse(localStorage.getItem(INPUT_NAMES)) || {}; } catch (e) { return {}; }
  }

  function showAllInputs() {
    try { return localStorage.getItem(ALL_INPUTS) === 'on'; } catch (e) { return false; }
  }

  function inputOff(inp) {
    if (inp.connected) return false;
    if ((loadOrder(HIDDEN_INPUTS) || []).indexOf(inp.id) >= 0) return true;
    return inp.used === false && (loadOrder(SHOWN_INPUTS) || []).indexOf(inp.id) < 0;
  }

  // The input as shown: with the name given to it here, if any.
  function namedInput(inp) {
    var name = inputNames()[inp.id];
    return name ? copy(inp, { title: name }) : inp;
  }

  function buildInputs() {
    var track = byId('inputsTrack'), all = showAllInputs(), focus = null;
    var focusId = current && current.dataset.action === 'input' ? current.dataset.id : null;
    track.innerHTML = '';
    track._x = 0;
    track.style.transform = '';
    C.inputs.forEach(function (inp) {
      var off = inputOff(inp);
      if (off && !all) return;
      var t = inputTile(namedInput(inp));
      if (off) t.classList.add('is-off');
      track.appendChild(t);
      if (inp.id === focusId) focus = t;
    });
    if (focusId) setFocus(focus || track.firstChild || byId('appsTrack').firstChild);
  }

  function canInputMenu(e) { return !stack.length && !!e && e.dataset.action === 'input'; }

  function openInputMenu(e) {
    menuInput = find(C.inputs, e.dataset.id);
    byId('inputMenuTitle').textContent = e.dataset.title;
    byId('inputMenuHide').textContent = inputOff(menuInput) ? 'Show input' : 'Hide input';
    openOverlay(byId('inputMenu'));
  }

  function toggleInput(inp) {
    var off = inputOff(inp), id = inp.id;
    var hidden = (loadOrder(HIDDEN_INPUTS) || []).filter(function (x) { return x !== id; });
    var shown = (loadOrder(SHOWN_INPUTS) || []).filter(function (x) { return x !== id; });
    if (off) shown.push(id); else hidden.push(id);
    saveOrder(HIDDEN_INPUTS, hidden);
    saveOrder(SHOWN_INPUTS, shown);
    buildInputs();
    toast(off ? namedInput(inp).title + ' shown' :
      namedInput(inp).title + ' hidden until something is connected to it' + (showAllInputs() ? '' : '. Settings > Inputs shows all'));
  }

  function openRename(inp) {
    var field = byId('renameField');
    field.value = inputNames()[inp.id] || '';
    field.placeholder = inp.title;
    openOverlay(byId('renameInput'));
    field.focus();
  }

  function saveRename() {
    var field = byId('renameField'), names = inputNames(), name = field.value.replace(/\s+/g, ' ').trim();
    if (name) names[menuInput.id] = name; else delete names[menuInput.id];
    try { localStorage.setItem(INPUT_NAMES, JSON.stringify(names)); } catch (e) { /* lasts until Ambient Home closes */ }
    field.blur();
    closeOverlay();
    buildInputs();
    toast(name ? 'Renamed to ' + name : 'Back to the TV\'s name: ' + menuInput.title);
  }

  function startMoving(e) {
    moving = e;
    e.classList.add('is-moving');
    toast('Move ' + e.dataset.title + ' with the arrows, then press OK');
  }

  function shiftMoving(dir) {
    if (inGrid(moving)) {
      var items = Array.prototype.slice.call(byId('allAppsGrid').children), item = moving.parentNode;
      var i = items.indexOf(item), columns = 0;
      while (columns < items.length && items[columns].offsetTop === items[0].offsetTop) columns++;
      var j = i + ({ left: -1, right: 1, up: -columns, down: columns })[dir];
      if (j < 0 || j >= items.length || j === i) return;
      item.parentNode.insertBefore(item, j > i ? items[j].nextSibling : items[j]);
      assignGridRows(byId('allAppsGrid'));
      scrollPageB(moving);
    } else {
      if (dir === 'up' || dir === 'down') return;
      var other = dir === 'left' ? moving.previousSibling : moving.nextSibling;
      if (!other || other.dataset.action !== 'app') return;
      moving.parentNode.insertBefore(moving, dir === 'left' ? other : other.nextSibling);
    }
    setFocus(moving);
  }

  function stopMoving() {
    var e = moving, saved;
    e.classList.remove('is-moving');
    moving = null;
    saved = inGrid(e) ? saveGrid() : saveDock();
    toast(saved ? 'Order saved' : 'Could not save the order; it lasts until Ambient Home closes');
  }

  function buildAllApps() {
    var grid = byId('allAppsGrid');
    savedGridOrder(Object.keys(C.apps)).forEach(function (id) {
      if (isHidden(id)) return;
      var item = el('div', 'grid-item');
      item.appendChild(appTile(id, 0, 'grid'));
      item.appendChild(el('div', 'grid-name', esc(C.apps[id].title)));
      grid.appendChild(item);
    });
  }

  // Grid rows follow the real layout, so Up and Down match what is on screen. On the second page they come after the
  // rows above them (3 and 4), so Down from Inputs lands in the grid.
  function assignGridRows(grid, first) {
    var tops = [], base = first == null ? 5 : first;
    each(grid.querySelectorAll('.app-icon'), function (t) {
      var top = t.parentNode.offsetTop, row = tops.indexOf(top);
      if (row < 0) { tops.push(top); row = tops.length - 1; }
      t.dataset.row = base + row;
    });
  }

  // ---------- The second page: Continue watching and Home when shown, then All apps ----------
  // Its sections stack from the top, under the clock, and the page scrolls to keep the focused item in view.
  function layoutPageB() {
    var y = 34;
    [['mediaLabel', 'mediaRow'], ['homeLabel', 'homeRow'], ['gridLabel', 'allAppsGrid']].forEach(function (s) {
      var label = byId(s[0]), block = byId(s[1]);
      if (label.style.display === 'none') return;
      label.style.top = y + 'px';
      block.style.top = y + 36 + 'px';
      y += 36 + block.offsetHeight + 48;
    });
  }

  function scrollPageB(e) {
    var content = byId('pageBContent'), view = byId('pageBClip').clientHeight, y = 0, n = e, s = content._y || 0;
    while (n && n !== content) { y += n.offsetTop; n = n.offsetParent; }
    if (y + e.offsetHeight + s > view - 40) s = view - 40 - y - e.offsetHeight;
    if (y + s < 80) s = 80 - y;
    content._y = Math.min(0, s);
    content.style.transform = 'translateY(' + content._y + 'px)';
  }

  // ---------- The All apps shortcut at the end of the Apps row: a setting, on unless config.js turns it off ----------
  var SHORTCUT = 'ambientHome.allAppsShortcut';

  function allAppsShortcut() {
    var saved = null;
    try { saved = localStorage.getItem(SHORTCUT); } catch (e) { /* not saved */ }
    return saved === null ? C.allAppsShortcut !== false : saved === 'on';
  }

  function setAllAppsShortcut(on) {
    var track = byId('appsTrack'), tile = track.querySelector('[data-action="allapps"]');
    try { localStorage.setItem(SHORTCUT, on ? 'on' : 'off'); } catch (e) { /* lasts until Ambient Home closes */ }
    if (on && !tile) track.appendChild(allAppsTile());
    if (!on && tile) {
      track.removeChild(tile);
      if (memory['ui:1'] === tile) memory['ui:1'] = track.firstChild;
    }
    toast(on ? 'All apps shortcut shown on the Home screen' : 'All apps shortcut hidden: press Down for All apps');
  }

  function showShortcutChoice() {
    var on = allAppsShortcut() ? 'on' : 'off';
    each(document.querySelectorAll('[data-group="allapps"]'), function (o) { o.classList.toggle('is-selected', o.dataset.value === on); });
  }

  function buildLaunchFx() {
    var html = '<i class="ps-band"></i>', i, size, dur;
    for (i = 0; i < 18; i++) {
      size = Math.round(rand(28, 84));
      dur = rand(9, 17);
      html += '<i class="ps-shape" style="left:' + rand(2, 96).toFixed(1) + '%;width:' + size + 'px;height:' + size +
        'px;animation-duration:' + dur.toFixed(1) + 's;animation-delay:-' + rand(0, dur).toFixed(1) + 's">' + ART.psShape(i % 4) + '</i>';
    }
    byId('launchFx').innerHTML = html;
  }

  // ---------- Focus and navigation ----------
  function focusables(root) { return Array.prototype.slice.call(root.querySelectorAll('[data-row]')); }

  function rowsIn(root) {
    var map = {};
    focusables(root).forEach(function (e) { var r = +e.dataset.row; (map[r] = map[r] || []).push(e); });
    return map;
  }

  function centerX(e) { var b = e.getBoundingClientRect(); return b.left + b.width / 2; }
  function memoryKey(row) { return scope.id + ':' + row; }

  function move(dir) {
    if (!current || moving) return;
    var map = rowsIn(scope), row = +current.dataset.row, list = map[row], i = list.indexOf(current);
    if (dir === 'left' || dir === 'right') {
      var next = list[i + (dir === 'left' ? -1 : 1)];
      if (next) setFocus(next);
      return;
    }
    var keys = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
    var target = map[keys[keys.indexOf(row) + (dir === 'up' ? -1 : 1)]];
    if (!target) return;
    // On the home screen each row remembers its last item; grids line up by column instead.
    var remembered = scope === ui && memory[memoryKey(+target[0].dataset.row)];
    if (remembered && target.indexOf(remembered) >= 0) { setFocus(remembered); return; }
    var x = centerX(current), best = target[0], bestDistance = Infinity;
    target.forEach(function (e) {
      var d = Math.abs(centerX(e) - x);
      if (d < bestDistance) { bestDistance = d; best = e; }
    });
    setFocus(best);
  }

  function setFocus(e) {
    if (!e) return;
    if (current && current !== e) current.classList.remove('is-focused');
    current = e;
    e.classList.add('is-focused');
    memory[memoryKey(+e.dataset.row)] = e;
    if (scope !== ui) return;
    showPage(+e.dataset.row >= 3 ? 'b' : 'a');
    if (page === 'a') updateTitle(e);
    else scrollPageB(e);
    keepInView(e);
    parallax(e);
  }

  function showPage(p) {
    if (p === page) return;
    page = p;
    byId('pageA').classList.toggle('is-active', p === 'a');
    byId('pageB').classList.toggle('is-active', p === 'b');
    stage.classList.toggle('on-page-b', p === 'b');
  }

  function updateTitle(e) {
    var title = byId('focusTitle'), sub = byId('focusSubtitle'), box = byId('focusBox');
    if (title.textContent === e.dataset.title && sub.textContent === e.dataset.subtitle) return;
    title.textContent = e.dataset.title || '';
    sub.textContent = e.dataset.subtitle || '';
    box.classList.remove('swap');
    void box.offsetWidth;
    box.classList.add('swap');
  }

  function keepInView(e) {
    var track = e.parentNode;
    if (!track.classList.contains('track')) return;
    var view = track.parentNode.clientWidth, left = e.offsetLeft, right = left + e.offsetWidth, x = track._x || 0;
    if (right + x > view - 40) x = view - 40 - right;
    if (left + x < 0) x = -left;
    track._x = Math.min(0, x);
    track.style.transform = 'translateX(' + track._x + 'px)';
  }

  // The landscape pans a little towards whatever has focus; nearer layers move further.
  function parallax(e) { SCENE.pan(focusX(e) / 1920 * 2 - 1); }

  // Where the item will sit once its row has scrolled (rows animate, so measure the target, not the moment).
  function focusX(e) {
    var track = e.parentNode;
    if (track.classList.contains('track')) return track.parentNode.offsetLeft + (track._x || 0) + e.offsetLeft + e.offsetWidth / 2;
    var s = stage.getBoundingClientRect(), b = e.getBoundingClientRect();
    return (b.left + b.width / 2 - s.left) / s.width * 1920;
  }

  // ---------- Actions ----------
  function activate(e) {
    if (!e) return;
    var action = e.dataset.action, id = e.dataset.id;
    if (action === 'app') launchApp(id);
    else if (action === 'input') switchInput(namedInput(find(C.inputs, id)));
    else if (action === 'inputrename') { closeOverlay(); openRename(menuInput); }
    else if (action === 'inputhide') { closeOverlay(); toggleInput(menuInput); }
    else if (action === 'renamefield') byId('renameField').focus();
    else if (action === 'renamesave') saveRename();
    else if (action === 'allapps') setFocus(byId('allAppsGrid').querySelector('.app-icon'));
    else if (action === 'settings') openSettings();
    else if (action === 'forecast') openOverlay(byId('forecast'));
    else if (action === 'media') resumeMedia(find(C.media.items, id));
    else if (action === 'home') toggleHome(find(C.home.items, id), e);
    else if (action === 'seg') selectOption(e);
    else if (action === 'lghome') openLgHome();
    else if (action === 'weatherloc') toast('Your weather location is set during install.');
    else if (action === 'appmove') { closeOverlay(); startMoving(menuApp); }
    else if (action === 'apppin') { closeOverlay(); togglePin(menuApp); }
    else if (action === 'apphide') { closeOverlay(); hideApp(menuApp); }
    else if (action === 'hiddenapps') openHiddenApps();
    else if (action === 'unhide') unhideApp(e);
    else if (action === 'close') closeOverlay();
  }

  // ---------- Opening apps and inputs on the TV ----------
  // On the TV, PalmServiceBridge reaches webOS system services; each bridge is kept until it replies.
  var bridges = [];
  function onTv() { return typeof window.PalmServiceBridge === 'function'; }

  function callLuna(uri, params, done) {
    try {
      var bridge = new window.PalmServiceBridge();
      bridges.push(bridge);
      bridge.onservicecallback = function (text) {
        var result;
        try { result = JSON.parse(text); } catch (e) { result = { returnValue: false }; }
        bridges.splice(bridges.indexOf(bridge), 1);
        if (done) done(result);
      };
      bridge.call(uri, JSON.stringify(params || {}));
    } catch (e) {
      if (done) done({ returnValue: false, errorText: String(e) });
    }
  }

  // Inputs on webOS are apps too (com.webos.app.hdmi1 and so on).
  function openOnTv(appId, title) {
    if (!appId) {
      closeOverlay();
      toast(title + ' is not linked to an app on this TV yet');
      return;
    }
    callLuna('luna://com.webos.applicationManager/launch', { id: appId }, function (result) {
      if (result.returnValue !== false) return;
      closeOverlay();
      toast('Could not open ' + title);
    });
  }

  function launchApp(id) {
    var app = C.apps[id];
    openLaunch({ accent: app.accent, art: ART.appIcon(app, 'launch'), kind: 'is-app', title: app.title, sub: 'Opening…',
      note: onTv() ? '' : 'Prototype: on the TV, ' + app.title + ' opens here. Press Back to return.' });
    if (onTv()) openOnTv(app.appId, app.title);
  }

  function switchInput(inp) {
    var ps5 = inp.art === 'ps5';
    openLaunch({ accent: inp.accent, art: ART[inp.art](ART.uid()), kind: ps5 ? 'is-console' : 'is-icon', ps5: ps5,
      title: inp.title, sub: 'Switching to ' + inp.subtitle + '…',
      note: onTv() ? '' : 'Prototype: on the TV this switches to ' + inp.subtitle + '. Press Back to return.' });
    if (onTv()) openOnTv(inp.appId, inp.title);
  }

  function resumeMedia(item) {
    openLaunch({ accent: item.colors[2], art: ART.poster(ART.uid(), item), title: item.title, sub: 'Resuming · ' + item.detail,
      note: 'Prototype: on the TV this resumes in your media app.' });
  }

  function openLaunch(o) {
    var launch = byId('launch'), art = byId('launchArt');
    clearTimeout(launchTimer);
    launch.classList.toggle('is-ps5', !!o.ps5);
    launch.style.setProperty('--launch', rgba(o.accent, 0.55));
    art.className = 'launch-art' + (o.kind ? ' ' + o.kind : '');
    art.innerHTML = o.art;
    byId('launchTitle').textContent = o.title;
    byId('launchSub').textContent = o.sub;
    byId('launchNote').textContent = o.note;
    openOverlay(launch);
  }

  function toggleHome(item, tile) {
    if (item.type === 'scene') {
      C.home.items.forEach(function (x) {
        if (x.type !== 'light') return;
        x.on = x.id === 'lamp';
        if (x.on) x.level = 20;
      });
      each(byId('homeTrack').children, function (t) { renderHomeTile(t, find(C.home.items, t.dataset.id)); });
      toast('Movie night: lights dimmed');
      return;
    }
    item.on = !item.on;
    renderHomeTile(tile, item);
    toast(item.name + (item.on ? ' on' : ' off'));
  }

  function selectOption(e) {
    each(e.parentNode.children, function (o) { o.classList.toggle('is-selected', o === e); });
    if (e.dataset.group === 'inputs') {
      try { localStorage.setItem(ALL_INPUTS, e.dataset.value === 'all' ? 'on' : 'off'); } catch (err) { /* not kept */ }
      buildInputs();
      toast(e.dataset.value === 'all' ? 'All inputs shown, hidden ones dimmed' : 'Only inputs in use are shown');
    } else if (e.dataset.group === 'allapps') {
      setAllAppsShortcut(e.dataset.value === 'on');
    } else if (e.dataset.group === 'home') {
      if (onTv()) setHomeButton(e.dataset.value === 'ours');
      else toast(e.dataset.value === 'lg' ? 'Home button now opens LG Home. Switch back here any time.' : 'Home button opens this home screen.');
    } else {
      idleMinutes = +e.dataset.value;
      try { localStorage.setItem(IDLE, String(idleMinutes)); } catch (err) { /* lasts until Ambient Home closes */ }
      toast(idleMinutes ? 'Idle screen after ' + idleMinutes + ' min' : 'Idle screen off');
      resetIdle();
    }
  }

  // ---------- Home button (Home Helper) ----------
  // Settings asks this app's own service (home-service/) where the Home button goes. The service passes the choice to
  // Home Helper (helper/), which watches the remote; pressing Home three times stops Helper until it is started again.
  var HOME_SERVICE = 'luna://com.local.ambienthome.service/';
  var helper = null;

  function homeNote(text) { byId('homeNote').textContent = text; }

  function showHomeChoice(value) {
    each(document.querySelectorAll('[data-group="home"]'), function (o) { o.classList.toggle('is-selected', o.dataset.value === value); });
  }

  function openSettings() {
    if (idleOn) exitIdle();
    var top = stack[stack.length - 1];
    if (!top || top.ov.id !== 'settings') openOverlay(byId('settings'));
    if (onTv()) refreshHome();
  }

  function refreshHome() {
    homeNote('Checking the Home button…');
    callLuna(HOME_SERVICE + 'helperStatus', {}, function (s) {
      helper = s.returnValue ? s : null;
      if (!helper || !helper.installed || !helper.running) {
        showHomeChoice('lg');
        homeNote(!helper ? 'Could not reach Home Helper, so Home opens LG Home.' :
          !helper.installed ? 'Home Helper is not installed, so Home opens LG Home.' :
          helper.blocked ? 'Home was pressed three times, so it opens LG Home. Choose This home screen to turn it back on.' :
          'Home Helper is off, so Home opens LG Home. Choose This home screen to turn it on.');
        return;
      }
      callLuna(HOME_SERVICE + 'homeStatus', {}, function (r) {
        if (r.returnValue !== true || typeof r.enabled !== 'boolean') {
          homeNote('Home Helper did not answer. The Home button may still work.');
          return;
        }
        showHomeChoice(r.enabled ? 'ours' : 'lg');
        homeNote(r.enabled ? 'Home, and leaving an app, bring you here.' : 'Home opens LG Home.');
      });
    });
  }

  function setHomeButton(ours) {
    if (helper && helper.running) {
      homeNote('Changing the Home button…');
      callLuna(HOME_SERVICE + 'setHomeControl', { enabled: ours }, function (r) {
        if (r.returnValue !== true) toast('The Home button did not change. Try again.');
        refreshHome();
      });
    } else if (ours && helper && helper.installed) {
      // Starting Helper ends the stop from pressing Home three times. It keeps the last choice, so set it afterwards.
      homeNote('Starting Home Helper…');
      callLuna('luna://com.webos.applicationManager/launch', { id: 'com.local.nativehome', params: { nativeHomeStart: true } }, function (r) {
        if (r.returnValue === false) {
          toast('Could not start Home Helper');
          refreshHome();
          return;
        }
        waitForHelper(10, function (ok) {
          if (ok) setHomeButton(true);
          else {
            toast('Home Helper did not start');
            refreshHome();
          }
        });
      });
    } else refreshHome();
  }

  function waitForHelper(tries, done) {
    callLuna(HOME_SERVICE + 'helperStatus', {}, function (s) {
      if (s.returnValue && s.running) {
        helper = s;
        done(true);
      } else if (tries > 1) setTimeout(function () { waitForHelper(tries - 1, done); }, 1000);
      else done(false);
    });
  }

  // Through Helper when it runs, so it does not bring you straight back here.
  function openLgHome() {
    if (!onTv()) {
      toast('On the TV this opens LG Home once and keeps your choice.');
      return;
    }
    var running = helper && helper.running;
    callLuna(running ? HOME_SERVICE + 'openLGHome' : 'luna://com.webos.applicationManager/launch', running ? {} : { id: 'com.webos.app.home' }, function (r) {
      if (r.returnValue === false) toast('Could not open LG Home');
      else closeOverlay();
    });
  }

  // Opening "Home Helper" in LG's app list starts this app with showHelper: show the Home settings.
  function wantsHelper(raw) {
    try {
      if (raw && raw.params) raw = raw.params;
      var params = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return !!(params && params.showHelper === true);
    } catch (e) {
      return false;
    }
  }

  // ---------- Overlays ----------
  function openOverlay(ov) {
    stack.push({ ov: ov, scope: scope, focus: current });
    ov.classList.add('is-open');
    if (current) current.classList.remove('is-focused');
    scope = ov;
    current = null;
    var first = ov.querySelector('.is-selected[data-row]') || ov.querySelector('[data-row]');
    if (first) setFocus(first);
  }

  function closeOverlay() {
    var top = stack.pop();
    if (!top) return;
    top.ov.classList.remove('is-open');
    // The PS5 shapes keep animating while hidden, so switch them off once the fade-out ends.
    if (top.ov.id === 'launch') launchTimer = setTimeout(function () { top.ov.classList.remove('is-ps5'); }, 400);
    if (current) current.classList.remove('is-focused');
    scope = top.scope;
    current = null;
    setFocus(top.focus || byId('appsTrack').firstChild);
  }

  // ---------- OLED-safe idle screen ----------
  function resetIdle() {
    clearTimeout(idleTimer);
    if (idleMinutes > 0) idleTimer = setTimeout(enterIdle, idleMinutes * 60000);
  }

  function enterIdle() {
    if (idleOn) return;
    if (SCENE.lapsing()) { resetIdle(); return; }
    idleOn = true;
    byId('idle').classList.add('is-on');
    moveIdle();
    idleMover = setInterval(moveIdle, C.idleMoveSeconds * 1000);
    // Once the black screen has faded in, stop drawing the scene and the rows behind it.
    sleepTimer = setTimeout(function () { stage.classList.add('is-sleeping'); }, 1300);
  }

  function exitIdle() {
    idleOn = false;
    clearTimeout(sleepTimer);
    stage.classList.remove('is-sleeping');
    byId('idle').classList.remove('is-on');
    clearInterval(idleMover);
    resetIdle();
  }

  function moveIdle() {
    var b = byId('idleBlock');
    var x = 140 + Math.random() * (1920 - 280 - b.offsetWidth), y = 140 + Math.random() * (1080 - 280 - b.offsetHeight);
    b.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  // Small static elements still shift a few pixels every few minutes.
  function pixelShift() {
    ui.style.transform = 'translate(' + Math.round(Math.random() * 8 - 4) + 'px,' + Math.round(Math.random() * 8 - 4) + 'px)';
  }

  // ---------- Messages and preview controls ----------
  function toast(message) {
    var t = byId('toast');
    t.textContent = message;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 2600);
  }

  // The settings row shows the coordinates from config.local.js; without them the weather is a demo.
  function showWeatherLocation() {
    var w = C.weather, v = document.querySelector('[data-action="weatherloc"] .set-value');
    if (v && w.latitude != null && w.longitude != null) {
      v.textContent = w.latitude.toFixed(2) + ', ' + w.longitude.toFixed(2) + ' · live weather';
    }
  }

  function toggleHelp(show) {
    var help = byId('help');
    if (show == null) show = help.classList.contains('is-faded');
    help.classList.toggle('is-faded', !show);
    clearTimeout(helpTimer);
    if (show) helpTimer = setTimeout(function () { help.classList.add('is-faded'); }, 12000);
  }

  // ---------- Input: remote keys, Magic Remote pointer and wheel ----------
  function onKey(ev) {
    if (idleOn) { ev.preventDefault(); exitIdle(); return; }
    // Typing a name: the field gets every key except OK (save), Back and Escape (cancel) and Down (to the buttons).
    var field = byId('renameField');
    if (document.activeElement === field) {
      resetIdle();
      if (ev.keyCode === 13) { ev.preventDefault(); saveRename(); }
      else if (ev.keyCode === 27 || ev.keyCode === 461) { ev.preventDefault(); field.blur(); closeOverlay(); }
      else if (ev.keyCode === 40) { ev.preventDefault(); field.blur(); setFocus(byId('renameInput').querySelector('[data-action="renamesave"]')); }
      return;
    }
    resetIdle();
    var code = ev.keyCode;
    // Preview controls: letter keys in a browser; on the LG remote the coloured buttons (red, green, yellow,
    // blue) or, for remotes without them, the number keys 6 to 9.
    if (code === 84 || code === 403 || code === 54) { toast(SCENE.cycleTime()); return; }
    if (code === 87 || code === 404 || code === 55) { toast(SCENE.cycleWeather()); return; }
    if (code === 83 || code === 405 || code === 56) { toast(SCENE.cycleSeason()); return; }
    if (code === 68 || code === 406 || code === 57) { toast(SCENE.toggleLapse()); return; }
    if (code === 48 || code === 96) { SCENE.toggleFps(byId('fps')); return; }
    if (code === 73) { enterIdle(); return; }
    if (code === 72) { toggleHelp(); return; }
    if (!stack.length && ((code >= 49 && code <= 57) || (code >= 97 && code <= 105))) {
      var digit = String(code >= 97 ? code - 96 : code - 48), inp = null;
      C.inputs.forEach(function (x) { if (x.key === digit) inp = x; });
      if (inp) switchInput(namedInput(inp));
      return;
    }
    var key = KEYS[code];
    if (!key) return;
    ev.preventDefault();
    if (key === 'ok') {
      // The remote repeats OK while it is held: count one press until it is let go.
      if (okDown || ev.repeat) return;
      okDown = true;
    }
    if (moving) {
      if (key === 'ok' || key === 'back') stopMoving();
      else shiftMoving(key);
      return;
    }
    if (stack.length && !current) {
      if (key === 'ok' || key === 'back') closeOverlay();
      return;
    }
    if (key === 'back') {
      if (stack.length) closeOverlay();
      else if (page === 'b') setFocus(memory['ui:1'] || byId('appsTrack').firstChild);
      return;
    }
    if (key === 'ok') {
      // On an app, OK opens it when let go; held for a moment, it opens the app's menu.
      if (canArrange(current) || canInputMenu(current)) {
        var held = current;
        holdTimer = setTimeout(function () {
          holdTimer = null;
          if (held.dataset.action === 'input') openInputMenu(held); else openAppMenu(held);
        }, 600);
      } else {
        activate(current);
      }
      return;
    }
    move(key);
  }

  function onKeyUp(ev) {
    if (KEYS[ev.keyCode] !== 'ok') return;
    okDown = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; activate(current); }
  }

  // A press that never comes back up (the app hidden while OK is held) must not lock OK.
  function releaseOk() {
    okDown = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  }

  function targetOf(ev) { return ev.target && ev.target.closest ? ev.target.closest('[data-row]') : null; }

  function onPointerMove(ev) {
    if (idleOn) {
      if (Math.abs(ev.movementX || 0) + Math.abs(ev.movementY || 0) > 4) exitIdle();
      return;
    }
    var now = Date.now();
    if (now - lastActivity > 1000) { lastActivity = now; resetIdle(); }
    var t = targetOf(ev);
    if (t && t !== current && !moving && scope.contains(t)) setFocus(t);
  }

  // Magic Remote: holding the button on an app opens its menu, as holding OK does; the click that follows is dropped.
  var pointerHold = null, pointerHeld = false;

  function onPointerDown(ev) {
    var t = targetOf(ev);
    pointerHeld = false;
    clearTimeout(pointerHold);
    if (idleOn || moving || !(canArrange(t) || canInputMenu(t))) return;
    pointerHold = setTimeout(function () {
      pointerHeld = true;
      setFocus(t);
      if (t.dataset.action === 'input') openInputMenu(t); else openAppMenu(t);
    }, 600);
  }

  function onPointerUp() { clearTimeout(pointerHold); }

  function onClick(ev) {
    if (pointerHeld) { pointerHeld = false; return; }
    if (idleOn) { exitIdle(); return; }
    if (moving) { stopMoving(); return; }
    if (stack.length && !current) { closeOverlay(); return; }
    var t = targetOf(ev);
    if (t && scope.contains(t)) { setFocus(t); activate(t); }
    else if (stack.length && ev.target.classList.contains('sheet')) closeOverlay();
  }

  function onWheel(ev) {
    var now = Date.now();
    if (now - lastWheel < 280) return;
    lastWheel = now;
    if (idleOn) { exitIdle(); return; }
    resetIdle();
    move(ev.deltaY > 0 ? 'down' : 'up');
  }

  // Test hook for measuring on the TV through the inspector, for example
  // homeDebug.auto(false); homeDebug.quality(0); homeDebug.scene({ time: 'night', weather: 'snow', season: 'winter' }).
  window.homeDebug = {
    scene: SCENE.preview,
    quality: SCENE.quality,
    auto: SCENE.auto,
    idle: function (minutes) { idleMinutes = minutes; resetIdle(); }
  };

  // ---------- This TV's apps and inputs ----------
  // scripts/tv-sync-apps.mjs fetches them into tv-apps.js; without that file the demo lists in config.js stay.
  // Apps in config.js are matched by their appId on the TV and keep their drawn logo; any other app shows the TV's
  // own icon.

  function copy(base, extra) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    for (k in extra) out[k] = extra[k];
    return out;
  }

  function useTvApps(tv) {
    var apps = {}, drawn = {}, inputIds = tv.inputs.map(function (d) { return d.appId; });
    Object.keys(C.apps).forEach(function (key) { if (C.apps[key].appId) drawn[C.apps[key].appId] = key; });
    tv.apps.forEach(function (a) {
      if (a.id === 'com.local.ambienthome' || inputIds.indexOf(a.id) >= 0) return;
      var key = drawn[a.id], color = /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#64748b';
      if (key && C.apps[key]) {
        apps[key] = copy(C.apps[key], { appId: a.id, subtitle: key === 'iptv' ? 'Live TV · ' + a.title : C.apps[key].subtitle });
      } else {
        apps[a.id] = { title: a.title, appId: a.id, icon: a.icon, accent: color, bg: color, fg: '#ffffff' };
      }
    });
    C.apps = apps;
    C.dock = C.dock.filter(function (key) { return apps[key]; });
    C.inputs = tvInputs(tv);
  }

  function tvInputs(tv) {
    return tv.inputs.map(function (d, i) {
      var n = (/hdmi(\d)/.exec(d.appId) || [])[1] || String(i + 1), ps5 = /ps5|playstation/i.test(d.label);
      var named = !ps5 && d.label && !/^hdmi\s*\d$/i.test(d.label);
      return {
        used: ps5 || !!named || !!d.connected, connected: !!d.connected,
        id: 'hdmi' + n, appId: d.appId, key: n, title: ps5 ? 'PS5' : named ? d.label : 'HDMI ' + n,
        subtitle: ps5 || named ? 'HDMI ' + n : 'Unnamed device', art: ps5 ? 'ps5' : 'hdmi', accent: ps5 ? '#2563eb' : '#64748b'
      };
    });
  }

  // ---------- The live list of apps and inputs (rooted TVs) ----------
  // scripts/tv-root-live.js rewrites tv-apps.json on the TV when an app is installed or removed or a device is
  // plugged in. A change of inputs updates the Inputs row in place; a change of apps reloads the page, once no menu
  // is open and nothing is being moved.
  function watchTvApps() {
    var known = window.TV_APPS || null, appsChanged = false;
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function check() {
      if (appsChanged) { reloadWhenFree(); return; }
      var x = new XMLHttpRequest();
      x.onload = function () {
        var tv;
        try { tv = JSON.parse(x.responseText); } catch (e) { return; }
        if (!tv || !tv.apps || !tv.inputs || (known && same(tv, known))) return;
        appsChanged = !known || !same(tv.apps, known.apps);
        known = tv;
        if (appsChanged) reloadWhenFree();
        else { C.inputs = tvInputs(tv); buildInputs(); }
      };
      x.open('GET', 'tv-apps.json');
      x.send();
    }
    // Once per list: if the page still loads an older one, it carries on with that rather than reloading again.
    function reloadWhenFree() {
      if (stack.length || moving || okDown) return;
      var mark = JSON.stringify(known.apps).length + ':' + known.apps.map(function (a) { return a.id; }).join(',');
      try {
        if (sessionStorage.getItem('ambientHome.reloadedFor') === mark) { appsChanged = false; return; }
        sessionStorage.setItem('ambientHome.reloadedFor', mark);
      } catch (e) { /* reload anyway */ }
      location.reload();
    }
    setInterval(function () { if (!document.hidden) check(); }, 10000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  }

  // ---------- Start ----------
  if (window.TV_APPS) useTvApps(window.TV_APPS);
  if (onTv()) watchTvApps();
  if (/Web0S|webOS/i.test(navigator.userAgent)) document.body.classList.add('on-tv');
  fit();
  window.addEventListener('resize', fit);
  // The living lakeside rests while the idle screen is up.
  SCENE.mount(stage, { paused: function () { return idleOn; } });
  byId('wallpaper').appendChild(el('div', 'dim fill'));
  buildRows();
  buildAllApps();
  layoutPageB();
  assignGridRows(byId('allAppsGrid'));
  showShortcutChoice();
  showHiddenCount();
  each(document.querySelectorAll('[data-group="inputs"]'), function (o) { o.classList.toggle('is-selected', (o.dataset.value === 'all') === showAllInputs()); });
  each(document.querySelectorAll('[data-group="idle"]'), function (o) { o.classList.toggle('is-selected', +o.dataset.value === idleMinutes); });
  buildLaunchFx();
  setFocus(byId('appsTrack').firstChild);
  moveIdle();
  resetIdle();
  showWeatherLocation();
  // The preview controls are for trying it out in a browser; on the TV the coloured buttons still work, unannounced.
  toggleHelp(!onTv());
  setInterval(pixelShift, 180000);
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseOk);
  if (window.PalmSystem && wantsHelper(window.PalmSystem.launchParams)) openSettings();
  document.addEventListener('webOSRelaunch', function (ev) { if (wantsHelper(ev.detail)) openSettings(); });
  // When an app takes over the screen, put the home screen back so it is ready when you return.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseOk();
    if (document.hidden && moving) stopMoving();
    if (document.hidden && stack.length && stack[stack.length - 1].ov.id === 'launch') closeOverlay();
  });
  stage.addEventListener('mousemove', onPointerMove);
  stage.addEventListener('click', onClick);
  stage.addEventListener('mousedown', onPointerDown);
  stage.addEventListener('mouseup', onPointerUp);
  stage.addEventListener('mouseleave', onPointerUp);
  stage.addEventListener('wheel', onWheel, { passive: true });
}());
