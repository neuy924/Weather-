(function () {
  'use strict';
  var L = window.WXLogic;
  var YEARS = 5;
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  var GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
  var REVERSE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
  var HOURLY = 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,cloud_cover,weather_code,is_day';
  var STALE_MS = 15 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var state = { place: null, units: 'metric', data: null, loading: false, lastFetch: 0 };

  /* ---------- storage (may throw in private mode) ---------- */
  function sget(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function sset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function imp() { return state.units === 'imperial'; }
  function T(c) { return c == null ? '–' : Math.round(imp() ? c * 1.8 + 32 : c) + '°'; }
  function dT(d) { return Math.abs(imp() ? d * 1.8 : d).toFixed(1) + '°'; }
  function W(k) { return k == null ? '–' : imp() ? Math.round(k * 0.621371) + ' mph' : Math.round(k) + ' km/h'; }
  function R(mm) {
    if (mm == null) return '–';
    if (mm < 0.1) return 'dry';
    return imp() ? (mm / 25.4).toFixed(2) + ' in' : mm.toFixed(1) + ' mm';
  }
  function fetchJSON(url, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms || 12000);
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
      latitude: p.lat, longitude: p.lon, timezone: 'auto', forecast_days: 1,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,cloud_cover,weather_code,is_day',
      hourly: HOURLY
    }));
  }

  function loadYear(p, target) {
    var key = 'hist:' + p.lat.toFixed(2) + ',' + p.lon.toFixed(2) + ':' + target.stamp;
    var cached = sget(key);
    if (cached && cached.sample) return Promise.resolve({ year: target.year, sample: cached.sample, adjusted: target.adjusted });
    return fetchJSON(ARCHIVE + '?' + qs({
      latitude: p.lat, longitude: p.lon, start_date: target.date, end_date: target.date, hourly: HOURLY, timezone: 'auto'
    })).then(function (j) {
      var s = L.pickHour(j.hourly, target.stamp);
      if (s) sset(key, { sample: s });
      return { year: target.year, sample: s, adjusted: target.adjusted };
    }).catch(function (e) {
      return { year: target.year, sample: null, adjusted: target.adjusted, error: String(e && e.message || e) };
    });
  }

  function refresh(opts) {
    opts = opts || {};
    var p = state.place;
    if (!p) return Promise.resolve();
    if (state.loading) { state.pending = true; return Promise.resolve(); }
    state.loading = true;
    $('refresh').classList.add('spin');
    if (!state.data) status('Loading weather…');
    return loadForecast(p).then(function (fc) {
      var cur = fc.current;
      var tg = L.pastTargets(cur.time, YEARS);
      var stamp = cur.time.slice(0, 13) + ':00';
      var todaySample = L.pickHour(fc.hourly, stamp);
      if (!todaySample) throw new Error('No hourly row for ' + stamp);
      return Promise.all(tg.targets.map(function (t) { return loadYear(p, t); })).then(function (hist) {
        var data = {
          fetchedAt: Date.now(), place: p, tz: fc.timezone, localTime: cur.time, month: tg.month, day: tg.day, hour: tg.hour,
          current: cur, today: todaySample, history: hist
        };
        state.data = data; state.lastFetch = Date.now();
        sset('wx.last', data);
        render();
        var failed = hist.filter(function (h) { return !h.sample; }).length;
        status(failed ? failed + ' of ' + YEARS + ' past years could not be loaded. Tap ↻ to retry.' : '', failed ? 'warn' : '');
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

  function useGPS(userInitiated) {
    if (!navigator.geolocation) { openPlaces('This browser has no location access. Search for a city instead.'); return; }
    status('Finding your location…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var p = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), name: null, mode: 'gps' };
      var prev = state.place;
      if (prev && prev.mode === 'gps' && Math.abs(prev.lat - p.lat) < 0.03 && Math.abs(prev.lon - p.lon) < 0.03) p.name = prev.name;
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

  function sentences(res, d) {
    var s = res.summary, out = [];
    var n = res.n;
    if (Math.abs(s.flDelta) < 0.5) out.push('Feels-like is about the same as the ' + n + '-year average of <b>' + T(s.flMean) + '</b>.');
    else out.push('Feels <b>' + dT(s.flDelta) + ' ' + (s.flDelta > 0 ? 'warmer' : 'colder') + '</b> than the ' + n + '-year average of ' + T(s.flMean) + ' (past range ' + T(s.flMin) + ' to ' + T(s.flMax) + ').');
    out.push('Warmer than ' + s.warmerThan + ' of ' + n + ' past years at this hour; more comfortable than ' + s.betterThan + ' of ' + n + '.');
    if (s.todayWet) out.push('It is wet at this hour; that was true in ' + s.wetYears + ' of ' + n + ' past years.');
    else out.push('It is dry at this hour; it was wet in ' + s.wetYears + ' of ' + n + ' past years.');
    if (s.driver) {
      var names = { temp: 'feels-like temperature', rain: 'rain', wind: 'wind', cloud: 'cloud cover' };
      var v = s.pts[s.driver];
      out.push('Biggest factor: <b>' + names[s.driver] + '</b> (' + (v > 0 ? 'helps by ' : 'hurts by ') + Math.abs(v).toFixed(0) + ' points).');
    }
    return out;
  }

  function bandChart(res) {
    var vals = res.rows.filter(function (r) { return r.sample; }).map(function (r) { return r.sample.fl; });
    var s = res.summary, today = res.today.sample.fl;
    var lo = Math.min(Math.min.apply(null, vals), today) - 2, hi = Math.max(Math.max.apply(null, vals), today) + 2;
    var x = function (v) { return 14 + (v - lo) / (hi - lo) * 272; };
    var svg = '<svg viewBox="0 0 300 62" role="img" aria-label="Feels-like today versus past years" class="band">';
    svg += '<line x1="14" x2="286" y1="30" y2="30" class="axis"/>';
    svg += '<rect x="' + x(s.flMin) + '" y="22" width="' + Math.max(2, x(s.flMax) - x(s.flMin)) + '" height="16" rx="8" class="range"/>';
    res.rows.forEach(function (r) { if (r.sample) svg += '<circle cx="' + x(r.sample.fl) + '" cy="30" r="4" class="pdot"><title>' + r.year + ': ' + T(r.sample.fl) + '</title></circle>'; });
    svg += '<line x1="' + x(today) + '" x2="' + x(today) + '" y1="14" y2="46" class="tline"/><circle cx="' + x(today) + '" cy="30" r="6.5" class="tdot"/>';
    svg += '<text x="' + x(today) + '" y="10" text-anchor="middle" class="lbl strong">Today ' + T(today) + '</text>';
    svg += '<text x="' + x(s.flMin) + '" y="58" text-anchor="middle" class="lbl">' + T(s.flMin) + '</text>';
    if (x(s.flMax) - x(s.flMin) > 30) svg += '<text x="' + x(s.flMax) + '" y="58" text-anchor="middle" class="lbl">' + T(s.flMax) + '</text>';
    return svg + '</svg>';
  }

  function row(label, cls, r, c, adjusted) {
    if (!r) return '<li class="yr missing"><span class="y">' + esc(label) + '</span><span class="m">Data unavailable</span></li>';
    var d = L.describeCode(r.code, r.isDay);
    return '<li class="yr ' + cls + '"><span class="y">' + esc(label) + (adjusted ? '<i title="29 Feb used 28 Feb">*</i>' : '') + '</span>' +
      '<span class="ic" title="' + esc(d.text) + '">' + d.icon + '</span>' +
      '<span class="fl"><b>' + T(r.fl) + '</b><small>actual ' + T(r.t) + '</small></span>' +
      '<span class="det">' + esc(d.text) + '<small>' + R(r.precip) + ' · ' + W(r.wind) + ' · ' + (r.cloud == null ? '–' : Math.round(r.cloud) + '%') + ' cloud</small></span>' +
      '<span class="sc"><b>' + Math.round(c.score) + '</b><span class="bar"><i style="width:' + Math.round(c.score) + '%"></i></span></span></li>';
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
      '<div class="big"><span class="lab">Feels like</span><span class="num">' + T(c.apparent_temperature) + '</span></div>' +
      '<div class="cond">' + esc(desc.text) + ' · actual ' + T(c.temperature_2m) + '</div>' +
      '<div class="chips"><span>💨 ' + W(c.wind_speed_10m) + '</span><span>💧 ' + (c.relative_humidity_2m == null ? '–' : Math.round(c.relative_humidity_2m) + '%') + '</span><span>☁️ ' + Math.round(c.cloud_cover) + '%</span><span>🌧️ ' + R(c.precipitation) + '</span></div>';

    var res = L.compare(d.today, d.history.map(function (h) { return { year: h.year, sample: h.sample }; }), 3);
    var adj = {}; d.history.forEach(function (h) { adj[h.year] = h.adjusted; });

    if (!res.ok) {
      $('verdict').className = 'card verdict v-typical';
      $('verdict').innerHTML = '<h2>Not enough history yet</h2><p class="sub">Need at least 3 past years to compare; got ' + res.n + '. Tap refresh to retry.</p>';
      $('band').innerHTML = '';
    } else {
      var s = res.summary;
      $('verdict').className = 'card verdict v-' + s.verdict.key;
      $('verdict').innerHTML =
        '<div class="vh"><span class="arrow" aria-hidden="true">' + s.verdict.arrow + '</span><h2>' + esc(s.verdict.label) + '</h2></div>' +
        '<p class="sub">Comfort score at ' + L.pad(d.hour) + ':00 is <b>' + Math.round(s.score) + '</b> vs <b>' + Math.round(s.avgScore) + '</b> on average for this date over the last ' + res.n + ' years (' + (s.diff >= 0 ? '+' : '−') + Math.abs(s.diff).toFixed(0) + ').</p>' +
        '<ul class="why">' + sentences(res, d).map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';
      $('band').innerHTML = bandChart(res);
    }

    var html = row('Today', 'today', d.today, res.today.comfort);
    res.rows.forEach(function (r) { html += row(String(r.year), '', r.sample, r.comfort, adj[r.year]); });
    $('years').innerHTML = html;
    $('updated').textContent = 'Updated ' + new Date(d.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- init ---------- */
  function init() {
    var u = sget('wx.units'); if (u === 'imperial' || u === 'metric') state.units = u;
    state.place = sget('wx.place');
    var last = sget('wx.last');
    if (last && state.place && last.place && last.place.lat === state.place.lat && last.place.lon === state.place.lon) state.data = last;

    $('refresh').addEventListener('click', function () { refresh(); });
    $('units').addEventListener('click', function () { state.units = imp() ? 'metric' : 'imperial'; sset('wx.units', state.units); render(); });
    $('place-btn').addEventListener('click', function () { openPlaces(''); });
    $('close').addEventListener('click', closePlaces);
    $('gps').addEventListener('click', function () { useGPS(true); });
    $('q').addEventListener('input', function (e) { clearTimeout(searchTimer); var v = e.target.value; searchTimer = setTimeout(function () { search(v); }, 300); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.place && Date.now() - state.lastFetch > STALE_MS) {
        if (state.place.mode === 'gps') useGPS(false); else refresh();
      }
    });

    render();
    if (state.place) {
      if (state.place.mode === 'gps') useGPS(false); else refresh();
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
