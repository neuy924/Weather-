/* Pure logic: date maths, comfort scoring, comparison. No DOM, no network.
   Loaded by index.html (window.WXLogic) and by Node tests (module.exports). */
(function (root) {
  'use strict';

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var isLeap = function (y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; };

  /* WMO weather codes -> [emoji day, emoji night, text] */
  var WMO = {
    0: ['☀️', '🌙', 'Clear'], 1: ['🌤️', '🌙', 'Mostly clear'], 2: ['⛅', '☁️', 'Partly cloudy'], 3: ['☁️', '☁️', 'Overcast'],
    45: ['🌫️', '🌫️', 'Fog'], 48: ['🌫️', '🌫️', 'Freezing fog'],
    51: ['🌦️', '🌧️', 'Light drizzle'], 53: ['🌦️', '🌧️', 'Drizzle'], 55: ['🌧️', '🌧️', 'Heavy drizzle'],
    56: ['🌧️', '🌧️', 'Freezing drizzle'], 57: ['🌧️', '🌧️', 'Freezing drizzle'],
    61: ['🌦️', '🌧️', 'Light rain'], 63: ['🌧️', '🌧️', 'Rain'], 65: ['🌧️', '🌧️', 'Heavy rain'],
    66: ['🌧️', '🌧️', 'Freezing rain'], 67: ['🌧️', '🌧️', 'Freezing rain'],
    71: ['🌨️', '🌨️', 'Light snow'], 73: ['🌨️', '🌨️', 'Snow'], 75: ['❄️', '❄️', 'Heavy snow'], 77: ['🌨️', '🌨️', 'Snow grains'],
    80: ['🌦️', '🌧️', 'Light showers'], 81: ['🌧️', '🌧️', 'Showers'], 82: ['⛈️', '⛈️', 'Violent showers'],
    85: ['🌨️', '🌨️', 'Snow showers'], 86: ['🌨️', '🌨️', 'Heavy snow showers'],
    95: ['⛈️', '⛈️', 'Thunderstorm'], 96: ['⛈️', '⛈️', 'Thunderstorm, hail'], 99: ['⛈️', '⛈️', 'Severe thunderstorm, hail']
  };
  function describeCode(code, isDay) {
    var e = WMO[code];
    if (!e) return { icon: '🌡️', text: 'Unknown' };
    return { icon: isDay === 0 ? e[1] : e[0], text: e[2] };
  }

  /* localISO like "2026-11-24T17:15" (place-local time, as returned by Open-Meteo).
     Returns the same month-day and hour for each of the previous `years` years. */
  function pastTargets(localISO, years) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(localISO);
    if (!m) throw new Error('Bad time: ' + localISO);
    var y0 = +m[1], mm = +m[2], dd = +m[3], hh = +m[4];
    var out = [];
    for (var i = 1; i <= (years || 5); i++) {
      var y = y0 - i, d = dd, adjusted = false;
      if (mm === 2 && dd === 29 && !isLeap(y)) { d = 28; adjusted = true; }
      out.push({ year: y, date: y + '-' + pad(mm) + '-' + pad(d), hour: hh, stamp: y + '-' + pad(mm) + '-' + pad(d) + 'T' + pad(hh) + ':00', adjusted: adjusted });
    }
    return { y0: y0, month: mm, day: dd, hour: hh, targets: out };
  }

  /* Pick one hourly row from an Open-Meteo hourly block by exact local timestamp. */
  function pickHour(hourly, stamp) {
    if (!hourly || !hourly.time) return null;
    var i = hourly.time.indexOf(stamp);
    if (i < 0) return null;
    var g = function (k) { var a = hourly[k]; return a && a[i] != null ? a[i] : null; };
    var s = {
      fl: g('apparent_temperature'), t: g('temperature_2m'), precip: g('precipitation'),
      wind: g('wind_speed_10m'), cloud: g('cloud_cover'), code: g('weather_code'), isDay: g('is_day')
    };
    return s.fl == null ? null : s;
  }

  /* ---- Comfort score (0-100, higher = more pleasant) ----
     Penalties are in points, so each factor's contribution can be shown.
     Wind is only penalised when strong, because "feels like" already includes wind chill. */
  function tempPenalty(fl) {
    if (fl < 18) return Math.min(70, (18 - fl) * 4);
    if (fl > 24) return Math.min(70, (fl - 24) * 6);
    return 0;
  }
  function rainPenalty(p) { return p != null && p >= 0.1 ? Math.min(25, 10 + 10 * p) : 0; }
  function windPenalty(w) { return w != null && w > 25 ? Math.min(15, (w - 25) * 0.75) : 0; }
  function cloudPenalty(c, isDay) { return c != null && isDay !== 0 ? 8 * c / 100 : 0; }

  function comfort(s) {
    var pen = {
      temp: tempPenalty(s.fl),
      rain: rainPenalty(s.precip),
      wind: windPenalty(s.wind),
      cloud: cloudPenalty(s.cloud, s.isDay)
    };
    var total = pen.temp + pen.rain + pen.wind + pen.cloud;
    return { score: Math.max(0, Math.min(100, 100 - total)), pen: pen };
  }

  var mean = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };

  function verdictFor(diff) {
    if (diff >= 15) return { key: 'much-better', label: 'Much better than usual', arrow: '▲▲' };
    if (diff >= 5) return { key: 'better', label: 'Better than usual', arrow: '▲' };
    if (diff > -5) return { key: 'typical', label: 'About typical', arrow: '＝' };
    if (diff > -15) return { key: 'worse', label: 'Worse than usual', arrow: '▼' };
    return { key: 'much-worse', label: 'Much worse than usual', arrow: '▼▼' };
  }

  /* today: sample; history: [{year, sample|null}] */
  function compare(today, history, minYears) {
    minYears = minYears || 3;
    var tc = comfort(today);
    var rows = history.map(function (h) {
      if (!h.sample) return { year: h.year, sample: null, comfort: null };
      return { year: h.year, sample: h.sample, comfort: comfort(h.sample) };
    });
    var valid = rows.filter(function (r) { return r.comfort; });
    var res = { today: { sample: today, comfort: tc }, rows: rows, n: valid.length, ok: valid.length >= minYears };
    if (!res.ok) return res;

    var avgScore = mean(valid.map(function (r) { return r.comfort.score; }));
    var diff = tc.score - avgScore;
    var avgPen = {};
    ['temp', 'rain', 'wind', 'cloud'].forEach(function (k) {
      avgPen[k] = mean(valid.map(function (r) { return r.comfort.pen[k]; }));
    });
    /* positive = today is helped by this factor relative to the average year */
    var pts = {};
    Object.keys(avgPen).forEach(function (k) { pts[k] = avgPen[k] - tc.pen[k]; });
    var driver = Object.keys(pts).sort(function (a, b) { return Math.abs(pts[b]) - Math.abs(pts[a]); })[0];

    var fls = valid.map(function (r) { return r.sample.fl; });
    var flMean = mean(fls);
    var wets = valid.filter(function (r) { return r.sample.precip != null && r.sample.precip >= 0.1; }).length;
    var windVals = valid.filter(function (r) { return r.sample.wind != null; }).map(function (r) { return r.sample.wind; });
    var cloudVals = valid.filter(function (r) { return r.sample.cloud != null; }).map(function (r) { return r.sample.cloud; });

    res.summary = {
      verdict: verdictFor(diff),
      score: tc.score, avgScore: avgScore, diff: diff,
      betterThan: valid.filter(function (r) { return tc.score > r.comfort.score; }).length,
      warmerThan: valid.filter(function (r) { return today.fl > r.sample.fl; }).length,
      pts: pts, driver: Math.abs(pts[driver]) >= 2 ? driver : null,
      fl: today.fl, flMean: flMean, flDelta: today.fl - flMean,
      flMin: Math.min.apply(null, fls), flMax: Math.max.apply(null, fls),
      wetYears: wets, todayWet: today.precip != null && today.precip >= 0.1,
      windMean: windVals.length ? mean(windVals) : null,
      cloudMean: cloudVals.length ? mean(cloudVals) : null
    };
    return res;
  }

  /* =====================================================================
     Baseline anomaly engine (10-year pool, seasonal + diurnal adjustment)
     ===================================================================== */

  /* Calendar arithmetic only: stamps are place-local, so Date.UTC is used purely as a day/hour counter. */
  function ymd(y, m, d, k) {
    var t = new Date(Date.UTC(y, m - 1, d + k));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  function stampAt(y, m, d, h, k) {
    var t = new Date(Date.UTC(y, m - 1, d + k, h));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + 'T' + pad(t.getUTCHours()) + ':00';
  }

  /* Fast exact-stamp lookup into an Open-Meteo hourly block. */
  function makePicker(hourly) {
    var idx = {};
    if (hourly && hourly.time) for (var i = 0; i < hourly.time.length; i++) idx[hourly.time[i]] = i;
    return function (stamp) {
      var i = idx[stamp];
      if (i == null) return null;
      var g = function (k) { var a = hourly[k]; return a && a[i] != null ? a[i] : null; };
      var s = { fl: g('apparent_temperature'), t: g('temperature_2m'), precip: g('precipitation'),
        wind: g('wind_speed_10m'), cloud: g('cloud_cover'), code: g('weather_code'), isDay: g('is_day') };
      return s.fl == null || s.t == null ? null : s;
    };
  }

  var K_RANGE = 7;           /* +/- days around the target date */
  var J_RANGE = 1;           /* +/- hours around the target hour */
  var LAGS = [5, 6, 7, 8, 9, 10];
  var MAX_LAG = 10;

  /* Dates to request for one past year's window: enough for the +/-7 d pool plus 10-day lags. */
  function windowRange(y, m, d) { return { start: ymd(y, m, d, -(K_RANGE + MAX_LAG)), end: ymd(y, m, d, K_RANGE) }; }

  /* Reduce one year's hourly window to a compact pack.
     s:   samples at (k days, j hours) around the target
     d7:  value minus same hour 7 days earlier
     d510: value minus mean of the same hour 5..10 days earlier */
  function buildPack(hourly, y, m, d, h) {
    var pick = makePicker(hourly);
    var pack = { exact: pick(stampAt(y, m, d, h, 0)), s: [], d7: [], d510: [] };
    for (var k = -K_RANGE; k <= K_RANGE; k++) {
      for (var j = -J_RANGE; j <= J_RANGE; j++) {
        var v = pick(stampAt(y, m, d, h + j, k));
        if (!v) continue;
        pack.s.push({ k: k, j: j, t: v.t, fl: v.fl, precip: v.precip, wind: v.wind, cloud: v.cloud, isDay: v.isDay });
        var p7 = pick(stampAt(y, m, d, h + j, k - 7));
        if (p7) pack.d7.push({ k: k, j: j, dt: v.t - p7.t, dfl: v.fl - p7.fl });
        var st = 0, sf = 0, n = 0;
        for (var li = 0; li < LAGS.length; li++) {
          var pl = pick(stampAt(y, m, d, h + j, k - LAGS[li]));
          if (pl) { st += pl.t; sf += pl.fl; n++; }
        }
        if (n >= 4) pack.d510.push({ k: k, j: j, dt: v.t - st / n, dfl: v.fl - sf / n });
      }
    }
    return pack;
  }

  /* Least squares v = a + b*k + c*j (b: per day, c: per hour). */
  function ols(rows) {
    var n = rows.length;
    if (n < 10) return { a: n ? mean(rows.map(function (r) { return r[2]; })) : 0, b: 0, c: 0 };
    var sk = 0, sj = 0, skk = 0, sjj = 0, skj = 0, sv = 0, skv = 0, sjv = 0;
    rows.forEach(function (r) {
      var k = r[0], j = r[1], v = r[2];
      sk += k; sj += j; skk += k * k; sjj += j * j; skj += k * j; sv += v; skv += k * v; sjv += j * v;
    });
    var A = [[n, sk, sj, sv], [sk, skk, skj, skv], [sj, skj, sjj, sjv]];
    for (var i = 0; i < 3; i++) {
      var p = i;
      for (var r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      var tmp = A[i]; A[i] = A[p]; A[p] = tmp;
      if (Math.abs(A[i][i]) < 1e-9) return { a: sv / n, b: 0, c: 0 };
      for (var r2 = i + 1; r2 < 3; r2++) {
        var f = A[r2][i] / A[i][i];
        for (var cc = i; cc < 4; cc++) A[r2][cc] -= f * A[i][cc];
      }
    }
    var c3 = A[2][3] / A[2][2];
    var b2 = (A[1][3] - A[1][2] * c3) / A[1][1];
    var a1 = (A[0][3] - A[0][1] * b2 - A[0][2] * c3) / A[0][0];
    return { a: a1, b: b2, c: c3 };
  }

  /* Distribution summary and where x sits in it. */
  function dist(vals, x) {
    var n = vals.length;
    if (!n) return null;
    var m = mean(vals);
    var sd = n > 1 ? Math.sqrt(vals.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (n - 1)) : 0;
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var q = function (pp) { var i = (n - 1) * pp, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
    var below = 0, eq = 0;
    vals.forEach(function (v) { if (v < x) below++; else if (v === x) eq++; });
    return { n: n, mean: m, sd: sd, p10: q(0.1), p50: q(0.5), p90: q(0.9), pct: (below + eq / 2) / n * 100, z: sd > 0 ? (x - m) / sd : 0 };
  }

  function anomalyLabel(z) {
    var a = Math.abs(z), warm = z > 0;
    if (a < 0.5) return { key: 'normal', text: 'About normal' };
    if (a < 1) return { key: warm ? 'warm1' : 'cold1', text: warm ? 'Slightly warmer than normal' : 'Slightly colder than normal' };
    if (a < 2) return { key: warm ? 'warm2' : 'cold2', text: warm ? 'Warmer than normal' : 'Colder than normal' };
    return { key: warm ? 'warm3' : 'cold3', text: warm ? 'Unusually warm' : 'Unusually cold' };
  }
  function comfortLabel(z) {
    var a = Math.abs(z), good = z > 0;
    if (a < 0.5) return { key: 'typical', label: 'About typical', arrow: '＝' };
    if (a < 1) return good ? { key: 'better', label: 'Slightly better than usual', arrow: '▲' } : { key: 'worse', label: 'Slightly worse than usual', arrow: '▼' };
    if (a < 2) return good ? { key: 'better', label: 'Better than usual', arrow: '▲' } : { key: 'worse', label: 'Worse than usual', arrow: '▼' };
    return good ? { key: 'much-better', label: 'Much better than usual', arrow: '▲▲' } : { key: 'much-worse', label: 'Much worse than usual', arrow: '▼▼' };
  }

  /* Offset between forecast-model values and ERA5 over the days where both exist. */
  function biasFrom(fcHourly, arHourly, minPairs) {
    var pick = makePicker(fcHourly), dt = [], dfl = [];
    if (arHourly && arHourly.time) {
      var ar = makePicker(arHourly);
      arHourly.time.forEach(function (st) {
        var a = ar(st), f = pick(st);
        if (a && f) { dt.push(f.t - a.t); dfl.push(f.fl - a.fl); }
      });
    }
    if (dt.length < (minPairs || 24)) return { t: 0, fl: 0, n: dt.length, applied: false };
    return { t: mean(dt), fl: mean(dfl), n: dt.length, applied: true };
  }

  /* packs: array of per-year packs (null for failed years). today: sample from the forecast model. bias: from biasFrom. */
  function analyze(packs, today, bias) {
    bias = bias || { t: 0, fl: 0 };
    var pool = [], years = 0;
    packs.forEach(function (p) { if (p && p.s && p.s.length) { years++; p.s.forEach(function (x) { pool.push(x); }); } });
    if (pool.length < 60 || years < 5) return { ok: false, n: pool.length, years: years };
    var out = { ok: true, n: pool.length, years: years, bias: bias }, fit = {};
    ['t', 'fl'].forEach(function (key) {
      var rows = pool.filter(function (x) { return x[key] != null; }).map(function (x) { return [x.k, x.j, x[key]]; });
      var m = ols(rows);
      var vals = rows.map(function (r) { return r[2] - m.b * r[0] - m.c * r[1]; });
      var x = today[key] - (bias[key] || 0);
      var d = dist(vals, x);
      d.today = x; d.raw = today[key]; d.anom = x - d.mean; d.slopeDay = m.b; d.slopeHour = m.c; d.label = anomalyLabel(d.z);
      out[key] = d; fit[key] = m;
    });
    /* comfort of today vs the same pool (feels-like adjusted to the target date/hour) */
    var cm = fit.fl;
    var cs = pool.map(function (x) {
      return comfort({ fl: x.fl - cm.b * x.k - cm.c * x.j, precip: x.precip, wind: x.wind, cloud: x.cloud, isDay: x.isDay });
    });
    var tc = comfort({ fl: out.fl.today, precip: today.precip, wind: today.wind, cloud: today.cloud, isDay: today.isDay });
    var dc = dist(cs.map(function (c) { return c.score; }), tc.score);
    var pts = {};
    ['temp', 'rain', 'wind', 'cloud'].forEach(function (k) { pts[k] = mean(cs.map(function (c) { return c.pen[k]; })) - tc.pen[k]; });
    var driver = Object.keys(pts).sort(function (a, b) { return Math.abs(pts[b]) - Math.abs(pts[a]); })[0];
    var wet = pool.filter(function (x) { return x.precip != null && x.precip >= 0.1; }).length / pool.length;
    out.comfort = {
      score: tc.score, mean: dc.mean, sd: dc.sd, z: dc.z, pct: dc.pct, diff: tc.score - dc.mean, verdict: comfortLabel(dc.z),
      pts: pts, driver: Math.abs(pts[driver]) >= 2 ? driver : null, wetShare: wet,
      todayWet: today.precip != null && today.precip >= 0.1
    };
    return out;
  }

  /* lags: { 5: {t, fl}|null, ..., 10: ... } from the forecast model's recent past. today: {t, fl}. */
  function weekCompare(packs, today, lags) {
    var out = { ok: true };
    ['t', 'fl'].forEach(function (key) {
      var pool7 = [], pool510 = [];
      packs.forEach(function (p) {
        if (!p) return;
        p.d7.forEach(function (x) { pool7.push(x['d' + key]); });
        p.d510.forEach(function (x) { pool510.push(x['d' + key]); });
      });
      var r = { series: LAGS.map(function (L) { return { lag: L, v: lags[L] ? lags[L][key] : null }; }) };
      var l7 = lags[7] ? lags[7][key] : null;
      if (l7 != null && pool7.length >= 30) {
        var d7 = dist(pool7, today[key] - l7);
        r.d7 = today[key] - l7; r.pct7 = d7.pct; r.sd7 = d7.sd; r.drift7 = d7.p50; r.n7 = d7.n; r.label7 = changeLabel(r.d7, d7.sd);
      }
      var vals = r.series.filter(function (s) { return s.v != null; }).map(function (s) { return s.v; });
      if (vals.length >= 4 && pool510.length >= 30) {
        var m = mean(vals), d510 = dist(pool510, today[key] - m);
        r.mean510 = m; r.d510 = today[key] - m; r.pct510 = d510.pct; r.sd510 = d510.sd; r.drift510 = d510.p50; r.label510 = changeLabel(r.d510, d510.sd);
      }
      out[key] = r;
    });
    return out;
  }
  function changeLabel(delta, sd) {
    var z = sd > 0 ? delta / sd : 0, a = Math.abs(z), warm = z > 0;
    if (a < 0.5) return { key: 'normal', text: 'About the same as a week ago' };
    if (a < 1) return { key: warm ? 'warm1' : 'cold1', text: warm ? 'Slightly warmer than a week ago' : 'Slightly colder than a week ago' };
    if (a < 2) return { key: warm ? 'warm2' : 'cold2', text: warm ? 'Warmer than a week ago' : 'Colder than a week ago' };
    return { key: warm ? 'warm3' : 'cold3', text: warm ? 'Much warmer than a week ago' : 'Much colder than a week ago' };
  }

  var api = {
    pad: pad, isLeap: isLeap, describeCode: describeCode, pastTargets: pastTargets, pickHour: pickHour,
    tempPenalty: tempPenalty, rainPenalty: rainPenalty, windPenalty: windPenalty, cloudPenalty: cloudPenalty,
    comfort: comfort, verdictFor: verdictFor, compare: compare,
    ymd: ymd, stampAt: stampAt, makePicker: makePicker, windowRange: windowRange, buildPack: buildPack,
    ols: ols, dist: dist, anomalyLabel: anomalyLabel, comfortLabel: comfortLabel, biasFrom: biasFrom,
    analyze: analyze, weekCompare: weekCompare, changeLabel: changeLabel, LAGS: LAGS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WXLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
