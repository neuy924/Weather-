/* Original pixel-art sprites, generated in code. No external assets.
   Characters: k outline, w white, g light grey, y yellow, o orange, b blue, c pale cyan, p pale moon, x = currentColor. '.' = empty. */
(function (root) {
  'use strict';

  function mk(w, h) { var g = [], y; for (y = 0; y < h; y++) g.push(new Array(w + 1).join('.').split('')); return g; }
  function put(g, x, y, ch) { if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = ch; }
  function get(g, x, y) { return (y >= 0 && y < g.length && x >= 0 && x < g[0].length) ? g[y][x] : '.'; }
  function disc(g, cx, cy, r, ch) {
    for (var y = 0; y < g.length; y++) for (var x = 0; x < g[0].length; x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) g[y][x] = ch;
    }
  }
  /* add a 1-pixel outline (4-neighbour) around every opaque pixel */
  function outline(g, ch) {
    var out = g.map(function (r) { return r.slice(); }), x, y;
    for (y = 0; y < g.length; y++) for (x = 0; x < g[0].length; x++) {
      if (g[y][x] !== '.') continue;
      if (get(g, x - 1, y) !== '.' || get(g, x + 1, y) !== '.' || get(g, x, y - 1) !== '.' || get(g, x, y + 1) !== '.') out[y][x] = ch || 'k';
    }
    return out;
  }
  function stamp(dst, src, dx, dy) {
    for (var y = 0; y < src.length; y++) for (var x = 0; x < src[0].length; x++) if (src[y][x] !== '.') put(dst, x + dx, y + dy, src[y][x]);
  }
  function fromRows(rows) { return rows.map(function (r) { return r.split(''); }); }

  /* ---- 16x16 weather layers ---- */
  function sun(cx, cy, r, rays) {
    var g = mk(16, 16), i, a, d, x, y;
    disc(g, cx, cy, r, 'y');
    for (y = 0; y < 16; y++) for (x = 0; x < 16; x++) { if (g[y][x] === 'y' && (x + 0.5 - cx) + (y + 0.5 - cy) > r * 0.55) g[y][x] = 'o'; }
    g = outline(g);
    if (rays) {
      for (i = 0; i < 8; i++) {
        a = i * Math.PI / 4; d = r + 2.6;
        x = Math.round(cx + Math.cos(a) * d - 0.5); y = Math.round(cy + Math.sin(a) * d - 0.5);
        put(g, x, y, 'y');
        if (i % 2 === 0) put(g, Math.round(cx + Math.cos(a) * (d + 1) - 0.5), Math.round(cy + Math.sin(a) * (d + 1) - 0.5), 'y');
      }
    }
    return g;
  }
  function moon(cx, cy) {
    var g = mk(16, 16), x, y;
    disc(g, cx, cy, 4.6, 'p');
    for (y = 0; y < 16; y++) for (x = 0; x < 16; x++) {
      var dx = x + 0.5 - (cx + 2.6), dy = y + 0.5 - (cy - 1.8);
      if (dx * dx + dy * dy <= 3.9 * 3.9) g[y][x] = '.';
    }
    g = outline(g);
    put(g, 12, 3, 'w'); put(g, 13, 8, 'w'); put(g, 11, 12, 'w');
    return g;
  }
  /* cloud made from discs, flat bottom at row `bot`; shaded bottom rows */
  function cloud(dx, dy, tone) {
    var g = mk(16, 16), x, y, bot = 12, body = tone || 'w';
    disc(g, 4.6, 8.8, 3.2, body); disc(g, 8.4, 6.4, 4.1, body); disc(g, 11.6, 9.2, 3.0, body);
    for (y = 9; y <= bot; y++) for (x = 3; x <= 13; x++) g[y][x] = body;
    for (y = bot + 1; y < 16; y++) for (x = 0; x < 16; x++) g[y][x] = '.';
    for (y = 0; y < 16; y++) for (x = 0; x < 16; x++) if (g[y][x] === body && y >= bot - 1) g[y][x] = (body === 'w' ? 'g' : 's');
    g = outline(g);
    var o = mk(16, 16); stamp(o, g, dx || 0, dy || 0); return o;
  }
  var BOLT = fromRows(['..yy', '.yy.', 'yyyy', '.yy.', '.y..', 'y...']);

  function drops(g, kind, y0) {
    var pts = [[3, 0], [7, 2], [11, 0]], i, x, y;
    for (i = 0; i < pts.length; i++) {
      x = pts[i][0]; y = y0 + pts[i][1];
      if (kind === 'snow') { put(g, x, y, 'w'); put(g, x - 1, y, 'c'); put(g, x + 1, y, 'c'); put(g, x, y - 1, 'c'); put(g, x, y + 1, 'c'); }
      else if (kind === 'drizzle') { put(g, x, y, 'b'); }
      else { put(g, x, y, 'c'); put(g, x - 1, y + 1, 'b'); put(g, x - 1, y + 2, 'b'); }
    }
  }
  function fog() {
    var g = cloud(0, -4, 'g'), x, bars = [[1, 10, 12], [3, 12, 12], [0, 14, 10]], r;
    for (r = 0; r < bars.length; r++) for (x = bars[r][0]; x < bars[r][0] + bars[r][2]; x++) put(g, x, bars[r][1] + 0, 's');
    return g;
  }

  function weatherGrid(code, isDay) {
    var day = isDay !== 0, g = mk(16, 16), c;
    var sky = function () { return day ? sun(7.6, 7.6, 3.6, true) : moon(8, 8); };
    if (code === 0) return sky();
    if (code === 1) { stamp(g, sky(), 0, 0); return g; }
    if (code === 2) { stamp(g, day ? sun(5.6, 5.2, 3.0, true) : moon(5.5, 5.5), 0, 0); stamp(g, cloud(2, 3), 0, 0); return g; }
    if (code === 3) { stamp(g, cloud(0, 1, 'g'), 0, 0); return g; }
    if (code === 45 || code === 48) return fog();
    var rain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
    var snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    if (code >= 95) { stamp(g, cloud(0, -3, 'g'), 0, 0); stamp(g, outline(BOLT), 6, 9); return g; }
    if (rain || snow) {
      stamp(g, cloud(0, -3, code >= 63 || code === 65 || code === 81 || code === 82 ? 'g' : 'w'), 0, 0);
      drops(g, snow ? 'snow' : (code <= 55 ? 'drizzle' : 'rain'), 11);
      return g;
    }
    c = cloud(0, 1, 'g'); stamp(g, c, 0, 0); return g;
  }

  /* ---- small UI icons (variable size) ---- */
  var UI = {
    pin: fromRows(['..xxxx..', '.xxxxxx.', 'xxx..xxx', 'xxx..xxx', '.xxxxxx.', '..xxxx..', '...xx...', '...x....']),
    up: fromRows(['...xx...', '..xxxx..', '.xxxxxx.', 'xxxxxxxx', '..xxxx..', '..xxxx..', '..xxxx..']),
    down: fromRows(['..xxxx..', '..xxxx..', '..xxxx..', 'xxxxxxxx', '.xxxxxx.', '..xxxx..', '...xx...']),
    flat: fromRows(['xxxxxxxx', 'xxxxxxxx', '........', 'xxxxxxxx', 'xxxxxxxx']),
    drop: fromRows(['...x...', '...x...', '..xxx..', '..xxx..', '.xxxxx.', 'xxxxxxx', 'xxxxxxx', '.xxxxx.', '..xxx..']),
    flake: fromRows(['x..x..x', '.x.x.x.', '..xxx..', 'xxxxxxx', '..xxx..', '.x.x.x.', 'x..x..x']),
    wind: fromRows(['xxxxxxx..', '.........', '..xxxxxxx', '.........', 'xxxxx....']),
    close: fromRows(['xx....xx', 'xxx..xxx', '.xxxxxx.', '..xxxx..', '..xxxx..', '.xxxxxx.', 'xxx..xxx', 'xx....xx']),
    caret: fromRows(['xx...', 'xxxx.', 'xxxxx', 'xxxx.', 'xx...']),
    cloud: null, rain: null, hum: null
  };
  (function () {
    UI.refresh = fromRows(['.....xx....', '....xxxxx..', '..xxxxxxxx.', '.xx...xx...', '.x.........', '.x.......x.', '.x.......x.', '.x.......x.', '.xx.....xx.', '..xxx.xxx..', '....xxx....']);
    UI.cloud = (function () { var c = mk(12, 7); disc(c, 3.6, 4.2, 2.6, 'x'); disc(c, 6.6, 3.2, 3.2, 'x'); disc(c, 9.2, 4.6, 2.3, 'x'); var t = c.slice(0, 6); return t; })();
    UI.rain = (function () { var c = mk(12, 9); stamp(c, UI.cloud, 0, 0); [[2, 7], [5, 7], [8, 7]].forEach(function (p) { put(c, p[0], p[1], 'x'); put(c, p[0] - 1, p[1] + 1, 'x'); }); return c; })();
    UI.hum = UI.drop;
  })();

  function toSVG(g, px, cls, label) {
    var h = g.length, w = g[0].length, paths = {}, x, y, x0, ch, k;
    for (y = 0; y < h; y++) {
      x = 0;
      while (x < w) {
        ch = g[y][x];
        if (ch === '.') { x++; continue; }
        x0 = x; while (x < w && g[y][x] === ch) x++;
        (paths[ch] = paths[ch] || []).push('M' + x0 + ' ' + y + 'h' + (x - x0) + 'v1h-' + (x - x0) + 'z');
      }
    }
    var out = '<svg class="sp ' + (cls || '') + '" viewBox="0 0 ' + w + ' ' + h + '" width="' + (w * px) + '" height="' + (h * px) + '" shape-rendering="crispEdges" ' +
      (label ? 'role="img" aria-label="' + label + '"' : 'aria-hidden="true"') + '>';
    for (k in paths) out += '<path class="s-' + k + '" d="' + paths[k].join('') + '"/>';
    return out + '</svg>';
  }

  var api = {
    weather: function (code, isDay, px, label) { return toSVG(weatherGrid(code, isDay), px || 4, 'wsp', label); },
    ui: function (name, px) { return UI[name] ? toSVG(UI[name], px || 2, 'usp u-' + name) : ''; },
    _grid: weatherGrid, _ui: UI
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WXSprites = api;
})(typeof window !== 'undefined' ? window : globalThis);
