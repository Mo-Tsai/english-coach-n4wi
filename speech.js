/* speech.js：選填的 Azure 語音（照 Mo's Feed 的做法：region＋token、SSML、失敗退回）
 * 重點規矩：
 *  - key 與 region 只存這支手機的 localStorage（elc-az-*），不進程式碼、不進匯出進度、不 console.log。
 *  - 沒填 key 就完全不連 Azure。填了才會在「按播放」時，把文字和 key 直接傳給 Microsoft。
 *  - 錯誤訊息一律用通用文字，不帶 key、不帶回應內容。
 *  - 最近播過的音訊（最多 40 句）放在記憶體，連點同一句不會重複呼叫（不重複扣額度）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ElcSpeech = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VOICES = [
    { id: 'en-US-AriaNeural', label: 'Aria 美式女聲（預設，和預錄檔同一個嗓音）' },
    { id: 'en-US-JennyNeural', label: 'Jenny 美式女聲' },
    { id: 'en-US-GuyNeural', label: 'Guy 美式男聲' },
    { id: 'en-GB-SoniaNeural', label: 'Sonia 英式女聲' },
    { id: 'en-GB-RyanNeural', label: 'Ryan 英式男聲' },
    { id: 'en-AU-NatashaNeural', label: 'Natasha 澳洲女聲' }
  ];
  var RATES = [
    { v: '-20%', label: '很慢（-20%）' }, { v: '-10%', label: '慢（-10%）' }, { v: '-5%', label: '稍慢（-5%，預設，和預錄檔一樣）' },
    { v: '0%', label: '正常（0%）' }, { v: '+5%', label: '稍快（+5%）' }, { v: '+10%', label: '快（+10%）' }
  ];
  var DEFAULTS = { region: 'eastus', voice: 'en-US-AriaNeural', rate: '-5%' };
  var K = { key: 'elc-az-key', region: 'elc-az-region', voice: 'elc-az-voice', rate: 'elc-az-rate' };
  var CACHE_MAX = 40, TOKEN_MS = 9 * 60 * 1000, TIMEOUT_MS = 9000;

  function create(env) {
    env = env || {};
    var store = env.storage;               // { getItem, setItem, removeItem }；可以是 null
    var fetchFn = env.fetch;
    var urlApi = env.URL || (typeof URL !== 'undefined' ? URL : null);
    var AbortC = env.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
    var token = null, tokenExp = 0, tokenFor = '';
    var cache = {}, order = [], inflight = {};

    function ls(k) { try { return store ? (store.getItem(k) || '') : ''; } catch (e) { return ''; } }
    function lset(k, v) { try { if (!store) return false; store.setItem(k, v); return true; } catch (e) { return false; } }
    function ldel(k) { try { if (store) store.removeItem(k); } catch (e) {} }

    function validRegion(r) { return /^[a-z0-9]{3,30}$/.test(r); }
    function config() {
      var voice = ls(K.voice), rate = ls(K.rate), region = ls(K.region);
      return {
        hasKey: !!ls(K.key),
        region: validRegion(region) ? region : DEFAULTS.region,
        voice: VOICES.some(function (x) { return x.id === voice; }) ? voice : DEFAULTS.voice,
        rate: RATES.some(function (x) { return x.v === rate; }) ? rate : DEFAULTS.rate
      };
    }
    function isOn() { return !!ls(K.key); }
    // key 傳 null／空字串＝不改；傳字串＝更新
    function save(o) {
      var ok = true;
      if (o.key) ok = lset(K.key, String(o.key).trim()) && ok;
      if (o.region != null) { var r = String(o.region).trim().toLowerCase(); ok = (r && validRegion(r) ? lset(K.region, r) : (ldel(K.region), true)) && ok; }
      if (o.voice != null) ok = lset(K.voice, o.voice) && ok;
      if (o.rate != null) ok = lset(K.rate, o.rate) && ok;
      if (o.key) { token = null; tokenExp = 0; }
      return ok;
    }
    function clearKey() { ldel(K.key); token = null; tokenExp = 0; tokenFor = ''; clearCache(); }
    function clearCache() {
      order.forEach(function (k) { try { if (urlApi && urlApi.revokeObjectURL) urlApi.revokeObjectURL(cache[k]); } catch (e) {} });
      cache = {}; order = [];
    }

    function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function splitSentences(t) { return String(t).trim().split(/(?<=[.!?;])\s+/).filter(function (s) { return s.trim(); }); }
    function buildSsml(text, voice, rate) {
      var body = splitSentences(text).map(xmlEsc).join("<break time='260ms'/>");
      var locale = (voice.match(/^[a-z]{2}-[A-Z]{2}/) || ['en-US'])[0];
      return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + locale + "'><voice name='" + voice + "'><prosody rate='" + rate + "'>" + body + '</prosody></voice></speak>';
    }

    function withTimeout(fn) {
      var ctrl = AbortC ? new AbortC() : null;
      var t = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS) : null;
      return fn(ctrl ? ctrl.signal : undefined).then(function (v) { if (t) clearTimeout(t); return v; }, function (e) { if (t) clearTimeout(t); throw e; });
    }
    function getToken(key, region) {
      var tag = region + '|' + key.length + '|' + key.slice(-4);   // 只用來判斷「換過 key 沒」，不外傳
      if (token && Date.now() < tokenExp && tokenFor === tag) return Promise.resolve(token);
      return withTimeout(function (signal) {
        return fetchFn('https://' + region + '.api.cognitive.microsoft.com/sts/v1.0/issueToken', { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key }, signal: signal });
      }).then(function (res) {
        if (!res.ok) { var e = new Error('azure token'); e.status = res.status; throw e; }
        return res.text();
      }).then(function (t) { token = t; tokenExp = Date.now() + TOKEN_MS; tokenFor = tag; return t; });
    }

    // 回傳 Promise<blob 網址>；沒 key → 拒絕（呼叫端退回預錄檔）
    function synth(text) {
      var key = ls(K.key);
      if (!key) return Promise.reject(new Error('no key'));
      var t = String(text || '').trim();
      if (!t) return Promise.reject(new Error('empty'));
      if (t.length > 600) return Promise.reject(new Error('too long'));
      var c = config(), ck = c.voice + '|' + c.rate + '|' + t;
      if (cache[ck]) return Promise.resolve(cache[ck]);
      if (inflight[ck]) return inflight[ck];
      var p = getToken(key, c.region).then(function (tk) {
        return withTimeout(function (signal) {
          return fetchFn('https://' + c.region + '.tts.speech.microsoft.com/cognitiveservices/v1', {
            method: 'POST', signal: signal,
            headers: { 'Authorization': 'Bearer ' + tk, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3' },
            body: buildSsml(t, c.voice, c.rate)
          });
        });
      }).then(function (res) {
        if (!res.ok) { var e = new Error('azure tts'); e.status = res.status; throw e; }
        return res.blob();
      }).then(function (blob) {
        var u = urlApi.createObjectURL(blob);
        cache[ck] = u; order.push(ck);
        while (order.length > CACHE_MAX) { var old = order.shift(); try { urlApi.revokeObjectURL(cache[old]); } catch (e) {} delete cache[old]; }
        delete inflight[ck];
        return u;
      }, function (e) {
        delete inflight[ck];
        if (e && e.status === 401) { token = null; tokenExp = 0; }
        var err = new Error('azure failed'); err.status = e && e.status; throw err;   // 不帶任何內容
      });
      inflight[ck] = p;
      return p;
    }

    return { config: config, isOn: isOn, save: save, clearKey: clearKey, synth: synth, buildSsml: buildSsml, _cacheSize: function () { return order.length; } };
  }

  return { create: create, VOICES: VOICES, RATES: RATES, DEFAULTS: DEFAULTS, KEYS: K };
});
