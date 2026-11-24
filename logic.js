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
        wind: g('wind_speed_10m'), cloud: g('cloud_cover'), code: g('weather_code'), isDay: g('is_day'),
        gust: g('wind_gusts_10m'), dew: g('dew_point_2m'), rh: g('relative_humidity_2m'), vis: g('visibility'), pop: g('precipitation_probability') };
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
  function analyze(packs, today, bias, opts) {
    bias = bias || { t: 0, fl: 0 };
    var shift = (opts && opts.flShift) || 0;   /* personal feels-like adjustment from calibration (deg C) */
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
      return comfort({ fl: x.fl - cm.b * x.k - cm.c * x.j + shift, precip: x.precip, wind: x.wind, cloud: x.cloud, isDay: x.isDay });
    });
    var tc = comfort({ fl: out.fl.today + shift, precip: today.precip, wind: today.wind, cloud: today.cloud, isDay: today.isDay });
    var dc = dist(cs.map(function (c) { return c.score; }), tc.score);
    var pts = {};
    ['temp', 'rain', 'wind', 'cloud'].forEach(function (k) { pts[k] = mean(cs.map(function (c) { return c.pen[k]; })) - tc.pen[k]; });
    var driver = Object.keys(pts).sort(function (a, b) { return Math.abs(pts[b]) - Math.abs(pts[a]); })[0];
    var wet = pool.filter(function (x) { return x.precip != null && x.precip >= 0.1; }).length / pool.length;
    out.comfort = {
      score: tc.score, mean: dc.mean, sd: dc.sd, z: dc.z, pct: dc.pct, diff: tc.score - dc.mean, verdict: comfortLabel(dc.z),
      pts: pts, driver: Math.abs(pts[driver]) >= 2 ? driver : null, wetShare: wet,
      todayWet: today.precip != null && today.precip >= 0.1, shift: shift
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

  /* =====================================================================
     Nowcast: rain window, damp flag, frost/ice flag, what to wear (walking)
     All thresholds are judgement calls (see index.html "How it works"), not standards.
     ===================================================================== */
  var WET_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 71, 73, 75, 77, 85, 86, 95, 96, 99];
  var DAMP_CODES = [45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
  var inList = function (list, v) { return v != null && list.indexOf(v) >= 0; };
  var sumOf = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };

  /* pick: makePicker(...) over the forecast hourly block (needs past_days and 2 forecast days).
     Past window = the 6 hourly totals ending at the current hour; next window = the 6 hours after it. */
  function nowcast(pick, y, m, d, h) {
    var at = function (o) { return pick(stampAt(y, m, d, h + o, 0)); };
    var cur = at(0);
    if (!cur) return null;
    var past = [], next = [], o;
    for (o = -5; o <= 0; o++) past.push(at(o));
    for (o = 1; o <= 6; o++) next.push(at(o));
    var pv = past.filter(function (s) { return s && s.precip != null; });
    var win = [cur].concat(next.filter(Boolean));       /* now + next 6 h */
    var nx = next.filter(function (s) { return s && s.precip != null; });
    var minFL = Infinity, minAt = null, minT = Infinity;
    win.forEach(function (s, i) {
      if (s.fl < minFL) { minFL = s.fl; minAt = i === 0 ? null : pad((h + next.indexOf(s) + 1) % 24) + ':00'; }
      if (s.t < minT) minT = s.t;
    });
    var gusts = win.filter(function (s) { return s.gust != null; }).map(function (s) { return s.gust; });
    var pops = next.filter(function (s) { return s && s.pop != null; }).map(function (s) { return s.pop; });
    return {
      cur: cur,
      past6mm: pv.length >= 4 ? sumOf(pv.map(function (s) { return s.precip; })) : null,
      next: {
        n: next.filter(Boolean).length,
        minFL: minFL, minAt: minAt, minT: minT,
        gustMax: gusts.length ? Math.max.apply(null, gusts) : null,
        precip: nx.length >= 4 ? sumOf(nx.map(function (s) { return s.precip; })) : null,
        popMax: pops.length ? Math.max.apply(null, pops) : null,
        wetSoon: win.some(function (s) { return inList(WET_CODES, s.code); }),
        night: win.some(function (s) { return s.isDay === 0; })
      }
    };
  }

  /* Damp: any of these. Thresholds are mine; the evidence on humidity alone in the cold is weak,
     so this is shown as a flag and is NOT weighted into the comfort score. */
  function dampFlag(cur, nc) {
    var r = [];
    if (inList(DAMP_CODES, cur.code)) r.push({ k: cur.code === 45 || cur.code === 48 ? 'fog' : 'wet', code: cur.code });
    if (nc.past6mm != null && nc.past6mm >= 0.2) r.push({ k: 'rain6', mm: nc.past6mm });
    if (cur.t < 10) {
      if (cur.dew != null && cur.t - cur.dew <= 1.5) r.push({ k: 'saturated', spread: cur.t - cur.dew, rh: cur.rh });
      else if (cur.dew == null && cur.rh != null && cur.rh >= 92) r.push({ k: 'saturated', spread: null, rh: cur.rh });
    }
    if (cur.vis != null && cur.vis < 1000) r.push({ k: 'vis', m: cur.vis });
    return { on: r.length > 0, reasons: r };
  }

  /* Frost/ice heuristic over now..+6 h. Surfaces can be colder than the 2 m air on clear, calm nights,
     so the effective surface temperature is taken as air minus 2 C then. Not a measurement. */
  function frostRisk(cur, nc) {
    var n = nc.next, minT = Math.min(cur.t, n.minT);
    var clearCalm = n.night && cur.cloud != null && cur.cloud <= 50 && (cur.wind == null || cur.wind <= 15);
    var wetSurface = (nc.past6mm != null && nc.past6mm >= 0.1) || (n.precip != null && n.precip >= 0.1) || n.wetSoon ||
      (cur.dew != null && cur.t - cur.dew <= 1.5 && minT < 3);
    var eff = minT - (clearCalm ? 2 : 0);
    var level = 'none';
    if (eff <= 0 && wetSurface) level = 'ice';
    else if (eff <= 0) level = 'frost';
    else if (eff <= 2) level = 'watch';
    return { level: level, minT: minT, eff: eff, clearCalm: clearCalm, wetSurface: wetSurface };
  }

  var WEAR_BANDS = [
    { max: -5, key: 'arctic', text: 'Heavy winter coat, hat, gloves and a scarf' },
    { max: 0, key: 'freezing', text: 'Heavy coat, hat and gloves' },
    { max: 5, key: 'cold', text: 'Warm coat, hat and gloves' },
    { max: 10, key: 'cool', text: 'Coat with a warm layer underneath' },
    { max: 15, key: 'mild', text: 'Light jacket or a jumper' },
    { max: 20, key: 'light', text: 'Long sleeves, with a thin layer for later' },
    { max: 25, key: 'warm', text: 'T-shirt weather; carry a light layer in case it cools' },
    { max: Infinity, key: 'hot', text: 'Light, breathable clothes and sun protection' }
  ];

  /* Walking pace, typical adult. Uses the coldest feels-like of now..+6 h, not just now. */
  function wear(cur, nc, damp, frost, shift) {
    shift = shift || 0;
    var n = nc.next, rawFL = Math.min(cur.fl, n.minFL), fl = rawFL + shift;
    var band = WEAR_BANDS.filter(function (b) { return fl <= b.max; })[0];
    var gust = n.gustMax != null ? n.gustMax : cur.gust;
    var rainLikely = (n.precip != null && n.precip >= 0.3) || (n.popMax != null && n.popMax >= 60 && n.precip != null && n.precip >= 0.1);
    var rainNow = cur.precip != null && cur.precip >= 0.1;
    var extras = [];
    if (rainLikely || rainNow) extras.push(gust != null && gust >= 40 ? 'Waterproof jacket with a hood; gusts are too strong for an umbrella' : 'Waterproof jacket or an umbrella');
    else if (damp.on) extras.push('A water-resistant outer layer helps in these damp conditions');
    if (gust != null && gust >= 50) extras.push('Very gusty: secure hat and hood');
    else if (gust != null && gust >= 35 && !(rainLikely || rainNow)) extras.push('Gusty, so a windproof layer');
    if (frost.level === 'ice') extras.push('Ice risk on paths and roads: grippy footwear and shorter steps');
    else if (frost.level === 'frost') extras.push('Frost likely: watch for slippery patches');
    else if (frost.level === 'watch') extras.push('Near-freezing surfaces possible: take care on shaded paths');
    return {
      minFL: rawFL, effFL: fl, shift: shift, minAt: n.minAt, drop: cur.fl - rawFL, band: band.key, base: band.text, extras: extras,
      rainLikely: rainLikely, gust: gust
    };
  }

  function nowReport(pick, y, m, d, h, shift) {
    var nc = nowcast(pick, y, m, d, h);
    if (!nc) return null;
    var damp = dampFlag(nc.cur, nc), frost = frostRisk(nc.cur, nc);
    return { nc: nc, damp: damp, frost: frost, wear: wear(nc.cur, nc, damp, frost, shift) };
  }


  /* =====================================================================
     Personal calibration from sensation votes (ASHRAE 7-point: -3 cold ... +3 hot)
     ===================================================================== */
  var SENS_PER_DEG = 0.25;   /* ASSUMPTION: scale steps per degree of feels-like at fixed clothing. Not measured for the user. */
  var MIN_AS = 10;           /* votes "dressed as suggested" before any adjustment is proposed */

  function seeded(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  function groupMeans(list, key) {
    var g = {};
    list.forEach(function (v) { var k = v[key] || 'unknown'; (g[k] = g[k] || []).push(v.vote); });
    return Object.keys(g).map(function (k) { return { key: k, n: g[k].length, mean: mean(g[k]) }; }).sort(function (a, b) { return b.n - a.n; });
  }

  /* votes: [{vote (-3..3), act, band, shift, snap:{fl,...}, ...}]. All valid votes count; clothing is not recorded. Votes are ordered categories, so the mean is a rough summary. */
  function calibrate(votes, k) {
    k = k || SENS_PER_DEG;
    var valid = (votes || []).filter(function (v) { return v && typeof v.vote === 'number' && v.vote >= -3 && v.vote <= 3; });
    var out = { n: valid.length, k: k, ok: false, min: MIN_AS, byAct: groupMeans(valid, 'act') };
    if (valid.length < MIN_AS) return out;
    var vals = valid.map(function (v) { return v.vote; }), n = vals.length, m = mean(vals);
    var rnd = seeded(12345), means = [], b, i, s;
    for (b = 0; b < 400; b++) { s = 0; for (i = 0; i < n; i++) s += vals[Math.floor(rnd() * n)]; means.push(s / n); }
    means.sort(function (x, y) { return x - y; });
    out.ok = true; out.mean = m; out.p10 = means[40]; out.p90 = means[359];
    out.shift = Math.max(-4, Math.min(4, Math.round(m / k * 2) / 2));
    out.significant = (out.p10 > 0 || out.p90 < 0) && Math.abs(out.shift) >= 0.5;
    return out;
  }

  var CSV_COLS = ['ts_utc', 'local_time', 'place', 'lat', 'lon', 'activity', 'vote', 'feels_like', 'air_temp', 'wind_kmh', 'gust_kmh',
    'rain_6h_mm', 'rain_next6h_mm', 'dew_point', 'humidity', 'damp', 'frost', 'band', 'coldest_fl_next6h', 'shift_applied'];
  function votesToCSV(votes) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var rows = [CSV_COLS.join(',')];
    (votes || []).forEach(function (v) {
      var sn = v.snap || {}, pl = v.place || {};
      rows.push([v.ts, v.local, pl.name, pl.lat, pl.lon, v.act, v.vote, sn.fl, sn.t, sn.wind, sn.gust, sn.rain6, sn.rainNext6,
        sn.dew, sn.rh, sn.damp, sn.frost, v.band, sn.minFL, v.shift].map(q).join(','));
    });
    return rows.join('\n');
  }

  var api = {
    calibrate: calibrate, votesToCSV: votesToCSV, SENS_PER_DEG: SENS_PER_DEG, MIN_AS: MIN_AS,
    nowcast: nowcast, dampFlag: dampFlag, frostRisk: frostRisk, wear: wear, nowReport: nowReport,
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
