(function () {
  'use strict';
  var L = window.WXLogic;
  var YEARS = 10;          /* baseline pool: last 10 years */
  var SHOW_YEARS = 5;      /* rows shown in the year-by-year list */
  var DATA_VERSION = 3;
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  var GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
  var REVERSE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
  var HOURLY = 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,cloud_cover,weather_code,is_day';
  var STALE_MS = 15 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var state = { place: null, units: 'metric', data: null, loading: false, pending: false, lastFetch: 0 };

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
      latitude: p.lat, longitude: p.lon, timezone: 'auto', forecast_days: 1, past_days: 10,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,cloud_cover,weather_code,is_day',
      hourly: HOURLY
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
      var lags = {};
      L.LAGS.forEach(function (n) { lags[n] = pick(L.stampAt(tg.y0, tg.month, tg.day, tg.hour, -n)); });
      return Promise.all([
        Promise.all(tg.targets.map(function (t) { return loadPack(p, t, tg.hour); })),
        loadBias(p, tg, fc)
      ]).then(function (res) {
        var packs = res[0], bias = res[1];
        sprune(packs.map(function (x) { return x.key; }));
        var raw = packs.map(function (x) { return x.pack; });
        var analysis = L.analyze(raw, today, bias);
        var week = L.weekCompare(raw, { t: today.t, fl: today.fl }, lags);
        var rows = packs.slice(0, SHOW_YEARS).map(function (x) { return { year: x.year, sample: x.pack ? x.pack.exact : null, adjusted: x.adjusted }; });
        var failed = packs.filter(function (x) { return !x.pack; }).length;
        state.data = {
          v: DATA_VERSION, fetchedAt: Date.now(), place: p, tz: fc.timezone, localTime: cur.time, month: tg.month, day: tg.day, hour: tg.hour,
          current: cur, today: today, analysis: analysis, week: week, bias: bias, rows: rows, failed: failed
        };
        state.lastFetch = Date.now();
        sset('wx.last', state.data);
        render();
        status(failed ? failed + ' of ' + YEARS + ' past years could not be loaded' + (analysis.ok ? '; results use the rest.' : '.') + ' Tap ↻ to retry.' : '', failed ? 'warn' : '');
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
      else openPlaces(denied ? 'Location permission is off. On iPhone: Settings → Privacy → Location Services → Safari Websites. Or search for a city.' : 'Could not get a GPS fix. Search for a city instead.');
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
    svg += '<line x1="14" x2="286" y1="32" y2="32" class="axis"/>';
    svg += '<rect x="' + x(a.p10) + '" y="24" width="' + Math.max(3, x(a.p90) - x(a.p10)) + '" height="16" rx="8" class="range"/>';
    svg += '<line x1="' + x(a.p50) + '" x2="' + x(a.p50) + '" y1="22" y2="42" class="med"/>';
    svg += '<line x1="' + x(a.today) + '" x2="' + x(a.today) + '" y1="14" y2="50" class="tline"/><circle cx="' + x(a.today) + '" cy="32" r="6.5" class="tdot"/>';
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
      svg += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="' + (now ? 6 : seven ? 5 : 3.5) + '" class="' + (now ? 'tdot' : seven ? 'sdot' : 'pdot') + '"><title>' + p.lab + ': ' + T1(p.v) + '</title></circle>';
      if (now || seven) svg += '<text x="' + X(i).toFixed(1) + '" y="' + (Y(p.v) - 9).toFixed(1) + '" text-anchor="middle" class="lbl strong">' + T(p.v) + '</text>';
      svg += '<text x="' + X(i).toFixed(1) + '" y="80" text-anchor="middle" class="lbl">' + p.lab + '</text>';
    });
    return svg + '</svg>';
  }

  function row(label, cls, r, c, adjusted) {
    if (!r) return '<li class="yr missing"><span class="y">' + esc(label) + '</span><span class="m">Data unavailable</span></li>';
    var d = L.describeCode(r.code, r.isDay);
    return '<li class="yr ' + cls + '"><span class="y">' + esc(label) + (adjusted ? '<i title="29 Feb used 28 Feb">*</i>' : '') + '</span>' +
      '<span class="ic" title="' + esc(d.text) + '">' + d.icon + '</span>' +
      '<span class="fl"><b>' + T(r.fl) + '</b><small>air ' + T(r.t) + '</small></span>' +
      '<span class="det">' + esc(d.text) + '<small>' + R(r.precip) + ' · ' + W(r.wind) + ' · ' + (r.cloud == null ? '–' : Math.round(r.cloud) + '%') + ' cloud</small></span>' +
      '<span class="sc"><b>' + Math.round(c.score) + '</b><span class="bar"><i style="width:' + Math.round(c.score) + '%"></i></span></span></li>';
  }

  function statLine(name, a) {
    var anom = a.anom;
    return '<li><span class="k">' + name + '</span><span class="v"><b>' + T(a.today) + '</b> vs normal ' + T(a.mean) + ' → <b>' + sdT(anom) + '</b>' +
      '<small>' + pctPhrase(a.pct, 'warmer than', 'colder than') + ' of similar hours · ' + (a.z >= 0 ? '+' : '−') + Math.abs(a.z).toFixed(1) + ' standard deviations (typical spread ±' + dT(a.sd) + ')</small></span></li>';
  }

  function weekLine(name, r, nowV) {
    var out = '';
    if (r.d7 != null) {
      out += '<li><span class="k">' + name + '</span><span class="v"><b>' + sdT(r.d7) + '</b> vs 7 days ago (' + T(nowV - r.d7) + ' → ' + T(nowV) + ')' +
        '<small>' + pctPhrase(r.pct7, 'Bigger rise than', 'Bigger fall than') + ' of past week-on-week changes at this date (usual change ' + sdT(r.drift7) + ').</small></span></li>';
    }
    if (r.d510 != null) {
      out += '<li><span class="k">' + (r.d7 != null ? '' : name) + '</span><span class="v"><b>' + sdT(r.d510) + '</b> vs the average of days 5–10 ago (' + T(r.mean510) + ')' +
        '<small>' + pctPhrase(r.pct510, 'Bigger rise than', 'Bigger fall than') + ' of past changes (usual ' + sdT(r.drift510) + ').</small></span></li>';
    }
    return out;
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
    $('hero').innerHTML =
      '<div class="ico">' + desc.icon + '</div>' +
      '<div class="big"><span class="lab">Air temperature</span><span class="num">' + T(c.temperature_2m) + '</span></div>' +
      '<div class="cond">' + esc(desc.text) + ' · feels like ' + T(c.apparent_temperature) + '</div>' +
      '<div class="chips"><span>💨 ' + W(c.wind_speed_10m) + '</span><span>💧 ' + (c.relative_humidity_2m == null ? '–' : Math.round(c.relative_humidity_2m) + '%') + '</span><span>☁️ ' + Math.round(c.cloud_cover) + '%</span><span>🌧️ ' + R(c.precipitation) + '</span></div>';

    var a = d.analysis, w = d.week;

    /* ---- Card 1: vs last 10 years ---- */
    if (!a || !a.ok) {
      $('vs10').className = 'card verdict t-normal';
      $('vs10').innerHTML = '<h2>Not enough history yet</h2><p class="sub">Need at least 5 of the last ' + YEARS + ' years; got ' + (a ? a.years : 0) + '. Tap ↻ to retry.</p>';
      $('band').innerHTML = '';
    } else {
      var lab = a.t.label;
      $('vs10').className = 'card verdict t-' + lab.key;
      var biasNote = a.bias && a.bias.applied && Math.abs(a.bias.t) >= 0.15
        ? '<p class="fine">Forecast model reads ' + dT(a.bias.t) + (a.bias.t > 0 ? ' warmer' : ' colder') + ' than the reanalysis used for history over the last ' + Math.round(a.bias.n / 24) + ' days, so today was adjusted by ' + sdT(-a.bias.t) + ' for a fair comparison.</p>'
        : '';
      $('vs10').innerHTML =
        '<h3>Versus the last 10 years · ' + d.day + '/' + d.month + ' around ' + when(d) + '</h3>' +
        '<div class="vh"><span class="arrow" aria-hidden="true">' + (a.t.z >= 0.5 ? '▲' : a.t.z <= -0.5 ? '▼' : '＝') + '</span><h2>' + esc(lab.text) + '</h2></div>' +
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
        '<div class="vh"><span class="arrow" aria-hidden="true">' + (l7.key.indexOf('warm') === 0 ? '▲' : l7.key.indexOf('cold') === 0 ? '▼' : '＝') + '</span><h2>' + esc(l7.text) + '</h2></div>' +
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
        '<div class="vh"><span class="arrow" aria-hidden="true">' + cf.verdict.arrow + '</span><h2>' + esc(cf.verdict.label) + '</h2></div>' +
        '<p class="sub">Score <b>' + Math.round(cf.score) + '</b> vs <b>' + Math.round(cf.mean) + '</b> usual for this date and hour (' + (cf.diff >= 0 ? '+' : '−') + Math.abs(cf.diff).toFixed(0) + '; ' + pctPhrase(cf.pct, 'more comfortable than', 'less comfortable than') + ' of similar hours).</p>' +
        '<ul class="why">' + bullets.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';
    } else { $('comfort').className = 'card'; $('comfort').innerHTML = ''; }

    /* ---- Card 4: year-by-year rows ---- */
    var html = row('Today', 'today', d.today, L.comfort(d.today));
    d.rows.forEach(function (r) { html += row(String(r.year), '', r.sample, r.sample ? L.comfort(r.sample) : null, r.adjusted); });
    $('years').innerHTML = html;
    $('updated').textContent = 'Updated ' + new Date(d.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- init ---------- */
  function init() {
    var u = sget('wx.units'); if (u === 'imperial' || u === 'metric') state.units = u;
    state.place = sget('wx.place');
    var last = sget('wx.last');
    if (last && last.v === DATA_VERSION && state.place && last.place && last.place.lat === state.place.lat && last.place.lon === state.place.lon) state.data = last;

    $('refresh').addEventListener('click', function () { refresh(); });
    $('units').addEventListener('click', function () { state.units = imp() ? 'metric' : 'imperial'; sset('wx.units', state.units); render(); });
    $('place-btn').addEventListener('click', function () { openPlaces(''); });
    $('close').addEventListener('click', closePlaces);
    $('gps').addEventListener('click', function () { useGPS(); });
    $('q').addEventListener('input', function (e) { clearTimeout(searchTimer); var v = e.target.value; searchTimer = setTimeout(function () { search(v); }, 300); });
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
