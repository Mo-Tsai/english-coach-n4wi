/* store.js：英文口說 Live 教練的本機進度存取層
 * 介面照 Artifact 版的 claude.use('db')：db.doc('集合/文件id').set(資料) / .delete() / .get()，
 * db.collection('集合').onSnapshot(成功, 失敗)（回傳取消訂閱函式；snap.docs[i].id / .data()）。
 * 存放：IndexedDB（優先）→ localStorage（IndexedDB 不能用時）→ 都不行就回傳 null（頁面只能瀏覽）。
 * 集合與欄位與 Artifact 版完全一致：progress_days、chunk_status、word_status、chunk_reps、quiz_results。
 * 取消標記＝刪文件；每個文件自己帶 updatedAt。
 * 這個檔案不碰任何網路、不碰任何金鑰。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ElcStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLLECTIONS = ['progress_days', 'chunk_status', 'word_status', 'chunk_reps', 'quiz_results'];
  var DB_NAME = 'english-live-coach', STORE = 'docs', LS_PREFIX = 'elc:';
  var APP_ID = 'english-live-coach';

  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function isCol(c) { return COLLECTIONS.indexOf(c) >= 0; }
  function parsePath(p) {
    var i = String(p).indexOf('/');
    if (i < 1 || i === String(p).length - 1) throw new Error('bad path');
    var c = p.slice(0, i), id = p.slice(i + 1);
    if (!isCol(c)) throw new Error('bad collection');
    return [c, id];
  }
  function wrapErr(e) {
    var err = new Error(e && e.message ? e.message : 'write failed');
    var n = e && e.name ? e.name : '';
    err.code = (n === 'QuotaExceededError' || (e && e.code === 22)) ? 'quota_exceeded' : 'write_failed';
    return err;
  }
  function tsOf(d) { var t = d && d.updatedAt ? Date.parse(d.updatedAt) : 0; return isNaN(t) ? 0 : t; }

  /* ---------- backends: { kind, getAll(), put(col,id,data), del(col,id) } ---------- */
  function idbBackend(factory, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var to = setTimeout(function () { if (!done) { done = true; reject(new Error('idb timeout')); } }, timeoutMs || 4000);
      var req;
      try { req = factory.open(DB_NAME, 1); } catch (e) { clearTimeout(to); return reject(e); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = function () {
        if (done) { try { req.result.close(); } catch (e) {} return; }
        done = true; clearTimeout(to);
        var d = req.result;
        function tx(mode, fn) {
          return new Promise(function (res, rej) {
            var t, out;
            try { t = d.transaction(STORE, mode); } catch (e) { return rej(e); }
            t.oncomplete = function () { res(out); };
            t.onerror = function () { rej(t.error || new Error('tx error')); };
            t.onabort = function () { rej(t.error || new Error('tx abort')); };
            try { fn(t.objectStore(STORE), function (v) { out = v; }); } catch (e) { rej(e); }
          });
        }
        resolve({
          kind: 'indexeddb',
          getAll: function () {
            return tx('readonly', function (os, set) {
              var r = os.getAll();
              r.onsuccess = function () { set(r.result || []); };
            });
          },
          put: function (col, id, data) { return tx('readwrite', function (os) { os.put({ key: col + '/' + id, col: col, id: id, data: data }); }); },
          del: function (col, id) { return tx('readwrite', function (os) { os.delete(col + '/' + id); }); }
        });
      };
      req.onerror = function () { if (!done) { done = true; clearTimeout(to); reject(req.error || new Error('idb open error')); } };
      req.onblocked = function () { if (!done) { done = true; clearTimeout(to); reject(new Error('idb blocked')); } };
    });
  }

  function lsBackend(ls) {
    // 先試寫一次，確認真的能用（有些無痕模式讀得到、寫不進去）
    ls.setItem(LS_PREFIX + '__probe', '1'); ls.removeItem(LS_PREFIX + '__probe');
    function keys() {
      var out = [];
      for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k && k.indexOf(LS_PREFIX) === 0 && k !== LS_PREFIX + '__probe') out.push(k); }
      return out;
    }
    return {
      kind: 'localstorage',
      getAll: function () {
        var out = [];
        keys().forEach(function (k) {
          var rest = k.slice(LS_PREFIX.length), i = rest.indexOf('/');
          if (i < 1) return;
          try { out.push({ col: rest.slice(0, i), id: rest.slice(i + 1), data: JSON.parse(ls.getItem(k)) }); } catch (e) {}
        });
        return Promise.resolve(out);
      },
      put: function (col, id, data) {
        try { ls.setItem(LS_PREFIX + col + '/' + id, JSON.stringify(data)); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
      },
      del: function (col, id) {
        try { ls.removeItem(LS_PREFIX + col + '/' + id); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
      },
      _keys: keys
    };
  }

  // IndexedDB 恢復可用時，把先前暫存在 localStorage 的文件併進去（較新的覆蓋；成功寫入才刪暫存）
  function migrateLs(idb, ls) {
    if (!ls) return Promise.resolve();
    var lsb; try { lsb = lsBackend(ls); } catch (e) { return Promise.resolve(); }
    return Promise.all([lsb.getAll(), idb.getAll()]).then(function (r) {
      var have = {};
      r[1].forEach(function (x) { have[x.col + '/' + x.id] = x.data; });
      return r[0].reduce(function (p, x) {
        return p.then(function () {
          if (!isCol(x.col) || !x.data) return;
          var cur = have[x.col + '/' + x.id];
          var write = (!cur || tsOf(x.data) > tsOf(cur)) ? idb.put(x.col, x.id, x.data) : Promise.resolve();
          return write.then(function () { return lsb.del(x.col, x.id); });
        });
      }, Promise.resolve());
    }).catch(function () {});
  }

  /* ---------- the db object ---------- */
  function makeDb(backend, rows) {
    var cache = {}, listeners = {}, pending = {};
    COLLECTIONS.forEach(function (c) { cache[c] = {}; listeners[c] = []; });
    rows.forEach(function (r) { if (cache[r.col] && r.data && typeof r.data === 'object') cache[r.col][r.id] = r.data; });

    function snapshot(col) {
      var m = cache[col];
      return {
        docs: Object.keys(m).sort().map(function (id) {
          var d = m[id];
          return { id: id, exists: true, data: function () { return clone(d); } };
        })
      };
    }
    function emit(col) {
      if (pending[col]) return;
      pending[col] = true;
      setTimeout(function () {
        pending[col] = false;
        listeners[col].slice().forEach(function (l) { try { l.ok(snapshot(col)); } catch (e) {} });
      }, 0);
    }
    function docRef(path) {
      var pr = parsePath(path), c = pr[0], id = pr[1];
      return {
        set: function (data) {
          var prev = cache[c][id], next = clone(data);
          cache[c][id] = next; emit(c);            // 先更新畫面用的資料，再寫入本機；寫失敗會退回
          return backend.put(c, id, next).then(function () {}, function (e) {
            if (cache[c][id] === next) { if (prev === undefined) delete cache[c][id]; else cache[c][id] = prev; emit(c); }
            throw wrapErr(e);
          });
        },
        delete: function () {
          var prev = cache[c][id];
          if (prev === undefined) return Promise.resolve();
          delete cache[c][id]; emit(c);
          return backend.del(c, id).then(function () {}, function (e) {
            if (cache[c][id] === undefined) { cache[c][id] = prev; emit(c); }
            throw wrapErr(e);
          });
        },
        get: function () {
          var d = cache[c][id];
          return Promise.resolve({ exists: d !== undefined, id: id, data: function () { return clone(d); } });
        }
      };
    }
    return {
      kind: backend.kind,
      doc: docRef,
      collection: function (col) {
        if (!isCol(col)) throw new Error('bad collection');
        return {
          onSnapshot: function (ok, err) {
            var l = { ok: ok, err: err };
            listeners[col].push(l);
            setTimeout(function () { if (listeners[col].indexOf(l) >= 0) { try { ok(snapshot(col)); } catch (e) {} } }, 0);
            return function () { var i = listeners[col].indexOf(l); if (i >= 0) listeners[col].splice(i, 1); };
          }
        };
      },
      // 以下是 PWA 版才有（匯出匯入用）
      all: function () {
        var out = {};
        COLLECTIONS.forEach(function (c) { out[c] = clone(cache[c]); });
        return out;
      },
      counts: function () {
        var out = {}, total = 0;
        COLLECTIONS.forEach(function (c) { out[c] = Object.keys(cache[c]).length; total += out[c]; });
        out.total = total; return out;
      },
      applyMerge: function (plan) {
        var items = plan.add.concat(plan.update), failed = 0;
        return Promise.all(items.map(function (x) {
          return docRef(x.col + '/' + x.id).set(x.data).catch(function () { failed++; });
        })).then(function () { return { written: items.length - failed, failed: failed }; });
      }
    };
  }

  function open(env) {
    env = env || {};
    var idbF = ('indexedDB' in env) ? env.indexedDB : (typeof indexedDB !== 'undefined' ? indexedDB : null);
    var ls = null;
    try { ls = ('localStorage' in env) ? env.localStorage : (typeof localStorage !== 'undefined' ? localStorage : null); } catch (e) { ls = null; }
    var first = idbF ? idbBackend(idbF, env.idbTimeout) : Promise.reject(new Error('no indexedDB'));
    return first.then(function (b) {
      return migrateLs(b, ls).then(function () { return b; });
    }, function () {
      if (!ls) return null;
      try { return lsBackend(ls); } catch (e) { return null; }
    }).then(function (b) {
      if (!b) return null;
      return b.getAll().then(function (rows) { return makeDb(b, rows); });
    });
  }

  /* ---------- 匯出／匯入（純函式，好測） ---------- */
  function buildExport(all, appVersion, exportedAt) {
    var counts = { total: 0 };
    COLLECTIONS.forEach(function (c) { counts[c] = Object.keys(all[c] || {}).length; counts.total += counts[c]; });
    var cols = {};
    COLLECTIONS.forEach(function (c) { cols[c] = all[c] || {}; });
    return { app: APP_ID, schema: 1, appVersion: appVersion, exportedAt: exportedAt, counts: counts, collections: cols };
  }

  function parseImport(text) {
    var s = String(text || '').trim();
    if (!s) return { ok: false, msg: '還沒有貼上內容。請把匯出的進度文字整段貼進來。' };
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return { ok: false, msg: '看不出這是進度文字。請確認貼的是「匯出進度」複製出來的整段。' };
    var obj;
    try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { ok: false, msg: '這段文字不完整，讀不出來。請重新匯出一次，整段複製再貼上。' }; }
    if (!obj || typeof obj !== 'object' || !obj.collections || typeof obj.collections !== 'object') return { ok: false, msg: '這不是這個 App 匯出的進度（找不到進度內容）。' };
    if (obj.app && obj.app !== APP_ID) return { ok: false, msg: '這不是「英文口說 Live 教練」匯出的進度。' };
    var docs = {}, invalid = 0, unknown = [];
    Object.keys(obj.collections).forEach(function (c) {
      if (!isCol(c)) { unknown.push(c); return; }
      var m = obj.collections[c]; docs[c] = {};
      if (!m || typeof m !== 'object' || Array.isArray(m)) { invalid++; return; }
      Object.keys(m).forEach(function (id) {
        var d = m[id];
        if (!id || id.indexOf('/') >= 0 || !d || typeof d !== 'object' || Array.isArray(d)) { invalid++; return; }
        docs[c][id] = d;
      });
    });
    return { ok: true, docs: docs, invalid: invalid, unknown: unknown, exportedAt: obj.exportedAt || '', appVersion: obj.appVersion || '' };
  }

  // 預設合併：本機沒有→新增；匯入的 updatedAt 比較新→更新；其餘（相同或本機較新）→略過
  function planMerge(all, parsed) {
    var plan = { add: [], update: [], skip: 0, invalid: parsed.invalid || 0, unknown: parsed.unknown || [], perCol: {} };
    COLLECTIONS.forEach(function (c) {
      var pc = plan.perCol[c] = { add: 0, update: 0, skip: 0 };
      var inc = parsed.docs[c] || {}, loc = all[c] || {};
      Object.keys(inc).forEach(function (id) {
        var l = loc[id];
        if (!l) { plan.add.push({ col: c, id: id, data: inc[id] }); pc.add++; }
        else if (tsOf(inc[id]) > tsOf(l)) { plan.update.push({ col: c, id: id, data: inc[id] }); pc.update++; }
        else { plan.skip++; pc.skip++; }
      });
    });
    return plan;
  }

  return {
    COLLECTIONS: COLLECTIONS, APP_ID: APP_ID,
    open: open, buildExport: buildExport, parseImport: parseImport, planMerge: planMerge,
    _internals: { idbBackend: idbBackend, lsBackend: lsBackend, tsOf: tsOf }
  };
});
