// ==UserScript==
// @name         Xリスト強化 — リポスト振り分け＋既読ライン
// @namespace    xlr.local
// @version      8.12.2
// @updateURL    https://raw.githubusercontent.com/sitimi-lab/x-list-reader-dist/main/x-list-reader.meta.js
// @downloadURL  https://raw.githubusercontent.com/sitimi-lab/x-list-reader-dist/main/x-list-reader.user.js
// @description  X（旧Twitter）で、アカウントごとにリポストを振り分け、「ここまで読んだ」線から古い投稿をグレーアウトします
// @match        *://x.com/*
// @match        *://twitter.com/*
// @match        *://mobile.twitter.com/*
// @run-at       document-start
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;
  if (window.__xlrLoaded) return;
  window.__xlrLoaded = true;
  var VERSION = '8.12.2';

  /* ================= 保存領域 ================= */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var CFG_KEY = 'xlr:cfg', RULES_KEY = 'xlr:rules', OLD_BLOCK_KEY = 'xlr:rpblock';

  var cfg = Object.assign({
    repostMode: 'rules',   // off / rules / all
    readStyle: 'dim',      // dim / dim2 / hide
    showChips: true,       // 未設定のリポストにだけ選択ボタンを出す
    bottomBar: 'scroll',   // 下部バー: off / scroll（下スクロール中は隠す）/ always
    autoHomeTab: true,     // ホームを開いたら最初のリストタブへ
    autoProfileAll: true,  // プロフィールは「すべて」タブへ
    open: false,
    manualPages: []
  }, store.get(CFG_KEY, {}));
  if (!Array.isArray(cfg.manualPages)) cfg.manualPages = [];
  if (cfg.repostMode === 'users') cfg.repostMode = 'rules';
  if (typeof cfg.showChips !== 'boolean') cfg.showChips = true;
  function saveCfg() { store.set(CFG_KEY, cfg); }

  // rules: { key: {n:表示名, i:アカウントID, r:'deny'|'allow'} }
  var rules = store.get(RULES_KEY, null);
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    rules = {};
    var legacy = store.get(OLD_BLOCK_KEY, []);
    if (Array.isArray(legacy)) legacy.forEach(function (k) {
      rules[k] = { n: k.charAt(0) === '#' ? k.slice(1) : '', i: k.charAt(0) === '#' ? '' : k, r: 'deny' };
    });
    store.set(RULES_KEY, rules);
  }
  function saveRules() { store.set(RULES_KEY, rules); }

  // 旧バージョンで「○○さんがリポスト」のまま保存された名前を掃除する
  function tidyNames() {
    var changed = false;
    Object.keys(rules).forEach(function (k) {
      var v = rules[k];
      if (!v || !v.n) return;
      var c = cleanName(v.n);
      if (c !== v.n) { v.n = c; changed = true; }
    });
    if (changed) saveRules();
  }

  var undoState = null;
  var scopeKey = null, isList = false, active = false;
  var markId = null;   // このIDより古い投稿をグレーアウト

  function markKey(k) { return 'xlr:mark:' + k; }
  function loadMark(k) {
    var v = k ? store.get(markKey(k), null) : null;
    if (typeof v === 'string') v = { id: v, t: 0 };      // 旧形式からの移行
    markId = (v && v.id) ? v.id : null;
  }
  function saveMark() {
    if (!scopeKey) return;
    // 解除した事実も他端末へ伝える必要があるので、消さずに空で残す
    store.set(markKey(scopeKey), { id: markId || null, t: Date.now() });
    schedulePush();
  }

  // ツイートIDは時系列で増える数値文字列。桁数→辞書順で大小比較する
  function cmpId(a, b) {
    if (a === b) return 0;
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : 1;
  }
  function olderThan(id, mark) {
    if (!mark || !id) return false;
    return cmpId(id, mark) < 0;
  }
  // 線を引いたポスト自身も既読側に含める
  function atOrOlder(id, mark) {
    if (!mark || !id) return false;
    return id === mark || olderThan(id, mark);
  }

  /* ================= 端末間の同期（GitHub Gist） ================= */
  var SYNC_KEY = 'xlr:sync', SYNC_FILE = 'x-list-reader.json';
  var SYNC_CFG_KEYS = ['repostMode', 'readStyle', 'showChips', 'bottomBar', 'manualPages',
                       'autoHomeTab', 'autoProfileAll'];
  var sync = Object.assign({ token: '', gist: '', last: 0 }, store.get(SYNC_KEY, {}));
  var syncMsg = '';
  function saveSync() { store.set(SYNC_KEY, sync); }
  function connected() { return !!(sync.token && sync.gist); }

  function httpJSON(method, url, body, cb) {
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + sync.token,
      'Content-Type': 'application/json'
    };
    var data = body ? JSON.stringify(body) : null;
    function done(status, text) {
      var json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) {}
      cb(status, json);
    }
    var gm = null;
    try {
      if (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) gm = GM.xmlHttpRequest;
      else if (typeof GM_xmlhttpRequest === 'function') gm = GM_xmlhttpRequest;
    } catch (e) {}
    if (gm) {
      try {
        gm({
          method: method, url: url, headers: headers, data: data, timeout: 20000,
          onload: function (r) { done(r.status, r.responseText); },
          onerror: function () { done(0, ''); },
          ontimeout: function () { done(0, ''); }
        });
        return;
      } catch (e) {}
    }
    if (typeof fetch === 'function') {
      fetch(url, { method: method, headers: headers, body: data })
        .then(function (r) { return r.text().then(function (t) { done(r.status, t); }); })
        .catch(function () { done(0, ''); });
    } else done(0, '');
  }

  function pickCfg() {
    var o = {};
    for (var i = 0; i < SYNC_CFG_KEYS.length; i++) o[SYNC_CFG_KEYS[i]] = cfg[SYNC_CFG_KEYS[i]];
    return o;
  }

  function allMarks() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('xlr:mark:') !== 0) continue;
        var v = store.get(k, null);
        if (v == null) continue;
        if (typeof v === 'string') v = { id: v, t: 0 };
        out[k.slice(9)] = { id: v.id || null, t: v.t || 0 };
      }
    } catch (e) {}
    return out;
  }

  function snapshot() {
    return { v: 1, cfg: { t: cfg.t || 0, value: pickCfg() }, rules: rules, marks: allMarks() };
  }

  // 項目ごとに新しい方を採用する
  function mergeRemote(remote) {
    var changed = false, i;
    if (remote && remote.cfg && (remote.cfg.t || 0) > (cfg.t || 0)) {
      var v = remote.cfg.value || {};
      for (i = 0; i < SYNC_CFG_KEYS.length; i++) {
        var k = SYNC_CFG_KEYS[i];
        if (v[k] !== undefined) cfg[k] = v[k];
      }
      cfg.t = remote.cfg.t; saveCfg(); changed = true;
    }
    var rr = (remote && remote.rules) || {};
    Object.keys(rr).forEach(function (k) {
      var a = rules[k], b = rr[k];
      if (!b) return;
      if (!a || (b.t || 0) > (a.t || 0)) { rules[k] = b; changed = true; }
    });
    if (changed) saveRules();
    var rm = (remote && remote.marks) || {};
    Object.keys(rm).forEach(function (k) {
      var b = rm[k];
      var a = store.get('xlr:mark:' + k, null);
      if (typeof a === 'string') a = { id: a, t: 0 };
      if (!a || (b.t || 0) > (a.t || 0)) {
        store.set('xlr:mark:' + k, { id: b.id || null, t: b.t || 0 });
        if (k === scopeKey) markId = b.id || null;
        changed = true;
      }
    });
    return changed;
  }

  function setSyncMsg(m) { syncMsg = m; renderSync(); }

  var syncing = false, pushTimer = null, lastSent = '';
  function schedulePush() {
    if (!connected()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { syncNow(); }, 2500);
  }

  function syncNow(cb) {
    if (!connected()) { setSyncMsg('未設定'); if (cb) cb(false); return; }
    if (syncing) { if (cb) cb(false); return; }
    syncing = true;
    setSyncMsg('同期中…');
    httpJSON('GET', 'https://api.github.com/gists/' + sync.gist, null, function (st, j) {
      if (st !== 200 || !j) {
        syncing = false;
        setSyncMsg(st === 401 || st === 403 ? 'トークンが無効です' : st === 404 ? 'Gistが見つかりません' : '取得に失敗');
        if (cb) cb(false); return;
      }
      var f = j.files && j.files[SYNC_FILE];
      var remote = null;
      try { remote = f && f.content ? JSON.parse(f.content) : null; } catch (e) {}
      var changed = remote ? mergeRemote(remote) : false;
      var text = JSON.stringify(snapshot());
      if (f && f.content === text) {   // 変わっていなければ送らない
        syncing = false; sync.last = Date.now(); saveSync(); setSyncMsg('');
        if (changed) { syncPanel(); scheduleScan(); }
        if (cb) cb(true); return;
      }
      var body = { files: {} };
      body.files[SYNC_FILE] = { content: text };
      httpJSON('PATCH', 'https://api.github.com/gists/' + sync.gist, body, function (st2) {
        syncing = false;
        if (st2 === 200) { lastSent = text; sync.last = Date.now(); saveSync(); setSyncMsg(''); }
        else setSyncMsg('送信に失敗');
        if (changed) { syncPanel(); scheduleScan(); }
        if (cb) cb(st2 === 200);
      });
    });
  }

  function createGist(cb) {
    var body = { description: 'Xリスト強化 同期データ', public: false, files: {} };
    body.files[SYNC_FILE] = { content: JSON.stringify(snapshot()) };
    httpJSON('POST', 'https://api.github.com/gists', body, function (st, j) {
      if ((st === 201 || st === 200) && j && j.id) { sync.gist = j.id; saveSync(); cb(true); }
      else cb(false);
    });
  }

  function connectSync(raw) {
    var v = String(raw || '').trim();
    if (!v) return;
    var m = v.match(/^xlrsync:([^:\s]+):([^:\s]+)$/);
    if (m) { sync.token = m[1]; sync.gist = m[2]; saveSync(); syncNow(); return; }
    sync.token = v; saveSync();
    if (sync.gist) { syncNow(); return; }
    setSyncMsg('接続中…');
    createGist(function (okc) {
      if (!okc) { setSyncMsg('作成に失敗（トークンを確認してください）'); return; }
      syncNow();
    });
  }

  /* ================= スタイル ================= */
  var LINE = '#ff8a00';   // 既読の境目の色
  var FONT = '-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Helvetica Neue",Arial,sans-serif';

  var CSS = [
    '.xlr-off{display:none !important;}',
    /* セル自体ではなく中身を薄くする。こうすると境目の線が薄まらない */
    '.xlr-faded > *{opacity:.42 !important;filter:grayscale(.8);}',
    '.xlr-faded2 > *{opacity:.24 !important;filter:grayscale(.9);}',
    '.xlr-line{box-shadow:inset 0 3px 0 0 ' + LINE + ' !important;}',
    '.xlr-fallback-line{box-shadow:inset 0 3px 0 0 #1d9bf0 !important;}',
    /* 説明は疑似要素にし、投稿のグレー表示で薄まらないようにする */
    '.xlr-fallback-line::before{content:"既読の境目（元のポストが見つかりません）";',
    'display:block;padding:7px 12px 4px;color:#1d9bf0;font:11px/1.5 ' + FONT + ';}',
    '@media (hover:hover) and (pointer:fine){',
      '.xlr-chip:hover{border-color:#8b98a5;color:#e7e9ea;}',
    '}',
    '.xlr-hidebar{opacity:0 !important;pointer-events:none !important;transition:opacity .12s;}',
    /* 下のバーが消えたぶん、右下の投稿ボタンと左下の起動ボタンを下げる */
    /* transform を使うとXのホバー演出と取り合いになって震えるので translate を使う */
    '.xlr-shiftdown{translate:0 var(--xlr-shift,53px) !important;}',
    '#xlr-fab,#xlr-panel,.xlr-shiftdown{transition:translate .15s ease;}',
    '.xlr-faded,.xlr-faded2{-webkit-tap-highlight-color:transparent;}',
    '.xlr-chip,.xlr-mark{-webkit-tap-highlight-color:transparent;-webkit-appearance:none;',
    'font-family:' + FONT + ' !important;font-style:normal !important;letter-spacing:0;}',
    '.xlr-chip{display:inline-flex;align-items:center;margin-left:6px;padding:2px 9px;',
    'border:1px solid #536471;border-radius:999px;background:transparent;color:#8b98a5;',
    'font-size:11px;line-height:1.5;cursor:pointer;white-space:nowrap;vertical-align:middle;}',
    '.xlr-chip.deny{border-color:#f4212e;color:#f4212e;}',
    '.xlr-chip.allow{border-color:#00ba7c;color:#00ba7c;}',
    '.xlr-mark{display:inline-flex;align-items:center;justify-content:center;height:26px;',
    'padding:0 10px;margin-left:4px;border:1px solid #536471;border-radius:999px;background:transparent;',
    'color:#8b98a5;font-size:11px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap;}',
    '.xlr-mark.on{background:' + LINE + ';border-color:' + LINE + ';color:#fff;}',
    '#xlr-fab{position:fixed;left:12px;z-index:2147483000;width:42px;height:42px;border-radius:50%;',
    'border:1px solid #38444d;background:#1d9bf0;color:#fff;font-size:15px;font-weight:700;line-height:1;',
    'display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.45);',
    'cursor:pointer;-webkit-appearance:none;-webkit-tap-highlight-color:transparent;',
    'bottom:calc(74px + env(safe-area-inset-bottom,0px));}',
    '#xlr-fab{font-family:' + FONT + ';}',
    '#xlr-fab.xlr-idle{background:#2a343d;color:#8b98a5;}',
    '@media (min-width:701px){#xlr-fab{bottom:18px;}}',
    '#xlr-panel{position:fixed;left:12px;z-index:2147483001;width:250px;max-width:calc(100vw - 24px);',
    'bottom:calc(124px + env(safe-area-inset-bottom,0px));max-height:70vh;overflow-y:auto;',
    'font:12px/1.7 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic UI",sans-serif;',
    'color:#e7e9ea;background:rgba(20,26,33,.98);border:1px solid #38444d;border-radius:14px;',
    'padding:10px 12px 12px;box-shadow:0 10px 32px rgba(0,0,0,.5);-webkit-overflow-scrolling:touch;}',
    '@media (min-width:701px){#xlr-panel{bottom:70px;}}',
    '#xlr-panel[hidden]{display:none !important;}',
    '#xlr-panel h4{margin:0 0 6px;font-size:12px;font-weight:700;}',
    '#xlr-version{float:right;color:#8b98a5;font-size:10px;font-weight:400;}',
    '#xlr-panel label{display:flex;align-items:center;gap:6px;cursor:pointer;padding:1px 0;}',
    '#xlr-panel input[type=checkbox]{accent-color:#1d9bf0;width:15px;height:15px;margin:0;flex:0 0 auto;}',
    '#xlr-panel *{font-family:' + FONT + ';}',
    '#xlr-panel select{background:#0f1419;color:#e7e9ea;border:1px solid #38444d;border-radius:6px;',
    'font-size:11px;padding:2px 4px;max-width:132px;}',
    '#xlr-panel input[type=text]{flex:1 1 auto;min-width:0;background:#0f1419;color:#e7e9ea;',
    'border:1px solid #38444d;border-radius:6px;font-size:11px;padding:3px 6px;-webkit-appearance:none;}',
    '.xlr-row{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 0;}',
    '.xlr-sec{margin-top:7px;padding-top:6px;border-top:1px solid #2a343d;}',
    '.xlr-cap{color:#8b98a5;font-size:11px;}',
    '.xlr-list{max-height:74px;overflow-y:auto;margin:2px 0 4px;}',
    '.xlr-list .xlr-b{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:1px 0;}',
    '.xlr-list .xlr-b span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;}',
    '.xlr-list .xlr-b span i{color:#8b98a5;font-style:normal;}',
    '.xlr-list .xlr-b button{background:none;border:0;color:#f4212e;font-size:14px;line-height:1;',
    'cursor:pointer;padding:0 3px;-webkit-appearance:none;}',
    '#xlr-stat{color:#8b98a5;font-size:11px;}',
    '.xlr-btns{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}',
    '.xlr-btns button{flex:1 1 auto;background:#1d9bf0;color:#fff;border:0;border-radius:999px;',
    'font-size:11px;padding:5px 8px;cursor:pointer;white-space:nowrap;-webkit-appearance:none;}',
    '.xlr-btns button.sub{background:#2a343d;color:#c8d1d9;}',
    '.xlr-primary{display:block;width:100%;margin-top:7px;background:' + LINE + ';color:#fff;',
    'border:0;border-radius:999px;font-size:13px;font-weight:700;padding:9px 8px;cursor:pointer;',
    '-webkit-appearance:none;-webkit-tap-highlight-color:transparent;font-family:' + FONT + ';',
    'box-shadow:0 2px 10px rgba(255,138,0,.35);}',
    '.xlr-primary:disabled{background:#2a343d;color:#8b98a5;box-shadow:none;}',
    '.xlr-add{display:flex;gap:4px;align-items:center;margin-top:3px;}',
    '.xlr-add button{background:#2a343d;color:#c8d1d9;border:0;border-radius:999px;font-size:11px;',
    'padding:4px 8px;cursor:pointer;-webkit-appearance:none;flex:0 0 auto;}',
    '#xlr-undo{display:none;width:100%;margin-top:4px;background:#536471;color:#fff;border:0;',
    'border-radius:999px;font-size:11px;padding:5px 8px;cursor:pointer;-webkit-appearance:none;}'
  ].join('');

  /* ================= DOM判定 ================= */
  var REPOST_RE = /リポスト|リツイート|repost|retweet/i;
  var PINNED_RE = /固定|Pinned/i;
  // 「○○さんがリポストしました」「○○がリポスト」「Alice reposted」など、末尾の定型句を落とす
  var TAIL_RE = [
    /\s*さん\s*が\s*(リポスト|リツイート)\s*(しました)?\s*$/,
    /\s*が\s*(リポスト|リツイート)\s*(しました)?\s*$/,
    /\s*(リポスト|リツイート)\s*(しました)?\s*$/,
    /\s+(reposted|retweeted)\s*$/i
  ];
  function cleanName(t) {
    var n = String(t || '').replace(/\s+/g, ' ').trim();
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < TAIL_RE.length; i++) n = n.replace(TAIL_RE[i], '').trim();
    }
    return n.replace(/^@/, '').trim();
  }
  var RESERVED = ['i', 'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose', 'status'];

  function socialCtx(a) {
    var el = a.querySelector('[data-testid="socialContext"]');
    if (el) return el;
    var c = a.closest('[data-testid="cellInnerDiv"]');   // articleの外に出ている場合
    return c ? c.querySelector('[data-testid="socialContext"]') : null;
  }
  function cellOf(a) { return a.closest('[data-testid="cellInnerDiv"]') || a.parentElement; }
  function articles() { return document.querySelectorAll('article[data-testid="tweet"]'); }
  function actionBar(a) { return a.querySelector('[role="group"]') || a; }

  function isRepost(article) {
    var sc = socialCtx(article);
    if (!sc) return false;
    var t = sc.textContent || '';
    if (PINNED_RE.test(t)) return false;
    return REPOST_RE.test(t);
  }

  function reposterInfo(article) {
    var sc = socialCtx(article);
    if (!sc) return null;
    var id = null;
    var a = sc.closest('a[href^="/"]') || sc.querySelector('a[href^="/"]');
    if (a) {
      var m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/);
      if (m && RESERVED.indexOf(m[1]) === -1) id = m[1];
    }
    var name = cleanName(sc.textContent || '');
    var key = id || (name ? '#' + name : null);
    if (!key) return null;
    return { key: key, id: id || '', name: name };
  }

  function tweetId(article) {
    var timeEl = article.querySelector('a[href*="/status/"] time');
    var a = timeEl ? timeEl.closest('a') : article.querySelector('a[href*="/status/"]');
    if (!a) return null;
    var m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function ruleOf(key) { return rules[key] ? rules[key].r : null; }

  function setRule(key, info, r) {
    undoState = { key: key, prev: rules[key] ? Object.assign({}, rules[key]) : null };
    // 削除も「消したという記録」として残す（他端末で復活しないように）
    rules[key] = {
      n: (info && info.name) || (rules[key] && rules[key].n) || '',
      i: (info && info.id) || (rules[key] && rules[key].i) || '',
      r: r,
      t: Date.now()
    };
    saveRules(); renderRules(); scheduleScan(); schedulePush();
  }

  function undo() {
    if (!undoState) return;
    if (undoState.prev) rules[undoState.key] = Object.assign({}, undoState.prev, { t: Date.now() });
    else rules[undoState.key] = { n: '', i: '', r: null, t: Date.now() };
    undoState = null;
    saveRules(); renderRules(); scheduleScan(); schedulePush();
  }

  /* ================= タイムライン内のボタン ================= */
  function clearChips(article) {
    var c = article.querySelectorAll('.xlr-chip');
    for (var i = 0; i < c.length; i++) c[i].remove();
  }
  function clearMarkBtn(article) {
    var c = article.querySelectorAll('.xlr-mark');
    for (var i = 0; i < c.length; i++) c[i].remove();
  }

  function syncChips(article, info) {
    var sc = socialCtx(article);
    var host = sc && (sc.parentElement || sc);
    if (!host) return;
    var deny = host.querySelector('.xlr-chip.deny');
    var allow = host.querySelector('.xlr-chip.allow');
    if (!deny) {
      deny = document.createElement('button');
      deny.type = 'button'; deny.className = 'xlr-chip deny'; deny.textContent = '隠す';
      host.appendChild(deny);
    }
    if (!allow) {
      allow = document.createElement('button');
      allow.type = 'button'; allow.className = 'xlr-chip allow'; allow.textContent = '常に表示';
      host.appendChild(allow);
    }
    [deny, allow].forEach(function (b) {
      b.dataset.xlrKey = info.key; b.dataset.xlrName = info.name; b.dataset.xlrId = info.id;
    });
    deny.dataset.xlrAct = 'deny'; allow.dataset.xlrAct = 'allow';
  }

  function syncMarkBtn(article, id) {
    var bar = actionBar(article);
    if (!bar) return;
    var b = bar.querySelector('.xlr-mark');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button'; b.className = 'xlr-mark';
      bar.appendChild(b);
    }
    b.dataset.xlrTweet = id;
    var on = (markId === id);
    b.classList.toggle('on', on);
    b.textContent = on ? 'ここまで ✓' : 'ここまで';
    b.title = on ? '既読の線を解除' : 'これより古い投稿をグレーアウトする';
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var chip = t.closest('.xlr-chip');
    if (chip) {
      e.preventDefault(); e.stopPropagation();
      setRule(chip.dataset.xlrKey, { name: chip.dataset.xlrName || '', id: chip.dataset.xlrId || '' }, chip.dataset.xlrAct);
      return;
    }
    var mk = t.closest('.xlr-mark');
    if (mk) {
      e.preventDefault(); e.stopPropagation();
      var id = mk.dataset.xlrTweet;
      markId = (markId === id) ? null : id;
      saveMark(); scheduleScan();
    }
  }, true);

  /* ================= 適用 ================= */
  function fadeClass() { return cfg.readStyle === 'dim2' ? 'xlr-faded2' : 'xlr-faded'; }

  // 1件ぶんの下ごしらえ。表示状態は後段でまとめて決める
  function prep(article) {
    var c = cellOf(article);
    if (!c) return null;
    c.classList.remove('xlr-off', 'xlr-faded', 'xlr-faded2', 'xlr-line', 'xlr-fallback-line');
    delete c.dataset.xlrRepost;
    delete c.dataset.xlrId;
    delete c.dataset.xlrJumpDip;
    if (!active) { clearChips(article); clearMarkBtn(article); return null; }

    var rp = isRepost(article);
    var id = tweetId(article);

    if (rp) {
      var info = reposterInfo(article);
      var r = info ? ruleOf(info.key) : null;
      c.dataset.xlrRepost = '1';
      // 登録済みで表示名が未取得なら、見かけたときに補完する
      if (info && r && rules[info.key] && !rules[info.key].n && info.name) {
        rules[info.key].n = info.name; saveRules(); renderRules();
      }
      var hide = (r === 'deny') || (cfg.repostMode === 'all' && r !== 'allow');
      if (cfg.repostMode === 'off') hide = false;
      if (hide) { c.classList.add('xlr-off'); clearChips(article); clearMarkBtn(article); return null; }
      if (cfg.showChips && cfg.repostMode !== 'off' && info && r === null) syncChips(article, info);
      else clearChips(article);
      // リポストのIDは「元投稿」のものなので時系列の基準にできない。線は引かせない
      clearMarkBtn(article);
    } else {
      clearChips(article);
      if (id) syncMarkBtn(article, id); else clearMarkBtn(article);
    }

    if (id) c.dataset.xlrId = id;
    return { cell: c, rp: rp, id: id };
  }

  var scanQueued = false, repostReadCache = {}, repostReadCacheMark = null;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(function () { scanQueued = false; scan(); });
  }

  function scan() {
    var list = articles(), n = list.length, i;
    var items = new Array(n), read = new Array(n), above = new Array(n);
    // 境目を付け替えたら、前の境目で得たリポスト判定は使わない。
    if (repostReadCacheMark !== markId) {
      repostReadCache = {};
      repostReadCacheMark = markId;
    }

    for (i = 0; i < n; i++) items[i] = prep(list[i]);

    // リポストと判定できなかった投稿でも、前後より明らかに古ければ位置が信用できない。
    // （境目より後にリポストされた古い投稿が、境目の上にあるのにグレーになるのを防ぐ）
    // 先頭の投稿も対象にする。リプライが付いた投稿は会話のまとまりとして
    // タイムラインの上へ引き上げられるので、そこを境目と見なさないようにする
    var normals = [];
    for (i = 0; i < n; i++) if (items[i] && !items[i].rp && items[i].id) normals.push(i);
    for (i = 0; i < normals.length - 1; i++) {
      var cu = items[normals[i]].id, nx = items[normals[i + 1]].id;
      if (cmpId(cu, nx) >= 0) continue;                       // 下の投稿より新しい＝並びは正常
      var pv = i > 0 ? items[normals[i - 1]].id : null;
      if (pv === null || cmpId(pv, cu) > 0) items[normals[i]].dip = true;
    }
    // 会話は古い順に並んだまとまりごと上へ引き上げられる。線を置ける場所は従来どおり
    // 会話の末尾に残す一方、「境目へ移動」の代わりの目印には会話全体を使わない。
    for (i = 0; i < normals.length - 1; i++) {
      var a = items[normals[i]], b = items[normals[i + 1]];
      if (cmpId(a.id, b.id) < 0) {
        a.cell.dataset.xlrJumpDip = '1';
        b.cell.dataset.xlrJumpDip = '1';
      }
    }

    for (i = 0; i < n; i++) {
      var f = items[i];
      read[i] = null;
      above[i] = null;
      if (!markId) { read[i] = false; continue; }
      if (!f) continue;
      if (!f.rp && f.id) {
        // 通常の投稿は自分のIDで判断する。表示位置が前後しても投稿時刻は変わらない
        read[i] = atOrOlder(f.id, markId);   // 線を引いたポスト自身も既読側に含める
        // 位置が信用できるものだけを、リポストの判断のよりどころにする。
        // 線のポスト自身は「上側＝未読側」として扱う
        if (!f.dip) above[i] = olderThan(f.id, markId);
      }
    }
    // リポストのIDは元投稿のものなので時系列の基準にできない。前後にある
    // 「位置が信用できる投稿」の両方が既読側のときだけグレーにする。
    // 片方でも未読側なら、見落としを避けるためグレーにしない
    var lo = new Array(n), up = null, dn = null;
    for (i = n - 1; i >= 0; i--) {
      lo[i] = dn;                                   // 下にある投稿の「線より古いか」
      if (above[i] !== null) dn = above[i];
    }
    for (i = 0; i < n; i++) {
      if (above[i] !== null) { up = read[i]; continue; }   // 上にある投稿の既読状態
      if (read[i] !== null) continue;                      // 通常の投稿は自分のIDで判断済み
      // 仮想スクロールの画面端では、片側の通常ポストがまだ描画されていない。
      // 片側だけで決めると、同じリポストがスクロール位置によって
      // グレーになったり戻ったりするため、上下がそろうまで未読として残す。
      if (up !== null && lo[i] !== null) {
        read[i] = up && lo[i];
        // 次の描画で片側が仮想スクロールの外へ消えても、同じリポストを
        // 反対の状態へ戻さない。IDは元投稿のIDだが、同じ投稿の識別には使える。
        if (items[i] && items[i].id) repostReadCache[items[i].id] = read[i];
      } else if (items[i] && items[i].id && Object.prototype.hasOwnProperty.call(repostReadCache, items[i].id)) {
        read[i] = repostReadCache[items[i].id];
      } else read[i] = false;
    }

    // 線を引く場所を決める。位置が信用できない場所（引き上げられた表示）には引かない
    var lineAt = -1;
    if (markId) {
      for (i = 0; i < n; i++) {
        if (items[i] && items[i].id === markId && !items[i].dip) { lineAt = i; break; }
      }
    }

    var readCount = 0, unreadCount = 0;
    for (i = 0; i < n; i++) {
      var it = items[i];
      if (!it) continue;
      it.cell.dataset.xlrRead = read[i] ? '1' : '0';
      if (read[i]) {
        readCount++;
        if (cfg.readStyle === 'hide') it.cell.classList.add('xlr-off');
        else it.cell.classList.add(fadeClass());
      } else unreadCount++;
      if (it.dip) it.cell.dataset.xlrDip = '1'; else delete it.cell.dataset.xlrDip;
      if (i === lineAt) it.cell.classList.add('xlr-line');
    }
    // 元の投稿がないときだけ「境目へ移動」と同じ代わりの位置に青い線を出す。
    // 会話として上に表示されている場合は対象外。未描画と削除は断定できない。
    if (markId && lineAt < 0 && !items.some(function (f) { return f && f.id === markId; })) {
      var fallback = jumpState();
      if (fallback && fallback.target) cellOf(fallback.target).classList.add('xlr-fallback-line');
    }
    updateStat(readCount, unreadCount);
    syncJumpBtn();
    applyBars();
  }

  /* ================= Xのバーを隠す ================= */
  var barCache = null, lastY = 0, scrollingDown = false;

  function bottomBar() {
    if (barCache && barCache.isConnected) return barCache;
    barCache = document.querySelector('[data-testid="BottomBar"]');
    if (barCache) return barCache;
    var navs = document.querySelectorAll('nav');
    for (var i = 0; i < navs.length; i++) {
      var n = navs[i], cs;
      try { cs = getComputedStyle(n); } catch (e) { continue; }
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      var r = n.getBoundingClientRect();
      if (r.width <= window.innerWidth * 0.8 || r.height <= 20 || r.height >= 130) continue;
      if (r.bottom <= window.innerHeight - 12) continue;
      // アイコンが並んでいることを条件に加える（別の固定要素を誤検出しないため）
      if (n.querySelectorAll('a,[role="link"],[role="button"]').length < 3) continue;
      barCache = n; return n;
    }
    return null;
  }

  var composeCache = null;
  function composeButton() {
    if (composeCache && composeCache.isConnected) return composeCache;
    var sel = ['[data-testid="FloatingActionButtons"]', 'a[href="/compose/post"]',
               'a[href="/compose/tweet"]', '[data-testid="SideNav_NewTweet_Button"]'];
    for (var i = 0; i < sel.length; i++) {
      var el = document.querySelector(sel[i]);
      if (el) {
        // 実際に固定配置されている親まで辿る
        var node = el, d = 0;
        while (node && d < 4) {
          var cs; try { cs = getComputedStyle(node); } catch (e) { break; }
          if (cs.position === 'fixed' || cs.position === 'absolute') { composeCache = node; return node; }
          node = node.parentElement; d++;
        }
        composeCache = el; return el;
      }
    }
    // 見つからなければ、右下あたりを座標で当たって固定表示の親を辿る
    var bar = bottomBar();
    var barH = 0;
    try { barH = bar ? bar.getBoundingClientRect().height : 0; } catch (e) {}
    var x = window.innerWidth - 40;
    var ys = [window.innerHeight - barH - 30, window.innerHeight - barH - 60];
    for (var k = 0; k < ys.length; k++) {
      if (ys[k] < 0) continue;
      var el2 = document.elementFromPoint(x, Math.round(ys[k])), d2 = 0;
      while (el2 && el2 !== document.body && d2 < 6) {
        if (el2.id === 'xlr-fab' || el2.id === 'xlr-panel') break;
        var cs2; try { cs2 = getComputedStyle(el2); } catch (e) { break; }
        if (cs2.position === 'fixed') {
          var r2 = el2.getBoundingClientRect();
          if (r2.width > 0 && r2.width < 130 && r2.height < 130) { composeCache = el2; return el2; }
        }
        el2 = el2.parentElement; d2++;
      }
    }
    return null;
  }

  function setShift(on) {
    var els = [fab, panel, composeButton()];
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      if (on) els[i].classList.add('xlr-shiftdown');
      else els[i].classList.remove('xlr-shiftdown');
    }
  }

  function applyBars() {
    var bar = bottomBar();
    if (!bar) { setShift(false); return; }

    // 高さの測定はクラスを触る前に行う（測定でレイアウトが確定するため、
    // 付け外しを挟むと透明化のアニメーションが毎回やり直しになる）
    var h = 0;
    try { h = Math.round(bar.getBoundingClientRect().height); } catch (e) {}
    if (h > 20 && h < 130) document.documentElement.style.setProperty('--xlr-shift', h + 'px');

    var wantOff = cfg.bottomBar === 'always';
    var wantFade = !wantOff && cfg.bottomBar === 'scroll' && scrollingDown;
    // 下のバーはスマホ幅のときだけ存在する。PCで下げるとボタンが画面外に出てしまう
    var mobile = window.innerWidth <= 700;
    // 変化があるときだけ書き換える。毎回付け直すと状態が安定しない
    if (bar.classList.contains('xlr-off') !== wantOff) bar.classList.toggle('xlr-off', wantOff);
    if (bar.classList.contains('xlr-hidebar') !== wantFade) bar.classList.toggle('xlr-hidebar', wantFade);
    setShift(mobile && (wantOff || wantFade));
  }

  /* ================= UI ================= */
  var fab = document.createElement('button');
  fab.id = 'xlr-fab'; fab.type = 'button'; fab.textContent = 'RP'; fab.title = 'リスト整理';

  var panel = document.createElement('div');
  panel.id = 'xlr-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<h4>リスト整理<span id="xlr-version" title="バージョン">v' + VERSION + '</span></h4>' +
    '<div class="xlr-row"><span>リポスト</span>' +
      '<select id="xlr-mode">' +
        '<option value="off">そのまま</option>' +
        '<option value="rules">振り分けに従う</option>' +
        '<option value="all">すべて隠す</option>' +
      '</select></div>' +
    '<div id="xlr-rwrap">' +
      '<label><input type="checkbox" id="xlr-chips"><span>未設定のリポストに選択ボタン</span></label>' +
      '<div class="xlr-cap xlr-sec">隠すアカウント</div><div class="xlr-list" id="xlr-deny"></div>' +
      '<div class="xlr-cap">常に表示するアカウント</div><div class="xlr-list" id="xlr-allow"></div>' +
      '<div class="xlr-add"><input type="text" id="xlr-input" placeholder="@アカウントID" autocapitalize="off" autocomplete="off" spellcheck="false">' +
        '<button id="xlr-add-deny" type="button">隠す</button>' +
        '<button id="xlr-add-allow" type="button">表示</button></div>' +
      '<button id="xlr-undo" type="button">直前の操作を元に戻す</button>' +
    '</div>' +
    '<div class="xlr-sec">' +
      '<div class="xlr-row"><span>既読の表示</span>' +
        '<select id="xlr-rs">' +
          '<option value="dim">うすく</option>' +
          '<option value="dim2">もっとうすく</option>' +
          '<option value="hide">隠す</option>' +
        '</select></div>' +
      '<div id="xlr-stat">—</div>' +
      '<button id="xlr-jump" class="xlr-primary">境目へ移動</button>' +
      '<div class="xlr-btns">' +
        '<button id="xlr-here">今の位置を境目に</button>' +
        '<button id="xlr-clear" class="sub">線を解除</button>' +
      '</div>' +
    '</div>' +
    '<div class="xlr-sec">' +
      '<div class="xlr-row"><span>下のバー</span>' +
        '<select id="xlr-bottom">' +
          '<option value="off">そのまま</option>' +
          '<option value="scroll">スクロール中は隠す</option>' +
          '<option value="always">常に隠す</option>' +
        '</select></div>' +
    '</div>' +
    '<label class="xlr-sec" id="xlr-manualwrap"><input type="checkbox" id="xlr-manual"><span>このページにも適用</span></label>' +
    '<div class="xlr-sec">' +
      '<label><input type="checkbox" id="xlr-autohome"><span>開いたら最初のリストタブへ</span></label>' +
      '<label><input type="checkbox" id="xlr-autoprofile"><span>プロフィールは「すべて」へ</span></label>' +
    '</div>' +
    '<div class="xlr-sec">' +
      '<div class="xlr-row"><span>端末間の同期</span><span class="xlr-cap" id="xlr-syncstat">—</span></div>' +
      '<div id="xlr-syncoff">' +
        '<div class="xlr-add">' +
          '<input type="text" id="xlr-synckey" placeholder="トークン / 接続情報" ' +
            'autocapitalize="off" autocomplete="off" spellcheck="false">' +
          '<button id="xlr-connect">接続</button>' +
        '</div>' +
      '</div>' +
      '<div id="xlr-syncon" style="display:none">' +
        '<div class="xlr-btns">' +
          '<button id="xlr-syncnow">今すぐ同期</button>' +
          '<button id="xlr-synccopy" class="sub">接続情報をコピー</button>' +
          '<button id="xlr-syncstop" class="sub">解除</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  function rowFor(key, v) {
    var row = document.createElement('div');
    row.className = 'xlr-b';
    var s = document.createElement('span');
    var nm = v.n || (key.charAt(0) === '#' ? key.slice(1) : '');
    var uid = v.i || (key.charAt(0) === '#' ? '' : key);
    if (nm) {
      s.appendChild(document.createTextNode(nm));
      if (uid) { var i = document.createElement('i'); i.textContent = ' @' + uid; s.appendChild(i); }
    } else { s.textContent = '@' + uid; }
    s.title = nm + (uid ? ' @' + uid : '');
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = '×'; b.title = '解除'; b.dataset.xlrClear = key;
    row.appendChild(s); row.appendChild(b);
    return row;
  }

  function renderRules() {
    var dw = panel.querySelector('#xlr-deny'), aw = panel.querySelector('#xlr-allow');
    if (!dw || !aw) return;
    dw.innerHTML = ''; aw.innerHTML = '';
    var nd = 0, na = 0;
    Object.keys(rules).forEach(function (k) {
      var v = rules[k];
      if (v.r === 'deny') { dw.appendChild(rowFor(k, v)); nd++; }
      else if (v.r === 'allow') { aw.appendChild(rowFor(k, v)); na++; }
    });
    if (!nd) dw.innerHTML = '<div class="xlr-cap">なし</div>';
    if (!na) aw.innerHTML = '<div class="xlr-cap">なし</div>';
    panel.querySelector('#xlr-undo').style.display = undoState ? 'block' : 'none';
  }

  function renderSync() {
    var stat = panel.querySelector('#xlr-syncstat');
    if (!stat) return;
    var on = connected();
    panel.querySelector('#xlr-syncon').style.display = on ? '' : 'none';
    panel.querySelector('#xlr-syncoff').style.display = on ? 'none' : '';
    if (syncMsg) stat.textContent = syncMsg;
    else if (!on) stat.textContent = '未設定';
    else if (sync.last) {
      var d = new Date(sync.last);
      stat.textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' に同期';
    } else stat.textContent = '接続済み';
  }

  function syncPanel() {
    panel.querySelector('#xlr-mode').value = cfg.repostMode;
    panel.querySelector('#xlr-rs').value = cfg.readStyle;
    panel.querySelector('#xlr-chips').checked = cfg.showChips;
    panel.querySelector('#xlr-bottom').value = cfg.bottomBar;
    panel.querySelector('#xlr-autohome').checked = cfg.autoHomeTab;
    panel.querySelector('#xlr-autoprofile').checked = cfg.autoProfileAll;
    panel.querySelector('#xlr-rwrap').style.display = cfg.repostMode === 'off' ? 'none' : '';
    panel.querySelector('#xlr-manualwrap').style.display = isList ? 'none' : '';
    panel.querySelector('#xlr-manual').checked = !isList && active;
    fab.classList.toggle('xlr-idle', !active);
    syncJumpBtn();
    renderSync();
    renderRules();
  }

  function updateStat(readCount, unreadCount) {
    var el = panel.querySelector('#xlr-stat');
    if (!el) return;
    if (!active) { el.textContent = 'このページでは無効です'; syncJumpBtn(); return; }
    if (!markId) { el.textContent = '境目は未設定です'; syncJumpBtn(); return; }
    el.textContent = '未読 ' + (unreadCount || 0) + '件 / 既読 ' + (readCount || 0) + '件（表示中）';
  }

  function syncJumpBtn() {
    var b = panel.querySelector('#xlr-jump');
    if (b) b.disabled = !markId || !active;
  }

  // パネルの外を触ったら「閉じるだけ」にする。
  // リンクの上を触った場合でも、1回目のタップでは移動させない
  document.addEventListener('click', function (e) {
    if (panel.hidden) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#xlr-panel') || t.closest('#xlr-fab') ||
        t.closest('.xlr-chip') || t.closest('.xlr-mark')) return;
    panel.hidden = true; cfg.open = false; saveCfg();
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }, true);

  fab.addEventListener('click', function () {
    cfg.open = panel.hidden;
    panel.hidden = !panel.hidden;
    saveCfg();
    if (!panel.hidden) { syncPanel(); scan(); }
  });

  function addManual(r) {
    var inp = panel.querySelector('#xlr-input');
    var v = (inp.value || '').trim().replace(/^@/, '');
    if (!v) return;
    var key = /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : '#' + v;
    setRule(key, { name: key.charAt(0) === '#' ? v : '', id: key.charAt(0) === '#' ? '' : v }, r);
    inp.value = '';
  }

  panel.addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.xlrClear) {
      var k = t.dataset.xlrClear;
      undoState = { key: k, prev: Object.assign({}, rules[k]) };
      rules[k] = { n: '', i: '', r: null, t: Date.now() };
      saveRules(); renderRules(); scheduleScan(); schedulePush(); return;
    }
    if (t.id === 'xlr-undo') return undo();
    if (t.id === 'xlr-connect') {
      var inp = panel.querySelector('#xlr-synckey');
      var val = inp.value; inp.value = '';
      connectSync(val);
      return;
    }
    if (t.id === 'xlr-syncnow') { setSyncMsg(''); syncNow(); return; }
    if (t.id === 'xlr-synccopy') {
      var txt = 'xlrsync:' + sync.token + ':' + sync.gist;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt);
          t.textContent = 'コピーしました';
          setTimeout(function () { t.textContent = '接続情報をコピー'; }, 1500);
        } else window.prompt('もう一方の端末に貼り付けてください', txt);
      } catch (e) { window.prompt('もう一方の端末に貼り付けてください', txt); }
      return;
    }
    if (t.id === 'xlr-syncstop') {
      if (!window.confirm('この端末の同期設定を消します。よろしいですか？')) return;
      sync = { token: '', gist: '', last: 0 }; saveSync(); setSyncMsg(''); renderSync();
      return;
    }
    if (t.id === 'xlr-add-deny') return addManual('deny');
    if (t.id === 'xlr-add-allow') return addManual('allow');
    if (t.id === 'xlr-here') {
      var l = articles(), best = null;
      for (var i = 0; i < l.length; i++) {
        var c = cellOf(l[i]);
        if (!c || c.classList.contains('xlr-off') || !c.dataset.xlrId) continue;
        if (c.dataset.xlrRepost === '1') continue;   // リポストは基準にできない
        if (l[i].getBoundingClientRect().bottom < 60) continue;
        best = c.dataset.xlrId; break;
      }
      if (best) { markId = best; saveMark(); scheduleScan(); }
      return;
    }
    if (t.id === 'xlr-jump') { jumpToLine(); return; }
    if (t.id === 'xlr-clear') { markId = null; saveMark(); scheduleScan(); }
  });

  panel.addEventListener('change', function (e) {
    var t = e.target, touched = true;
    if (t.id === 'xlr-mode') cfg.repostMode = t.value;
    else if (t.id === 'xlr-rs') cfg.readStyle = t.value;
    else if (t.id === 'xlr-chips') cfg.showChips = t.checked;
    else if (t.id === 'xlr-bottom') { cfg.bottomBar = t.value; scrollingDown = false; }
    else if (t.id === 'xlr-autohome') { cfg.autoHomeTab = t.checked; autoTabKey = ''; }
    else if (t.id === 'xlr-autoprofile') { cfg.autoProfileAll = t.checked; autoTabKey = ''; }
    else if (t.id === 'xlr-manual') {
      var p = location.pathname, i = cfg.manualPages.indexOf(p);
      if (t.checked && i === -1) cfg.manualPages.push(p);
      if (!t.checked && i !== -1) cfg.manualPages.splice(i, 1);
      lastPath = null;
    } else touched = false;   // 入力欄など、設定以外の変更では何もしない
    if (!touched) return;
    cfg.t = Date.now();
    saveCfg(); schedulePush(); checkRoute(); syncPanel(); applyBars(); scheduleScan();
  });

  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'xlr-input') { e.preventDefault(); addManual('deny'); }
  });

  /* ================= 境目へ移動 ================= */
  // Xは画面の周辺しか描画しないため、境目が描画範囲の外にあることがある。
  // 少しずつスクロールし、追加読み込みを待ちながら境目線を探す
  var jumping = false, jumpTimer = null;

  function jumpState() {
    var list = articles(), rows = [], i;
    for (i = 0; i < list.length; i++) {
      var c = cellOf(list[i]);
      if (!c || c.dataset.xlrRead === undefined) continue;
      if (c.classList.contains('xlr-off')) continue;   // 非表示のものは位置が取れない
      rows.push({ el: list[i], cell: c, read: c.dataset.xlrRead === '1' });
    }
    if (!rows.length) return null;
    var marked = null, boundary = null, anyRead = false, anyUnread = false;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i], c = row.cell;
      if (c.classList.contains('xlr-line')) marked = row.el;
      // グレー表示は投稿時刻の判定。位置の目印にはリポストや引き上げ会話を使わない。
      if (c.dataset.xlrRepost === '1' || c.dataset.xlrDip === '1' ||
          c.dataset.xlrJumpDip === '1' || !c.dataset.xlrId) continue;
      if (row.read) {
        anyRead = true;
        if (anyUnread && !boundary) boundary = row.el;
      } else {
        anyUnread = true;
        // 後ろに未読があれば、途中の古い投稿は境目ではない。
        boundary = null;
      }
    }
    // 線の投稿が削除された場合は、最後の未読より下の、位置が信用できる既読を使う。
    return {
      target: marked || boundary,
      allRead: anyRead && !anyUnread,
      progress: rows.map(function (r) { return r.cell.dataset.xlrId || ''; }).join(',')
    };
  }

  function endJump() {
    jumping = false;
    clearTimeout(jumpTimer);
    var b = panel.querySelector('#xlr-jump');
    if (b) b.textContent = '境目へ移動';
  }

  function jumpToLine() {
    if (!markId) return;
    if (jumping) { endJump(); return; }   // もう一度押したら中止
    jumping = true;
    var btn = panel.querySelector('#xlr-jump');
    if (btn) btn.textContent = '探しています…';
    var started = Date.now(), changedAt = started, previous = '';
    var startScope = scopeKey, startMark = markId;

    function step() {
      if (!jumping) return;
      if (scopeKey !== startScope || markId !== startMark || !active) { endJump(); return; }
      scan();
      var st = jumpState();
      if (st && st.target) {
        st.target.scrollIntoView({ block: 'center' });
        endJump();
        return;
      }
      var now = Date.now();
      var height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      var progress = window.scrollY + ':' + height + ':' + (st ? st.progress : '');
      if (progress !== previous) { previous = progress; changedAt = now; }
      // 読み込みが進む間は継続する。通信停止などで12秒変化がなければ終了する。
      // 終わりのない探索を避けるため、全体にも2分の上限を設ける。
      if (now - changedAt >= 12000 || now - started >= 120000) {
        endJump();
        return;
      }
      var atBottom = window.innerHeight + window.scrollY >= height - 40;
      var atTop = window.scrollY <= 0;
      var dir = st && st.allRead ? -1 : 1;
      if (dir < 0 && atTop) { endJump(); return; }
      var waiting = dir > 0 && atBottom;
      if (btn) btn.textContent = waiting ? '読み込み待ち…（押すと中止）' : '探しています…（押すと中止）';
      window.scrollBy(0, dir * Math.round(window.innerHeight * 0.75));
      jumpTimer = setTimeout(step, waiting ? 250 : 90);
    }
    step();
  }

  // 利用者が自分でスクロールしたら探索を止める
  window.addEventListener('touchstart', function (e) {
    // 中止ボタンではclick側で止める。touchstartで止めると直後のclickで再開してしまう。
    if (jumping && !(e.target.closest && e.target.closest('#xlr-jump'))) endJump();
  }, { passive: true });
  window.addEventListener('wheel', function () { if (jumping) endJump(); }, { passive: true });

  /* ================= タブの自動選択 ================= */
  var autoTabKey = '', autoTabTries = 0, autoTabTimer = null;

  // こちらが自動で押したぶんは履歴に積まない。
  // 積むと「戻る」を何度も押さないと前のページへ帰れなくなる
  var suppressPush = 0;
  (function patchHistory() {
    try {
      var origPush = history.pushState;
      if (typeof origPush !== 'function') return;
      history.pushState = function () {
        if (suppressPush > 0) {
          try { return history.replaceState.apply(history, arguments); } catch (e) {}
        }
        return origPush.apply(history, arguments);
      };
    } catch (e) {}
  })();

  // 上の細工が効かず、Xが履歴を積んでしまうこともある。そのときのために、
  // 自動操作の直前の地点に目印を残しておき、「戻る」でそこに着いたら通り道として
  // もう一度戻る。こうすれば結局1回の「戻る」で前のページへ帰れる
  var TAB_ID = '';
  try {
    TAB_ID = sessionStorage.getItem('xlr:tab') || '';
    if (!TAB_ID) {
      TAB_ID = String(Date.now()) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('xlr:tab', TAB_ID);
    }
  } catch (e) { TAB_ID = String(Date.now()); }

  function stateObj() {
    var s = null;
    try { s = history.state; } catch (e) {}
    return (s && typeof s === 'object' && !Array.isArray(s)) ? s : null;
  }
  function markHere() {
    var at = Date.now();
    try {
      var o = {}, s = stateObj(), k;
      if (s) for (k in s) if (Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
      o.__xlrPre = TAB_ID;
      o.__xlrAt = at;
      history.replaceState(o, '');
    } catch (e) {}
    return at;
  }
  function unmarkHere() {
    try {
      var s = stateObj();
      if (!s || s.__xlrPre === undefined) return;
      var o = {}, k;
      for (k in s) if (Object.prototype.hasOwnProperty.call(s, k) && k !== '__xlrPre' && k !== '__xlrAt') o[k] = s[k];
      history.replaceState(o, '');
    } catch (e) {}
  }

  var suppressTimer = null;
  function autoClick(el) {
    if (!el) return;
    var at = markHere(), len = 0;
    try { len = history.length; } catch (e) {}
    suppressPush++;
    try { el.click(); } catch (e) {}
    clearTimeout(suppressTimer);
    // Xは押した直後ではなく、読み込みが済んでから履歴を積むことがあるので長めに構える
    suppressTimer = setTimeout(function () { suppressPush = 0; }, 4000);
    // 履歴が増えなかったのなら、ここは通り道ではない。目印を残すと
    // あとで「戻る」を余計に進めてしまうので取り消す
    setTimeout(function () {
      var s = stateObj();
      if (!s || s.__xlrPre !== TAB_ID || s.__xlrAt !== at) return;
      var now = 0;
      try { now = history.length; } catch (e) {}
      if (now <= len) unmarkHere();
    }, 6000);
  }

  // 利用者自身の操作はこれまでどおり履歴に積む（自動クリックは isTrusted が false）
  function releaseSuppress(e) {
    if (!e || !e.isTrusted || suppressPush <= 0) return;
    suppressPush = 0;
    clearTimeout(suppressTimer);
  }
  ['pointerdown', 'mousedown', 'touchstart', 'keydown'].forEach(function (t) {
    document.addEventListener(t, releaseSuppress, true);
  });

  // 「戻る」で入り直したときに自動選択をやり直すと、選択シートに戻って
  // また先へ進む、という堂々巡りになる。一度やった相手は二度やらない
  var autoDone = {}, backAt = 0, skipCount = 0;
  function cancelAutoTab() { clearTimeout(autoTabTimer); autoTabKey = '#cancelled'; }
  window.addEventListener('popstate', function () {
    backAt = Date.now();
    cancelAutoTab();
    var s = stateObj();
    // 自動操作の通り道（目印つき）に着いたら、そこには留まらず続けて戻る
    var mine = s && s.__xlrPre === TAB_ID && (Date.now() - (s.__xlrAt || 0) < 1800000);
    if (!mine) { skipCount = 0; return; }
    if (skipCount >= 3) return;      // 万一に備えた歯止め
    skipCount++;
    unmarkHere();                    // 二度と通り道扱いしないように目印を消す
    try { history.back(); } catch (e) {}
  }, true);

  function normText(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function tabEls() { return document.querySelectorAll('[role="tablist"] [role="tab"]'); }

  // 「フォロー中」のすぐ右のタブ（＝最初のリスト）を選ぶ
  function pickFirstListTab() {
    var ts = tabEls();
    if (ts.length < 3) return false;
    for (var i = 0; i < ts.length; i++) {
      if (!/^(フォロー中|Following)$/.test(normText(ts[i].textContent))) continue;
      var next = ts[i + 1];
      if (!next) return false;
      if (next.getAttribute('aria-selected') !== 'true') autoClick(next);
      return true;
    }
    return false;
  }

  // 実際に画面に出ているかどうかを見る。
  // 非表示のままDOMに残っている選択肢を押すと、勝手に画面が切り替わってしまう
  function visible(el) {
    if (!el) return false;
    if (!el.offsetParent && el !== document.body) {
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { return false; }
      if (cs.position !== 'fixed') return false;
    }
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width < 2 || r.height < 2) return false;
    try {
      var s2 = getComputedStyle(el);
      if (s2.visibility === 'hidden' || s2.display === 'none' || parseFloat(s2.opacity) < 0.05) return false;
    } catch (e) {}
    return true;
  }

  // 「開いている」メニューの中から、文言が一致する項目を探す
  function findMenuItem(re) {
    // まずは役割つきの入れ物（メニュー/一覧/ダイアログ/シート）の中を探す
    var menus = document.querySelectorAll(
      '[role="menu"],[role="listbox"],[role="dialog"],[data-testid="Dropdown"],[data-testid="sheetDialog"],#layers'
    );
    var m, i;
    for (m = 0; m < menus.length; m++) {
      if (!visible(menus[m])) continue;
      var items = menus[m].querySelectorAll('[role="menuitem"],[role="option"],[role="radio"],[role="tab"],a,button,[tabindex]');
      for (i = 0; i < items.length; i++) {
        if (re.test(normText(items[i].textContent)) && visible(items[i])) return items[i];
      }
    }
    // 見つからなければ、実機のメニューが想定と違うマークアップの可能性があるため、
    // 画面全体から文言が完全一致する（かつ子要素の少ない＝ラベルらしい）要素を探す保険を掛ける
    var leaves = document.querySelectorAll('div,span,a,button,p');
    for (i = 0; i < leaves.length; i++) {
      var el = leaves[i];
      if (el.children.length > 2) continue;
      if (!re.test(normText(el.textContent))) continue;
      if (!visible(el)) continue;
      return el.closest('[role],a,button,[tabindex]') || el;
    }
    return null;
  }

  // プロフィールの「ポスト」タブは押すと選択肢が開くので、そこから「すべて」を選ぶ
  var ALL_RE = /^(すべて|All)$/;
  var POST_RE = /^(ポスト|投稿|Posts)$/;
  var menuTries = 0;

  function pickProfileAllTab() {
    var ts = tabEls(), i;
    // すでに「すべて」になっていれば何もしない
    for (i = 0; i < ts.length; i++) {
      if (ALL_RE.test(normText(ts[i].textContent))) {
        if (ts[i].getAttribute('aria-selected') === 'true') return true;
        if (!visible(ts[i])) continue;
        autoClick(ts[i]);
        return true;
      }
    }
    // 選択肢が開いていれば「すべて」を選ぶ
    var item = findMenuItem(ALL_RE);
    if (item) { autoClick(item); return true; }
    // まだなら「ポスト」タブを押して選択肢を開く（開く操作は1回だけ）
    if (menuTries === 0) {
      for (i = 0; i < ts.length; i++) {
        if (!POST_RE.test(normText(ts[i].textContent)) || !visible(ts[i])) continue;
        menuTries = 1;
        autoClick(ts[i]);
        return false;
      }
      return false;
    }
    // 開いたのに見つからなければ、閉じて諦める（実機は描画が遅いこともあるので少し長めに待つ）
    if (++menuTries > 15) {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch (e) {}
      return true;
    }
    return false;
  }

  function scheduleAutoTab() {
    var p = location.pathname;
    var isHome = /^\/(home)?\/?$/.test(p);
    var m = p.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    var isProfile = !!(m && RESERVED.indexOf(m[1]) === -1);
    var want = (isHome && cfg.autoHomeTab) ? 'home' : (isProfile && cfg.autoProfileAll) ? 'profile' : '';
    if (!want) return;
    if (Date.now() - backAt < 3000) return;        // 「戻る」直後は動かさない
    var who = want === 'profile' ? m[1] : '';
    if (who && autoDone[who]) return;              // 一度処理したプロフィールはやり直さない
    var key = want + ':' + p;
    if (autoTabKey === key) return;                // 同じページで繰り返さない
    autoTabKey = key;
    autoTabTries = 0;
    menuTries = 0;
    clearTimeout(autoTabTimer);
    (function tryOnce() {
      if (autoTabKey !== key) return;
      if (want === 'home' ? pickFirstListTab() : pickProfileAllTab()) {
        if (who) autoDone[who] = true;
        return;
      }
      if (++autoTabTries > 25) { if (who) autoDone[who] = true; return; }   // 10秒ほどで諦める
      autoTabTimer = setTimeout(tryOnce, 400);
    })();
  }

  /* ================= ルーティング ================= */
  var lastPath = null, tabCache = '', tabAt = 0;

  // ホームのタブ（ピン留めしたリスト）はURLが変わらないので、選択中のタブ名で区別する
  function activeTab() {
    var now = Date.now();
    if (now - tabAt < 250) return tabCache;
    tabAt = now;
    var t = document.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]');
    var name = t ? (t.textContent || '').replace(/\s+/g, ' ').trim() : '';
    tabCache = name ? '@' + name : '';
    return tabCache;
  }

  function scopeOf() {
    var p = location.pathname;
    var m = p.match(/^\/i\/lists\/(\d+)/);
    if (m) return { key: m[1], list: true, path: p };
    return { key: 'path:' + p + activeTab(), list: false, path: p };
  }

  function checkRoute() {
    var sc = scopeOf();
    scheduleAutoTab();
    if (sc.path === lastPath && sc.key === scopeKey) return;
    if (sc.path !== lastPath) autoTabKey = '';   // ページを移ったらやり直す
    lastPath = sc.path;
    isList = sc.list;
    active = isList || cfg.manualPages.indexOf(sc.path) !== -1;
    if (sc.key !== scopeKey) { scopeKey = sc.key; loadMark(scopeKey); }
    syncPanel(); scheduleScan();
  }

  /* ================= 起動 ================= */
  function boot() {
    var st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
    document.body.appendChild(fab);
    document.body.appendChild(panel);
    panel.hidden = !cfg.open;

    new MutationObserver(function () {
      if (!fab.isConnected) document.body.appendChild(fab);
      if (!panel.isConnected) document.body.appendChild(panel);
      checkRoute(); scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true });

    var ticking = false;
    lastY = window.scrollY || 0;
    window.addEventListener('scroll', function () {
      var y = window.scrollY || 0;
      if (Math.abs(y - lastY) > 4) { scrollingDown = y > lastY && y > 60; lastY = y; }
      if (y <= 60) scrollingDown = false;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; applyBars(); scheduleScan(); });
    }, { passive: true });

    setInterval(function () { checkRoute(); applyBars(); scheduleScan(); }, 1500);

    // 起動時と、一定間隔・画面復帰時に取りに行く
    if (connected()) setTimeout(function () { syncNow(); }, 1200);
    setInterval(function () {
      if (connected() && !document.hidden) syncNow();
    }, 90000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && connected() && Date.now() - (sync.last || 0) > 20000) syncNow();
    });
    tidyNames();
    checkRoute(); syncPanel(); scan(); applyBars();
  }

  if (document.body) boot();
  else new MutationObserver(function (r, o) {
    if (document.body) { o.disconnect(); boot(); }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
