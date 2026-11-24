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

  var api = {
    pad: pad, isLeap: isLeap, describeCode: describeCode, pastTargets: pastTargets, pickHour: pickHour,
    tempPenalty: tempPenalty, rainPenalty: rainPenalty, windPenalty: windPenalty, cloudPenalty: cloudPenalty,
    comfort: comfort, verdictFor: verdictFor, compare: compare
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WXLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
