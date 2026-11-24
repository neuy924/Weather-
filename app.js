(function () {
  'use strict';
  var L = window.WXLogic;
  var YEARS = 10;          /* baseline pool: last 10 years */
  var SHOW_YEARS = 5;      /* rows shown in the year-by-year list */
  var DATA_VERSION = 5;
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  var GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
  var REVERSE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
  var HOURLY = 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,cloud_cover,weather_code,is_day';
  /* the forecast call also asks for the nowcast variables (history does not need them) */
  var FC_HOURLY = HOURLY + ',wind_gusts_10m,dew_point_2m,relative_humidity_2m,visibility,precipitation_probability';
  var STALE_MS = 15 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var state = { place: null, units: 'metric', data: null, loading: false, pending: false, lastFetch: 0,
    votes: [], cal: { shift: 0 }, draft: { vote: null, act: 'walking' }, cast: 'deity', calMsg: '', confirmClear: false, csv: '' };

  /* ---------- storage (may throw in private mode) ---------- */
  function sget(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function sset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function sprune(keep) {
    try {
      var del = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if ((k.indexOf('pk:') === 0 || k.indexOf('hist:') === 0) && keep.indexOf(k) < 0) del.push(k);
      }
      del.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  /* ---------- helpers ---------- */
  var S = window.WXSprites;
  var ico = function (n, px) { return S.ui(n, px); };
  function arrowFor(dir) { return ico(dir > 0 ? 'up' : dir < 0 ? 'down' : 'flat', 3); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function imp() { return state.units === 'imperial'; }
  function T(c) { return c == null ? '–' : Math.round(imp() ? c * 1.8 + 32 : c) + '°'; }
  function T1(c) { return c == null ? '–' : (imp() ? c * 1.8 + 32 : c).toFixed(1) + '°'; }
  function dT(d) { return Math.abs(imp() ? d * 1.8 : d).toFixed(1) + '°'; }
  function sdT(d) { return (d >= 0 ? '+' : '−') + dT(d); }
  function W(k) { return k == null ? '–' : imp() ? Math.round(k * 0.621371) + ' mph' : Math.round(k) + ' km/h'; }
  function R(mm) {
    if (mm == null) return '–';
    if (mm < 0.1) return 'dry';
    return imp() ? (mm / 25.4).toFixed(2) + ' in' : mm.toFixed(1) + ' mm';
  }
  function ord(n) {
    n = Math.round(n);
    if (n > 99) return 'above the 99th';
    if (n < 1) return 'below the 1st';
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function pctPhrase(pct, hi, lo) {
    var p = pct >= 50 ? pct : 100 - pct;
    var txt = p > 99 ? '99%+' : Math.round(p) + '%';
    return (pct >= 50 ? hi : lo) + ' ' + txt;
  }
  function fetchJSON(url, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms || 15000);
    return fetch(url, { signal: ctl.signal }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).finally(function () { clearTimeout(t); });
  }
  function qs(o) { return Object.keys(o).map(function (k) { return k + '=' + encodeURIComponent(o[k]); }).join('&'); }
  function status(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.hidden = !msg;
  }
  function placeLabel(p) {
    if (p.name) return p.name;
    return Math.abs(p.lat).toFixed(2) + '°' + (p.lat >= 0 ? 'N' : 'S') + ' ' + Math.abs(p.lon).toFixed(2) + '°' + (p.lon >= 0 ? 'E' : 'W');
  }

  /* ---------- data ---------- */
  function loadForecast(p) {
    return fetchJSON(FORECAST + '?' + qs({
      latitude: p.lat, longitude: p.lon, timezone: 'auto', forecast_days: 2, past_days: 10,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,cloud_cover,weather_code,is_day',
      hourly: FC_HOURLY
    }));
  }

  function packKey(p, target) { return 'pk:' + p.lat.toFixed(2) + ',' + p.lon.toFixed(2) + ':' + target.stamp; }

  /* One past year: fetch its window once, reduce to a small pack, cache it. */
  function loadPack(p, target, hour) {
    var key = packKey(p, target);
    var cached = sget(key);
    if (cached && cached.s) return Promise.resolve({ key: key, year: target.year, adjusted: target.adjusted, pack: cached });
    var m = +target.date.slice(5, 7), d = +target.date.slice(8, 10);
    var rg = L.windowRange(target.year, m, d);
    return fetchJSON(ARCHIVE + '?' + qs({
      latitude: p.lat, longitude: p.lon, start_date: rg.start, end_date: rg.end, hourly: HOURLY, timezone: 'auto'
    })).then(function (j) {
      var pack = L.buildPack(j.hourly, target.year, m, d, hour);
      if (pack.s.length) sset(key, pack);
      return { key: key, year: target.year, adjusted: target.adjusted, pack: pack.s.length ? pack : null };
    }).catch(function (e) {
      return { key: key, year: target.year, adjusted: target.adjusted, pack: null, error: String(e && e.message || e) };
    });
  }

  /* Forecast-model vs ERA5 offset, from the days where both exist (ERA5 lags by about 5 days). */
  function loadBias(p, tg, fc) {
    return fetchJSON(ARCHIVE + '?' + qs({
      latitude: p.lat, longitude: p.lon, start_date: L.ymd(tg.y0, tg.month, tg.day, -10), end_date: L.ymd(tg.y0, tg.month, tg.day, -6),
      hourly: 'temperature_2m,apparent_temperature', timezone: 'auto'
    })).then(function (j) { return L.biasFrom(fc.hourly, j.hourly, 24); })
      .catch(function () { return { t: 0, fl: 0, n: 0, applied: false }; });
  }

  function refresh() {
    var p = state.place;
    if (!p) return Promise.resolve();
    if (state.loading) { state.pending = true; return Promise.resolve(); }
    state.loading = true;
    $('refresh').classList.add('spin');
    if (!state.data) status('Loading weather and 10 years of history…');
    return loadForecast(p).then(function (fc) {
      var cur = fc.current;
      var tg = L.pastTargets(cur.time, YEARS);
      var stamp = cur.time.slice(0, 13) + ':00';
      var pick = L.makePicker(fc.hourly);
      var today = pick(stamp);
      if (!today) throw new Error('No hourly row for ' + stamp);
      var shift = state.cal.shift || 0;
      var now = L.nowReport(pick, tg.y0, tg.month, tg.day, tg.hour, shift);
      var lags = {};
      L.LAGS.forEach(function (n) { lags[n] = pick(L.stampAt(tg.y0, tg.month, tg.day, tg.hour, -n)); });
      return Promise.all([
        Promise.all(tg.targets.map(function (t) { return loadPack(p, t, tg.hour); })),
        loadBias(p, tg, fc)
      ]).then(function (res) {
        var packs = res[0], bias = res[1];
        sprune(packs.map(function (x) { return x.key; }));
        var raw = packs.map(function (x) { return x.pack; });
        var analysis = L.analyze(raw, today, bias, { flShift: shift });
        var week = L.weekCompare(raw, { t: today.t, fl: today.fl }, lags);
        var rows = packs.slice(0, SHOW_YEARS).map(function (x) { return { year: x.year, sample: x.pack ? x.pack.exact : null, adjusted: x.adjusted }; });
        var failed = packs.filter(function (x) { return !x.pack; }).length;
        state.data = {
          v: DATA_VERSION, fetchedAt: Date.now(), place: p, tz: fc.timezone, localTime: cur.time, month: tg.month, day: tg.day, hour: tg.hour,
          current: cur, today: today, now: now, analysis: analysis, week: week, bias: bias, rows: rows, failed: failed
        };
        state.lastFetch = Date.now();
        sset('wx.last', state.data);
        render();
        status(failed ? failed + ' of ' + YEARS + ' past years could not be loaded' + (analysis.ok ? '; results use the rest.' : '.') + ' Tap refresh to retry.' : '', failed ? 'warn' : '');
      });
    }).catch(function (e) {
      if (state.data) status('Offline or error. Showing data from ' + new Date(state.data.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.', 'warn');
      else status('Could not load weather (' + (e && e.message || e) + '). Check your connection and tap refresh.', 'err');
    }).finally(function () {
      state.loading = false;
      $('refresh').classList.remove('spin');
      if (state.pending) { state.pending = false; refresh(); }
    });
  }

  /* ---------- location ---------- */
  function reverseName(p) {
    return fetchJSON(REVERSE + '?' + qs({ latitude: p.lat, longitude: p.lon, localityLanguage: 'en' }), 5000).then(function (j) {
      var n = j.city || j.locality || j.principalSubdivision;
      if (n) return j.countryName ? n + ', ' + j.countryName : n;
      return null;
    }).catch(function () { return null; });
  }

  function useGPS() {
    if (!navigator.geolocation) { openPlaces('This browser has no location access. Search for a city instead.'); return; }
    status('Finding your location…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var p = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), name: null, mode: 'gps' };
      var prev = state.place;
      if (prev && prev.mode === 'gps' && Math.abs(prev.lat - p.lat) < 0.03 && Math.abs(prev.lon - p.lon) < 0.03) { p.lat = prev.lat; p.lon = prev.lon; p.name = prev.name; }
      state.place = p; sset('wx.place', p);
      closePlaces();
      if (!p.name) reverseName(p).then(function (n) { if (n && state.place === p) { p.name = n; sset('wx.place', p); if (state.data) { state.data.place = p; render(); } } });
      state.data = (state.data && state.data.place.lat === p.lat && state.data.place.lon === p.lon) ? state.data : null;
      render();
      refresh();
    }, function (err) {
      var denied = err && err.code === 1;
      status('', '');
      if (state.place) { status(denied ? 'Location is off for this app. Using ' + placeLabel(state.place) + '.' : 'Could not get a GPS fix. Using ' + placeLabel(state.place) + '.', 'warn'); refresh(); }
      else openPlaces(denied ? 'Location permission is off. On iPhone: Settings to Privacy to Location Services to Safari Websites. Or search for a city.' : 'Could not get a GPS fix. Search for a city instead.');
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 });
  }

  var searchTimer = null, searchSeq = 0;
  function openPlaces(msg) {
    $('sheet').hidden = false;
    $('place-msg').textContent = msg || '';
    $('place-msg').hidden = !msg;
    setTimeout(function () { $('q').focus(); }, 50);
  }
  function closePlaces() { $('sheet').hidden = true; $('q').value = ''; $('results').innerHTML = ''; }
  function search(q) {
    var seq = ++searchSeq;
    if (q.trim().length < 2) { $('results').innerHTML = ''; return; }
    fetchJSON(GEOCODE + '?' + qs({ name: q.trim(), count: 8, language: 'en', format: 'json' }), 8000).then(function (j) {
      if (seq !== searchSeq) return;
      var rs = j.results || [];
      $('results').innerHTML = rs.length ? rs.map(function (r, i) {
        var sub = [r.admin1, r.country].filter(Boolean).join(', ');
        return '<li><button type="button" data-i="' + i + '"><b>' + esc(r.name) + '</b><span>' + esc(sub) + '</span></button></li>';
      }).join('') : '<li class="none">No matches</li>';
      $('results').onclick = function (ev) {
        var b = ev.target.closest('button[data-i]'); if (!b) return;
        var r = rs[+b.getAttribute('data-i')];
        var p = { lat: +r.latitude.toFixed(4), lon: +r.longitude.toFixed(4), name: r.name + (r.country ? ', ' + r.country : ''), mode: 'city' };
        state.place = p; state.data = null; sset('wx.place', p);
        closePlaces(); render(); refresh();
      };
    }).catch(function () { if (seq === searchSeq) $('results').innerHTML = '<li class="none">Search failed. Check your connection.</li>'; });
  }

  /* ---------- rendering ---------- */
  function fmtLocalHeader(d) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.day + ' ' + months[d.month - 1] + ', ' + L.pad(d.hour) + ':00 local time';
  }
  function when(d) { return L.pad(d.hour) + ':00'; }

  /* Normal range (P10-P90) with median tick and today's marker. */
  function rangeChart(a) {
    var lo = Math.min(a.p10, a.today) - 1.5, hi = Math.max(a.p90, a.today) + 1.5;
    var x = function (v) { return 14 + (v - lo) / (hi - lo) * 272; };
    var svg = '<svg viewBox="0 0 300 64" role="img" aria-label="Today versus the normal range" class="band">';
    var q = function (v) { return Math.round(v / 2) * 2; };
    svg += '<rect x="14" y="30" width="272" height="4" class="axis"/>';
    svg += '<rect x="' + q(x(a.p10)) + '" y="22" width="' + Math.max(4, q(x(a.p90) - x(a.p10))) + '" height="20" class="range"/>';
    svg += '<rect x="' + (q(x(a.p50)) - 1) + '" y="20" width="4" height="24" class="med"/>';
    svg += '<rect x="' + (q(x(a.today)) - 1) + '" y="14" width="4" height="36" class="tline"/><rect x="' + (q(x(a.today)) - 7) + '" y="26" width="16" height="12" class="tdot"/>';
    svg += '<text x="' + x(a.today) + '" y="10" text-anchor="middle" class="lbl strong">Today ' + T(a.today) + '</text>';
    svg += '<text x="' + x(a.p10) + '" y="60" text-anchor="middle" class="lbl">' + T(a.p10) + '</text>';
    if (x(a.p90) - x(a.p10) > 36) svg += '<text x="' + x(a.p90) + '" y="60" text-anchor="middle" class="lbl">' + T(a.p90) + '</text>';
    return svg + '</svg><p class="fine">Shaded = the middle 80% of similar hours over the last 10 years. Tick = median.</p>';
  }

  /* Same hour on days 10..5 ago, then now (all from the same forecast model). */
  function weekChart(r, nowVal) {
    var pts = r.series.slice().reverse().map(function (s) { return { lab: '−' + s.lag + 'd', v: s.v, lag: s.lag }; });
    pts.push({ lab: 'now', v: nowVal, lag: 0 });
    var vals = pts.filter(function (p) { return p.v != null; }).map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vals) - 1, hi = Math.max.apply(null, vals) + 1;
    var X = function (i) { return 24 + i * (252 / (pts.length - 1)); };
    var Y = function (v) { return 14 + (hi - v) / (hi - lo) * 44; };
    var svg = '<svg viewBox="0 0 300 84" role="img" aria-label="Temperature at this hour over the past 10 days" class="band">';
    var d = '';
    pts.forEach(function (p, i) { if (p.v != null) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1); });
    svg += '<path d="' + d + '" class="wline"/>';
    pts.forEach(function (p, i) {
      if (p.v == null) return;
      var now = p.lag === 0, seven = p.lag === 7;
      var rr = now ? 6 : seven ? 5 : 3.5;
      svg += '<rect x="' + Math.round(X(i) - rr) + '" y="' + Math.round(Y(p.v) - rr) + '" width="' + Math.round(rr * 2) + '" height="' + Math.round(rr * 2) + '" class="' + (now ? 'tdot' : seven ? 'sdot' : 'pdot') + '"><title>' + p.lab + ': ' + T1(p.v) + '</title></rect>';
      if (now || seven) svg += '<text x="' + X(i).toFixed(1) + '" y="' + (Y(p.v) - 9).toFixed(1) + '" text-anchor="middle" class="lbl strong">' + T(p.v) + '</text>';
      svg += '<text x="' + X(i).toFixed(1) + '" y="80" text-anchor="middle" class="lbl">' + p.lab + '</text>';
    });
    return svg + '</svg>';
  }

  function row(label, cls, r, c, adjusted) {
    if (!r) return '<li class="yr missing"><span class="y">' + esc(label) + '</span><span class="m">Data unavailable</span></li>';
    var d = L.describeCode(r.code, r.isDay);
    return '<li class="yr ' + cls + '"><span class="y">' + esc(label) + (adjusted ? '<i title="29 Feb used 28 Feb">*</i>' : '') + '</span>' +
      '<span class="ic" title="' + esc(d.text) + '">' + S.weather(r.code, r.isDay, 2, esc(d.text)) + '</span>' +
      '<span class="fl"><b>' + T(r.fl) + '</b><small>air ' + T(r.t) + '</small></span>' +
      '<span class="det">' + esc(d.text) + '<small>' + R(r.precip) + ' · ' + W(r.wind) + ' · ' + ico('cloud', 1) + (r.cloud == null ? '–' : Math.round(r.cloud) + '%') + '</small></span>' +
      '<span class="sc"><b>' + Math.round(c.score) + '</b><span class="bar ' + (c.score >= 66 ? 'g' : c.score >= 40 ? 'y' : 'r') + '"><i style="width:' + Math.round(c.score) + '%"></i></span></span></li>';
  }

  function statLine(name, a) {
    var anom = a.anom;
    return '<li><span class="k">' + name + '</span><span class="v"><b>' + T(a.today) + '</b> vs normal ' + T(a.mean) + ' to <b>' + sdT(anom) + '</b>' +
      '<small>' + pctPhrase(a.pct, 'warmer than', 'colder than') + ' of similar hours · ' + (a.z >= 0 ? '+' : '−') + Math.abs(a.z).toFixed(1) + ' standard deviations (typical spread ±' + dT(a.sd) + ')</small></span></li>';
  }

  function weekLine(name, r, nowV) {
    var out = '';
    if (r.d7 != null) {
      out += '<li><span class="k">' + name + '</span><span class="v"><b>' + sdT(r.d7) + '</b> vs 7 days ago (' + T(nowV - r.d7) + ' to ' + T(nowV) + ')' +
        '<small>' + pctPhrase(r.pct7, 'Bigger rise than', 'Bigger fall than') + ' of past week-on-week changes at this date (usual change ' + sdT(r.drift7) + ').</small></span></li>';
    }
    if (r.d510 != null) {
      out += '<li><span class="k">' + (r.d7 != null ? '' : name) + '</span><span class="v"><b>' + sdT(r.d510) + '</b> vs the average of days 5–10 ago (' + T(r.mean510) + ')' +
        '<small>' + pctPhrase(r.pct510, 'Bigger rise than', 'Bigger fall than') + ' of past changes (usual ' + sdT(r.drift510) + ').</small></span></li>';
    }
    return out;
  }


  /* ---------- nowcast cards: what to wear, damp, frost, rain, wind ---------- */
  function dampText(r) {
    if (r.k === 'fog') return 'fog';
    if (r.k === 'wet') return 'drizzle or rain now';
    if (r.k === 'rain6') return R(r.mm) + ' in the last 6 hours';
    if (r.k === 'saturated') return 'saturated air (' + (r.spread != null ? 'dew point ' + dT(r.spread) + ' below air temperature' : 'humidity ' + Math.round(r.rh) + '%') + ')';
    if (r.k === 'vis') return 'visibility ' + Math.round(r.m) + ' m';
    return r.k;
  }
  var FROST_TEXT = { ice: 'Ice risk', frost: 'Frost likely', watch: 'Frost possible', none: 'No frost or ice risk' };

  /* walking weather character, picked from the sprite sheet for the current conditions */
  function castFor(d, c) {
    var n = d.now, cur = n && n.nc && n.nc.cur;
    return S.character(state.cast, {
      code: c.weather_code, isDay: c.is_day, gust: cur ? cur.gust : null, wind: c.wind_speed_10m, fl: c.apparent_temperature,
      frost: n ? n.frost.level : 'none', precip: c.precipitation, cloud: c.cloud_cover
    });
  }
  function walker(d, c) {
    var k = castFor(d, c);
    return '<div class="walker" aria-hidden="true"><div class="sprite ' + k.set + '" style="background-position-y:' + (-64 * k.row) + 'px"></div></div>';
  }
  function castLine(d, c) {
    var k = castFor(d, c);
    return '<div class="cast"><span>' + esc(k.name) + ' · ' + esc(k.tag) + '</span><button type="button" class="linkbtn" id="castbtn">' + (k.set === 'deity' ? 'Switch to beasts' : 'Switch to deities') + '</button></div>';
  }

  function renderNow(d) {
    var n = d.now;
    if (!n) { $('wear').innerHTML = ''; $('wear').className = ''; $('cond').innerHTML = ''; $('cond').className = ''; return; }
    var w = n.wear, nx = n.nc.next, cur = n.nc.cur, f = n.frost, dm = n.damp;

    var items = '';
    if (w.drop >= 3 && w.minAt) items += '<li>Cooling to <b>' + T(w.minFL) + '</b> feels-like by ' + esc(w.minAt) + '.</li>';
    w.extras.forEach(function (t) { items += '<li>' + esc(t) + '</li>'; });
    $('wear').className = 'card wear';
    $('wear').innerHTML = '<h3>What to wear · walking, next 6 hours</h3><h2>' + esc(w.base) + '</h2>' +
      (items ? '<ul class="why">' + items + '</ul>' : '') +
      '<p class="fine">Based on the coldest feels-like from now to +6 h (' + T(w.minFL) + ')' + (w.shift ? ', adjusted by ' + sdT(w.shift) + ' for you from your votes' : '') + '. Assumes walking pace. The bands are my judgement, not a standard.</p>' +
      '<button type="button" class="logbtn" id="logbtn">Log how it feels</button>';

    var chips = '<span class="flag ' + (dm.on ? 'on' : 'off') + '">' + (dm.on ? ico('drop', 2) + 'Damp' : 'Not damp') + '</span>' +
      '<span class="flag ' + (f.level === 'ice' ? 'ice' : f.level === 'frost' ? 'frost' : f.level === 'watch' ? 'on' : 'off') + '">' + (f.level === 'none' ? 'No frost risk' : ico('flake', 2) + FROST_TEXT[f.level]) + '</span>';
    var rows = '';
    rows += '<li><span class="k">Damp</span><span class="v">' + (dm.on ? '<b>Yes</b>' : '<b>No</b>') +
      '<small>' + (dm.on ? dm.reasons.map(dampText).join(' · ') : 'No rain, fog or saturated air detected') + '</small></span></li>';
    rows += '<li><span class="k">Frost / ice</span><span class="v"><b>' + esc(FROST_TEXT[f.level]) + '</b>' +
      '<small>Lowest air temperature ' + T1(f.minT) + ' in the next 6 h' + (f.level !== 'none' && f.clearCalm ? '; clear, calm night, so surfaces may be colder' : '') + (f.level !== 'none' && f.wetSurface ? '; wet surfaces' : '') + '. A rule of thumb, not a measurement.</small></span></li>';
    rows += '<li><span class="k">Rain</span><span class="v"><b>' + (n.nc.past6mm == null ? 'unknown' : R(n.nc.past6mm)) + '</b> last 6 h · <b>' + (nx.precip == null ? 'unknown' : R(nx.precip)) + '</b> next 6 h' +
      (nx.popMax != null ? '<small>Up to ' + Math.round(nx.popMax) + '% chance in the next 6 hours</small>' : '') + '</span></li>';
    rows += '<li><span class="k">Wind</span><span class="v">Gusts <b>' + W(cur.gust) + '</b> now, up to <b>' + W(nx.gustMax) + '</b> in the next 6 h<small>Sustained ' + W(cur.wind) + '</small></span></li>';
    rows += '<li><span class="k">Dew point</span><span class="v"><b>' + T1(cur.dew) + '</b> · humidity ' + (cur.rh == null ? '–' : Math.round(cur.rh) + '%') +
      '<small>' + (cur.dew == null ? '' : 'Air is ' + dT(cur.t - cur.dew) + ' above dew point') + '</small></span></li>';
    $('cond').className = 'card cond';
    $('cond').innerHTML = '<h3>Conditions now and next 6 hours</h3><div class="flags">' + chips + '</div><ul class="stats">' + rows + '</ul>';
  }

  function render() {
    var d = state.data, p = state.place;
    $('place-name').textContent = p ? placeLabel(p) : 'Choose a place';
    $('units').textContent = imp() ? '°F' : '°C';
    if (!d) { $('content').hidden = true; return; }
    $('place-name').textContent = placeLabel(d.place || p);
    $('content').hidden = false;
    $('when').textContent = fmtLocalHeader(d);

    var c = d.current, desc = L.describeCode(c.weather_code, c.is_day);
    var hs = state.cal.shift || 0;
    $('hero').innerHTML =
      '<div class="scene"><div class="ico">' + S.weather(c.weather_code, c.is_day, 5, esc(desc.text)) + '</div>' +
      '<div class="big"><span class="lab">' + (hs ? 'Feels like to you' : 'Feels like') + '</span><span class="num">' + T(c.apparent_temperature + hs) + '</span></div>' +
      '<div class="ground"></div>' + walker(d, c) + '</div>' +
      '<div class="dlg"><div class="cond">' + esc(desc.text) + ' · air ' + T(c.temperature_2m) + (hs ? ' · standard feels-like ' + T(c.apparent_temperature) : '') + '</div>' +
      '<div class="chips"><span>' + ico('wind', 2) + W(c.wind_speed_10m) + '</span><span>' + ico('drop', 2) + (c.relative_humidity_2m == null ? '–' : Math.round(c.relative_humidity_2m) + '%') + '</span><span>' + ico('cloud', 2) + Math.round(c.cloud_cover) + '%</span><span>' + ico('rain', 2) + R(c.precipitation) + '</span></div>' + castLine(d, c) + '</div>';

    renderNow(d);

    var a = d.analysis, w = d.week;

    /* ---- Card 1: vs last 10 years ---- */
    if (!a || !a.ok) {
      $('vs10').className = 'card verdict t-normal';
      $('vs10').innerHTML = '<h2>Not enough history yet</h2><p class="sub">Need at least 5 of the last ' + YEARS + ' years; got ' + (a ? a.years : 0) + '. Tap refresh to retry.</p>';
      $('band').innerHTML = '';
    } else {
      var lab = a.t.label;
      $('vs10').className = 'card verdict t-' + lab.key;
      var biasNote = a.bias && a.bias.applied && Math.abs(a.bias.t) >= 0.15
        ? '<p class="fine">Forecast model reads ' + dT(a.bias.t) + (a.bias.t > 0 ? ' warmer' : ' colder') + ' than the reanalysis used for history over the last ' + Math.round(a.bias.n / 24) + ' days, so today was adjusted by ' + sdT(-a.bias.t) + ' for a fair comparison.</p>'
        : '';
      $('vs10').innerHTML =
        '<h3>Versus the last 10 years · ' + d.day + '/' + d.month + ' around ' + when(d) + '</h3>' +
        '<div class="vh"><span class="arrow" aria-hidden="true">' + arrowFor(a.t.z >= 0.5 ? 1 : a.t.z <= -0.5 ? -1 : 0) + '</span><h2>' + esc(lab.text) + '</h2></div>' +
        '<ul class="stats">' + statLine('Air temp', a.t) + statLine('Feels like', a.fl) + '</ul>' + biasNote;
      $('band').innerHTML = rangeChart(a.t);
    }

    /* ---- Card 2: vs last week ---- */
    var wt = w && w.t, wf = w && w.fl;
    if (!wt || (wt.d7 == null && wt.d510 == null)) {
      $('vsweek').innerHTML = '<h3>Versus last week</h3><p class="sub">Not enough recent data to compare.</p>';
      $('vsweek').className = 'card verdict t-normal';
    } else {
      var l7 = wt.label7 || wt.label510;
      $('vsweek').className = 'card verdict t-' + l7.key;
      $('vsweek').innerHTML =
        '<h3>Versus last week · same hour (' + when(d) + ')</h3>' +
        '<div class="vh"><span class="arrow" aria-hidden="true">' + arrowFor(l7.key.indexOf('warm') === 0 ? 1 : l7.key.indexOf('cold') === 0 ? -1 : 0) + '</span><h2>' + esc(l7.text) + '</h2></div>' +
        '<div id="weekchart">' + weekChart(wt, d.today.t) + '</div>' +
        '<ul class="stats">' + weekLine('Air temp', wt, d.today.t) + (wf ? weekLine('Feels like', wf, d.today.fl) : '') + '</ul>' +
        '<p class="fine">Compares like with like (same forecast model, same hour). "Usual change" is the typical week-on-week change over the last 10 years at this date, so a seasonal cooling or warming is not counted as a surprise.</p>';
    }

    /* ---- Card 3: comfort (secondary) ---- */
    if (a && a.ok) {
      var cf = a.comfort;
      $('comfort').className = 'card verdict v-' + cf.verdict.key;
      var names = { temp: 'feels-like temperature', rain: 'rain', wind: 'wind', cloud: 'cloud cover' };
      var bullets = [];
      bullets.push('Rain: it is ' + (cf.todayWet ? 'wet' : 'dry') + ' now; ' + Math.round(cf.wetShare * 100) + '% of similar hours had rain.');
      if (cf.driver) bullets.push('Biggest factor: <b>' + names[cf.driver] + '</b> (' + (cf.pts[cf.driver] > 0 ? 'helps by ' : 'hurts by ') + Math.abs(cf.pts[cf.driver]).toFixed(0) + ' points).');
      $('comfort').innerHTML =
        '<h3>Comfort (secondary)</h3>' +
        '<div class="vh"><span class="arrow" aria-hidden="true">' + arrowFor(/▲/.test(cf.verdict.arrow) ? 1 : /▼/.test(cf.verdict.arrow) ? -1 : 0) + '</span><h2>' + esc(cf.verdict.label) + '</h2></div>' +
        '<div class="hp"><span class="hl">SCORE</span><span class="bar ' + (cf.score >= 66 ? 'g' : cf.score >= 40 ? 'y' : 'r') + '"><i style="width:' + Math.round(cf.score) + '%"></i><span class="usual" style="left:' + Math.max(1, Math.min(99, Math.round(cf.mean))) + '%" title="usual"></span></span><b>' + Math.round(cf.score) + '</b></div>' +
        '<p class="sub">Score <b>' + Math.round(cf.score) + '</b> vs <b>' + Math.round(cf.mean) + '</b> usual for this date and hour (' + (cf.diff >= 0 ? '+' : '−') + Math.abs(cf.diff).toFixed(0) + '; ' + pctPhrase(cf.pct, 'more comfortable than', 'less comfortable than') + ' of similar hours).</p>' +
        '<ul class="why">' + bullets.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';
    } else { $('comfort').className = 'card'; $('comfort').innerHTML = ''; }

    /* ---- Card 4: year-by-year rows ---- */
    var html = row('Today', 'today', d.today, L.comfort(d.today));
    d.rows.forEach(function (r) { html += row(String(r.year), '', r.sample, r.sample ? L.comfort(r.sample) : null, r.adjusted); });
    $('years').innerHTML = html;
    renderCal();
    $('updated').textContent = 'Updated ' + new Date(d.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- sensation votes and personal calibration ---------- */
  var SENS = ['cold', 'cool', 'slightly cool', 'neutral', 'slightly warm', 'warm', 'hot'];
  var r1 = function (v) { return v == null ? null : Math.round(v * 10) / 10; };
  function fmtVote(m) { return (m > 0.05 ? '+' : m < -0.05 ? '−' : '') + Math.abs(m).toFixed(1); }

  function placeNow() { return state.data ? state.data.place : state.place; }
  function localStr(d) {
    try { return new Date().toLocaleString('sv-SE', { timeZone: d.tz }); } catch (e) { return d.localTime; }
  }
  function snapshot(d) {
    var n = d.now; if (!n) return null;
    var cur = n.nc.cur;
    return { fl: r1(cur.fl), t: r1(cur.t), wind: r1(cur.wind), gust: r1(cur.gust), rain6: r1(n.nc.past6mm), rainNext6: r1(n.nc.next.precip),
      dew: r1(cur.dew), rh: cur.rh == null ? null : Math.round(cur.rh), damp: n.damp.on, frost: n.frost.level, minFL: r1(n.wear.minFL) };
  }

  function syncVoteSheet() {
    var q = function (sel, attr, val) {
      Array.prototype.forEach.call($('vote').querySelectorAll(sel), function (b) { b.classList.toggle('sel', b.getAttribute(attr) === String(val)); });
    };
    q('button[data-v]', 'data-v', state.draft.vote);
    q('button[data-a]', 'data-a', state.draft.act);
    $('vsave').disabled = state.draft.vote === null;
  }
  function voteNote() {
    var d = state.data;
    if (!d) return;
    var age = Math.round((Date.now() - d.fetchedAt) / 60000);
    $('vnote').textContent = 'Weather as of ' + new Date(d.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' at ' + placeLabel(d.place) +
      '.' + (age > 30 ? ' Refreshing the weather first…' : '');
  }
  function openVote() {
    if (!state.data || !state.data.now) return;
    state.draft = { vote: null, act: 'walking' };
    syncVoteSheet(); voteNote();
    $('vote').hidden = false;
    if (Date.now() - state.data.fetchedAt > 30 * 60000) refresh().then(voteNote);
  }
  function closeVote() { $('vote').hidden = true; }
  function saveVote() {
    var d = state.data, n = d && d.now;
    if (!n || state.draft.vote === null) return;
    var pl = d.place;
    state.votes.push({ id: Date.now(), ts: new Date().toISOString(), local: localStr(d),
      place: { name: placeLabel(pl), lat: pl.lat, lon: pl.lon, mode: pl.mode },
      act: state.draft.act, vote: state.draft.vote, band: n.wear.band, shift: state.cal.shift || 0, snap: snapshot(d) });
    if (state.votes.length > 3000) state.votes = state.votes.slice(-3000);
    sset('wx.votes', state.votes);
    closeVote(); state.calMsg = ''; renderCal();
    status('Vote saved.', '');
    setTimeout(function () { if ($('status').textContent === 'Vote saved.') status('', ''); }, 2500);
  }

  function votesChart(votes) {
    var pts = votes.filter(function (v) { return v.snap && v.snap.fl != null; });
    if (pts.length < 3) return '';
    var lo = Math.min.apply(null, pts.map(function (v) { return v.snap.fl; })) - 1, hi = Math.max.apply(null, pts.map(function (v) { return v.snap.fl; })) + 1;
    if (hi - lo < 6) { var mid = (hi + lo) / 2; lo = mid - 3; hi = mid + 3; }
    var X = function (f) { return 28 + (f - lo) / (hi - lo) * 262; };
    var Y = function (v) { return 8 + (3 - v) / 6 * 96; };
    var svg = '<svg viewBox="0 0 300 130" role="img" aria-label="Your votes against feels-like" class="band">';
    [-3, 0, 3].forEach(function (g) { svg += '<line x1="28" x2="290" y1="' + Y(g) + '" y2="' + Y(g) + '" class="' + (g === 0 ? 'axis zero' : 'axis') + '"/><text x="22" y="' + (Y(g) + 3) + '" text-anchor="end" class="lbl">' + (g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g) + '</text>'; });
    var bins = {};
    pts.forEach(function (v) {
      svg += '<rect x="' + Math.round(X(v.snap.fl) - 3) + '" y="' + Math.round(Y(v.vote) - 3) + '" width="6" height="6" class="vdot"><title>' + T1(v.snap.fl) + ' feels-like, vote ' + v.vote + '</title></rect>';
      var b = Math.floor(v.snap.fl / 3); (bins[b] = bins[b] || []).push(v);
    });
    var path = '';
    Object.keys(bins).map(Number).sort(function (a, b) { return a - b; }).forEach(function (b) {
      if (bins[b].length < 2) return;
      var mf = bins[b].reduce(function (s, v) { return s + v.snap.fl; }, 0) / bins[b].length, mv = bins[b].reduce(function (s, v) { return s + v.vote; }, 0) / bins[b].length;
      path += (path ? 'L' : 'M') + X(mf).toFixed(1) + ' ' + Y(mv).toFixed(1);
    });
    if (path) svg += '<path d="' + path + '" class="vline"/>';
    svg += '<text x="28" y="124" class="lbl">' + T(lo) + '</text><text x="290" y="124" text-anchor="end" class="lbl">' + T(hi) + '</text><text x="159" y="124" text-anchor="middle" class="lbl">feels-like</text>';
    return svg + '</svg><p class="fine">Each dot is one vote. The line is the average vote per 3° band (bands with 2+ votes).</p>';
  }

  function renderCal() {
    var el = $('cal');
    var votes = state.votes, c = L.calibrate(votes);
    var html = '<h3>Your calibration</h3>';
    if (!votes.length) {
      html += '<p class="sub">No votes yet. Use <b>Log how it feels</b> under What to wear after a walk or commute. Each vote takes two taps.</p>';
    } else {
      var last = votes[votes.length - 1];
      html += '<p class="sub"><b>' + c.n + '</b> vote' + (c.n === 1 ? '' : 's') + '. Last: ' + esc((last.local || '').slice(0, 16)) + '.</p>';
      if (c.ok) {
        html += '<p>Your votes average <b>' + fmtVote(c.mean) + '</b> (80% range ' + fmtVote(c.p10) + ' to ' + fmtVote(c.p90) + '), where 0 is neutral. ' +
          (c.significant
            ? 'You feel <b>' + (c.mean < 0 ? 'colder' : 'warmer') + '</b> than the app\'s feels-like implies. Suggested personal adjustment: <b>' + sdT(c.shift) + '</b> to feels-like.'
            : 'That is close enough to neutral that no adjustment is suggested.') + '</p>';
        if (c.significant && (state.cal.shift || 0) !== c.shift) html += '<button type="button" class="logbtn" data-do="apply">Apply ' + sdT(c.shift) + ' to felt temperature, clothing bands and comfort</button>';
      } else {
        html += '<p>Need <b>' + (c.min - c.n) + '</b> more votes before an adjustment can be proposed, and more like 30+ for it to be stable.</p>';
      }
      html += votesChart(votes);
      if (c.byAct.length) html += '<p class="fine">By activity: ' + c.byAct.map(function (b) { return esc(b.key) + ' ' + fmtVote(b.mean) + ' (n=' + b.n + ')'; }).join(' · ') + '</p>';
    }
    if (state.cal.shift) html += '<p class="active-shift">Active adjustment: <b>' + sdT(state.cal.shift) + '</b> <button type="button" class="linkbtn" data-do="reset">Reset</button></p>';
    if (votes.length) {
      html += '<div class="calbtns"><button type="button" data-do="copy">Copy CSV</button><button type="button" data-do="undo">Undo last</button>' +
        '<button type="button" data-do="clear" class="' + (state.confirmClear ? 'danger' : '') + '">' + (state.confirmClear ? 'Tap again to delete all' : 'Clear all') + '</button></div>';
    }
    if (state.calMsg) html += '<p class="fine">' + esc(state.calMsg) + '</p>';
    if (state.csv) html += '<textarea id="csvbox" readonly rows="6">' + esc(state.csv) + '</textarea>';
    html += '<p class="fine">Stored only on this phone. The adjustment assumes about ' + L.SENS_PER_DEG + ' scale steps per °C at fixed clothing; that figure is my assumption, not measured for you. Votes are ordered categories, so averages are rough. The score is how it feels in your usual clothing; if your clothing changes with the season the adjustment may drift.</p>';
    el.innerHTML = html;
    if (state.csv) { var box = $('csvbox'); if (box) { box.focus(); box.select(); } }
  }

  function copyCSV() {
    var csv = L.votesToCSV(state.votes);
    var fallback = function () { state.csv = csv; state.calMsg = 'Could not copy automatically. Select all in the box below and copy.'; renderCal(); };
    try {
      navigator.clipboard.writeText(csv).then(function () { state.csv = ''; state.calMsg = 'Copied ' + state.votes.length + ' votes as CSV.'; renderCal(); }, fallback);
    } catch (e) { fallback(); }
  }

  function calAction(act) {
    if (act !== 'clear') state.confirmClear = false;
    if (act === 'apply') {
      var c = L.calibrate(state.votes);
      if (!c.ok) return;
      state.cal = { shift: c.shift, since: new Date().toISOString(), nAs: c.nAs };
      sset('wx.cal', state.cal); state.calMsg = 'Adjustment applied; updating…'; renderCal(); refresh().then(function () { state.calMsg = 'Adjustment applied.'; renderCal(); });
    } else if (act === 'reset') {
      state.cal = { shift: 0 }; sset('wx.cal', state.cal); state.calMsg = 'Adjustment removed; updating…'; renderCal(); refresh().then(function () { state.calMsg = 'Adjustment removed.'; renderCal(); });
    } else if (act === 'copy') { copyCSV(); return; }
    else if (act === 'undo') { state.votes.pop(); sset('wx.votes', state.votes); state.calMsg = 'Last vote removed.'; state.csv = ''; renderCal(); }
    else if (act === 'clear') {
      if (!state.confirmClear) { state.confirmClear = true; renderCal(); setTimeout(function () { if (state.confirmClear) { state.confirmClear = false; renderCal(); } }, 5000); return; }
      state.confirmClear = false; state.votes = []; sset('wx.votes', []); state.calMsg = 'All votes deleted.'; state.csv = ''; renderCal();
    }
  }

  /* ---------- init ---------- */
  function init() {
    document.querySelector('#place-btn .pin').innerHTML = ico('pin', 3);
    $('refresh').innerHTML = ico('refresh', 2);
    $('close').innerHTML = ico('close', 2); $('vclose').innerHTML = ico('close', 2);
    $('gps').innerHTML = ico('pin', 2) + '<span>Use my location</span>';
    var u = sget('wx.units'); if (u === 'imperial' || u === 'metric') state.units = u;
    state.place = sget('wx.place');
    var vs = sget('wx.votes');
    if (Array.isArray(vs)) {
      state.votes = vs.filter(function (v) { return v && !('wore' in v); });   /* v1 votes recorded clothing; dropped by design */
      if (state.votes.length !== vs.length) sset('wx.votes', state.votes);
    }
    var ct = sget('wx.cast'); if (ct === 'deity' || ct === 'beast') state.cast = ct;
    var cl = sget('wx.cal'); if (cl && typeof cl.shift === 'number') state.cal = cl;
    var last = sget('wx.last');
    if (last && last.v === DATA_VERSION && state.place && last.place && last.place.lat === state.place.lat && last.place.lon === state.place.lon) state.data = last;

    $('refresh').addEventListener('click', function () { refresh(); });
    $('units').addEventListener('click', function () { state.units = imp() ? 'metric' : 'imperial'; sset('wx.units', state.units); render(); });
    $('place-btn').addEventListener('click', function () { openPlaces(''); });
    $('close').addEventListener('click', closePlaces);
    $('gps').addEventListener('click', function () { useGPS(); });
    $('q').addEventListener('input', function (e) { clearTimeout(searchTimer); var v = e.target.value; searchTimer = setTimeout(function () { search(v); }, 300); });
    document.addEventListener('click', function (e) {
      if (e.target.closest('#logbtn')) { openVote(); return; }
      if (e.target.closest('#castbtn')) { state.cast = state.cast === 'deity' ? 'beast' : 'deity'; sset('wx.cast', state.cast); render(); return; }
      var b = e.target.closest('#cal [data-do]'); if (b) calAction(b.getAttribute('data-do'));
    });
    $('vclose').addEventListener('click', closeVote);
    $('vsave').addEventListener('click', saveVote);
    $('vote').addEventListener('click', function (e) {
      if (e.target === $('vote')) { closeVote(); return; }
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-v')) state.draft.vote = +b.getAttribute('data-v');
      else if (b.hasAttribute('data-a')) state.draft.act = b.getAttribute('data-a');
      syncVoteSheet();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.place && Date.now() - state.lastFetch > STALE_MS) {
        if (state.place.mode === 'gps') useGPS(); else refresh();
      }
    });

    render();
    if (state.place) {
      if (state.place.mode === 'gps') useGPS(); else refresh();
    } else {
      openPlaces('');
      $('place-msg').hidden = true;
    }

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });
    }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
