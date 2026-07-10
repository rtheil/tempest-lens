/* TempestLens - web UI client.
   Connects to the TempestLens server over a WebSocket, receives a full state
   snapshot whenever the data changes, and renders it. Values arrive as
   [value, unit, ...] lists, and sometimes as bare strings, so every read goes
   through the tolerant helpers. */

'use strict';

// ---- tiny DOM + data helpers ------------------------------------------- //
const $ = (id) => document.getElementById(id);
// Only touch the DOM when the value actually changes — avoids needless repaints
// (which flicker badly on the Pi's software renderer).
function set(id, text) { const el = $(id); if (el && el.textContent !== String(text)) el.textContent = String(text); }
function setEl(el, text) { if (el && el.textContent !== String(text)) el.textContent = String(text); }
function setHTML(id, html) { const el = $(id); if (el && el.innerHTML !== html) el.innerHTML = html; }
function toArr(v) { return Array.isArray(v) ? v : [v]; }

// Strip Kivy markup like [color=ff8837ff]…[/color] the console embeds in some
// text fields, leaving plain text.
function stripMarkup(s) { return (s == null ? '' : String(s)).replace(/\[\/?[^\]]*\]/g, '').trim(); }

// Feels-like value color, by static temperature bands (°F). Replaces the old
// "Warm/Hot" word with an at-a-glance visual cue on the number itself.
const FEELS_BANDS = [
  { min: 95, c: 'var(--crit)' },       // very hot
  { min: 86, c: 'var(--warn)' },       // hot
  { min: 72, c: 'var(--amber-soft)' }, // warm
  { min: 58, c: 'var(--good)' },       // comfortable
  { min: 45, c: 'var(--cyan)' },       // cool
  { min: -Infinity, c: 'var(--violet)' }, // cold
];
function feelsColor(f) {
  return (FEELS_BANDS.find((b) => f >= b.min) || FEELS_BANDS[FEELS_BANDS.length - 1]).c;
}

// Apply the light/dark theme. 'auto' follows the OS preference.
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// The "X°F warmer/colder than 24h ago" headline (shared by dashboard + temp layout).
function renderDiff(el, obs) {
  if (!el) return;
  const diffVal = part(obs.outTempDiff, 0, '--');
  const diffWord = stripMarkup(part(obs.outTempDiff, 2, '')).toLowerCase();
  if (diffVal === '--' || !diffWord || diffWord === 'same' || diffWord === '-') {
    el.innerHTML = diffVal === '--' ? '' : 'About the same as 24h ago';
    el.style.color = 'var(--muted)';
  } else {
    const arrow = /warm/.test(diffWord) ? '↑' : '↓';
    el.innerHTML = `${arrow} <b>${diffVal}${part(obs.outTempDiff, 1, '')}</b> ${diffWord} than 24h ago`;
    el.style.color = /warm/.test(diffWord) ? 'var(--amber-soft)' : 'var(--cyan)';
  }
}

// Color a "Feels like" line by the temperature band of the value.
function applyFeelsColor(el, obs) {
  const v = parseFloat(part(obs.FeelsLike, 0, 'NaN'));
  if (!el || isNaN(v)) return;
  const f = /c/i.test(part(obs.FeelsLike, 1, '')) ? v * 9 / 5 + 32 : v;
  el.style.color = feelsColor(f);
}

// Shared "Outdoor Temperature" pane. Mounted twice — in the dashboard tile
// (5-day) and the full-screen Temperature layout (10-day, sized up via
// .tp-large). One definition, so the two can never drift apart.
// Raindrop glyph, shared by the forecast strip and the TODAY card.
const FC_DROP = '<svg class="fc-drop" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z" fill="currentColor"/></svg>';

const TEMP_PANE_HTML =
  '<div class="hero-top"><div>'
  + '<div class="tile-head"><span class="tile-accent" style="background:var(--amber)"></span><span class="tile-label">Outdoor Temperature</span></div>'
  + '<div class="temp-row">'
  + '<div class="temp-left">'
  + '<div class="temp-main"><span class="temp-val tp-temp">--</span></div>'
  + '<div class="temp-diff tp-diff">&mdash;</div>'
  + '<span class="feels tp-feels">Feels like <b class="tp-feelsval">--</b></span>'
  + '</div>'
  // TODAY forecast card (top-right): reads clearly as forecast, not observed.
  + '<div class="today-fc">'
  + '<div class="tfc-dow">Today</div>'
  + '<div class="tfc-body">'
  + '<div class="tfc-icon tp-todayicon"></div>'
  + '<div class="tfc-temps"><span class="fc-hi tp-todayhi">--</span><span class="fc-lo tp-todaylo">--</span></div>'
  + '</div>'
  + '<div class="tfc-precip tp-todayprecip">--</div>'
  + '</div>'
  + '</div></div></div>'
  + '<div class="forecast5 tp-forecast"></div>'
  + '<div class="hero-bottom">'
  + '<div class="substats">'
  + '<div class="stat"><div class="k">Dew Point</div><div class="v tp-dew">--</div></div>'
  + '<div class="stat"><div class="k">Humidity</div><div class="v tp-hum">--</div></div>'
  + '<div class="stat"><div class="k">3-hr Trend</div><div class="v tp-trend">--</div></div>'
  + '</div>'
  // Observed high/low (with time) moved to the bottom-right, alongside the other
  // observed stats; laid out horizontally to match the substats row.
  + '<div class="hilo hilo-bottom">'
  + '<div class="hilo-col"><div class="k">High <span class="hilo-when tp-hightime"></span></div><div class="hilo-val hi tp-high">--</div></div>'
  + '<div class="hilo-col"><div class="k">Low <span class="hilo-when tp-lowtime"></span></div><div class="hilo-val lo tp-low">--</div></div>'
  + '</div>'
  + '</div>';

function temperaturePane(root, opts) {
  const forecastDays = (opts && opts.forecastDays) || 5;
  root.innerHTML = TEMP_PANE_HTML;
  const q = (sel) => root.querySelector(sel);
  const els = {
    temp: q('.tp-temp'), diff: q('.tp-diff'), feels: q('.tp-feels'), feelsval: q('.tp-feelsval'),
    high: q('.tp-high'), hightime: q('.tp-hightime'), low: q('.tp-low'), lowtime: q('.tp-lowtime'),
    dew: q('.tp-dew'), hum: q('.tp-hum'), trend: q('.tp-trend'), forecast: q('.tp-forecast'),
    todayicon: q('.tp-todayicon'), todayhi: q('.tp-todayhi'), todaylo: q('.tp-todaylo'), todayprecip: q('.tp-todayprecip'),
  };
  return {
    render(s) {
      const obs = s.obs || {};
      setEl(els.temp, vu(obs.outTemp));
      renderDiff(els.diff, obs);
      setEl(els.feelsval, vu(obs.FeelsLike));
      applyFeelsColor(els.feels, obs);
      setEl(els.high, vu(obs.outTempMax));
      const hiAt = part(obs.outTempMax, 2, '');
      setEl(els.hightime, hiAt ? 'at ' + hiAt : '');
      setEl(els.low, vu(obs.outTempMin));
      const loAt = part(obs.outTempMin, 2, '');
      setEl(els.lowtime, loAt ? 'at ' + loAt : '');
      setEl(els.dew, vu(obs.DewPoint));
      setEl(els.hum, vu(obs.Humidity));
      setEl(els.trend, vu(obs.outTempTrend));
      const fc0 = (Array.isArray(s.forecast) && s.forecast[0]) || {};
      if (els.todayicon) els.todayicon.innerHTML = weatherIconSVG(fc0.icon || fc0.conditions || '');
      setEl(els.todayhi, vu(fc0.high));
      setEl(els.todaylo, vu(fc0.low));
      if (els.todayprecip) els.todayprecip.innerHTML = FC_DROP + vu(fc0.precip, '0%');
      renderForecast(els.forecast, s.forecast, forecastDays);
    },
  };
}

// Pane instances (created in init, driven from render()).
let dashTempPane = null, layoutTempPane = null;

// Layouts, in swipe order. Adding a layout later = one more entry + its container.
const LAYOUTS = ['dashboard', 'temp'];
function currentLayout() { return displayPrefs.Layout || 'dashboard'; }
function applyLayout(layout) {
  if ($('gridLayout')) $('gridLayout').hidden = layout !== 'dashboard';
  if ($('tempLayout')) $('tempLayout').hidden = layout !== 'temp';
}
// Advance the layout by dir (+1 next / -1 prev), wrapping. Applied instantly and
// persisted so it sticks (and matches the Settings picker).
function cycleLayout(dir) {
  const cur = currentLayout();
  let i = LAYOUTS.indexOf(cur);
  if (i < 0) i = 0;
  const next = LAYOUTS[(i + dir + LAYOUTS.length) % LAYOUTS.length];
  if (next === cur) return;
  displayPrefs.Layout = next;
  applyLayout(next);
  postConfig('Display', 'Layout', next, false);
}

// Weather icons as inline SVG (no emoji font needed — the Pi has none, and
// SVG matches the rest of the vector UI). Small building blocks + a mapper.
const WI = {
  sun: '<circle cx="12" cy="12" r="5" fill="#ffb454"/><g stroke="#ffb454" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1.5" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.5" y2="12"/><line x1="4.2" y1="4.2" x2="6" y2="6"/><line x1="18" y1="18" x2="19.8" y2="19.8"/><line x1="4.2" y1="19.8" x2="6" y2="18"/><line x1="18" y1="6" x2="19.8" y2="4.2"/></g>',
  moon: '<path d="M15.5 2.5A9 9 0 1 0 21.5 16 7 7 0 0 1 15.5 2.5z" fill="#c9d2ff"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.5 4.5 0 0 0 7 18z" fill="#9aa7c2"/>',
  partly: '<circle cx="8" cy="8" r="3.3" fill="#ffb454"/><g stroke="#ffb454" stroke-width="1.6" stroke-linecap="round"><line x1="8" y1="1.6" x2="8" y2="3.2"/><line x1="1.6" y1="8" x2="3.2" y2="8"/><line x1="3.4" y1="3.4" x2="4.6" y2="4.6"/></g><path d="M9 19h8a3.6 3.6 0 0 0 .4-7.16A5.1 5.1 0 0 0 8 11.3 4 4 0 0 0 9 19z" fill="#9aa7c2"/>',
  partlyNight: '<path d="M9 6.5A5 5 0 1 0 13 12 4 4 0 0 1 9 6.5z" fill="#c9d2ff"/><path d="M9 19h8a3.6 3.6 0 0 0 .4-7.16A5.1 5.1 0 0 0 8 11.3 4 4 0 0 0 9 19z" fill="#9aa7c2"/>',
  rain: '<path d="M7 14.5h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 6 4.5 4.5 0 0 0 7 14.5z" fill="#9aa7c2"/><g stroke="#5ad1e6" stroke-width="2" stroke-linecap="round"><line x1="8" y1="17.5" x2="7" y2="21"/><line x1="12" y1="17.5" x2="11" y2="21"/><line x1="16" y1="17.5" x2="15" y2="21"/></g>',
  thunder: '<path d="M7 14h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 5.5 4.5 4.5 0 0 0 7 14z" fill="#9aa7c2"/><path d="M12.5 13.5l-4 5.5h2.7L9.5 23l5-6.5h-2.9z" fill="#ffb454"/>',
  snow: '<path d="M7 14h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 5.5 4.5 4.5 0 0 0 7 14z" fill="#9aa7c2"/><g fill="#dbe4ff"><circle cx="8" cy="18.5" r="1.3"/><circle cx="12" cy="20.5" r="1.3"/><circle cx="16" cy="18.5" r="1.3"/></g>',
  fog: '<path d="M7 12.5h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 4 4.5 4.5 0 0 0 7 12.5z" fill="#9aa7c2"/><g stroke="#9aa7c2" stroke-width="2" stroke-linecap="round"><line x1="4.5" y1="16.5" x2="19.5" y2="16.5"/><line x1="6.5" y1="20" x2="17.5" y2="20"/></g>',
};

function weatherIconSVG(token) {
  const t = (token || '').toLowerCase();
  let inner;
  if (t.includes('thunder')) inner = WI.thunder;
  else if (t.includes('snow') || t.includes('sleet') || t.includes('flurr')) inner = WI.snow;
  else if (t.includes('rain') || t.includes('drizzle') || t.includes('shower')) inner = WI.rain;
  else if (t.includes('fog') || t.includes('haze') || t.includes('mist')) inner = WI.fog;
  else if (t.includes('partly') || t.includes('mostly-clear')) inner = t.includes('night') ? WI.partlyNight : WI.partly;
  else if (t.includes('cloud') || t.includes('overcast')) inner = WI.cloud;
  else if (t.includes('clear') || t.includes('sunny') || t.includes('fair')) inner = t.includes('night') ? WI.moon : WI.sun;
  else inner = WI.cloud;
  return `<svg class="wicon" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

// Update the header weather icon only when the token changes (no per-render repaint).
function setWeatherIcon(token) {
  const el = $('condIcon');
  if (!el || el.dataset.icon === token) return;
  el.dataset.icon = token;
  el.innerHTML = weatherIconSVG(token);
}

// Forecast strip: weekday, icon, high (red), low (blue), precip. Rendered into
// element `el`, capped at `max` days (5 on the dashboard, 10 on the temp layout).
function renderForecast(el, list, max) {
  if (!el) return;
  // Skip index 0 (today — shown in the TODAY card); show the next `max` days.
  const days = (Array.isArray(list) ? list : []).slice(1, max + 1);
  const html = days.map(function (d) {
    const dow  = stripMarkup(d.day || '');
    const icon = weatherIconSVG(d.icon || d.conditions || '');
    const precip = FC_DROP + vu(d.precip, '0%');
    return '<div class="fc-day">'
      + '<div class="fc-dow">' + dow + '</div>'
      + '<div class="fc-icon">' + icon + '</div>'
      + '<div class="fc-temps"><span class="fc-hi">' + vu(d.high) + '</span>'
      + '<span class="fc-lo">' + vu(d.low) + '</span></div>'
      + '<div class="fc-precip">' + precip + '</div>'
      + '</div>';
  }).join('');
  // Match the column count to the days actually shown so the strip always fills
  // the width and stays centered (dropping "today" can leave fewer than `max`).
  const cols = days.length ? `repeat(${days.length}, 1fr)` : '';
  if (el.style.gridTemplateColumns !== cols) el.style.gridTemplateColumns = cols;
  if (el.innerHTML !== html) el.innerHTML = html;
}

// Draw the illuminated portion of the moon into #moonLit (viewBox 100x100).
function drawMoon(I, waxing) {
  const el = $('moonLit');
  if (!el) return;
  const cx = 50, cy = 50, r = 46;
  I = Math.max(0, Math.min(1, I));
  const t = Math.cos(Math.PI * I);          // I: 0→1 (new), .5→0 (quarter), 1→-1 (full)
  const rx = Math.abs(t) * r;
  const outer = waxing ? 1 : 0;             // lit limb: right if waxing, left if waning
  const inner = waxing ? (t > 0 ? 0 : 1) : (t > 0 ? 1 : 0);
  el.setAttribute('d', `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${outer} ${cx} ${cy + r} A ${rx} ${r} 0 0 ${inner} ${cx} ${cy - r} Z`);
}

// A "missing" value is null, or the console's dash placeholders ('-', '--'...)
function missing(x) {
  return x === null || x === undefined || (typeof x === 'string' && /^-*$/.test(x.trim()) && x.trim() !== '');
}
// Read element i of an observation, with a fallback for missing/empty values.
function part(v, i = 0, dflt = '--') {
  const x = toArr(v)[i];
  if (x === null || x === undefined || x === '' || x === '-') return dflt;
  return x;
}
// value + unit, e.g. "75.2" + "°F" -> "75.2°F"
function vu(v, dflt = '--') {
  const a = toArr(v);
  const val = a[0];
  if (val === null || val === undefined || val === '' || val === '-') return dflt;
  const unit = (a[1] === null || a[1] === undefined || a[1] === '-') ? '' : a[1];
  return `${val}${unit}`;
}

// ---- domain helpers ---------------------------------------------------- //
const CARDINALS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function cardinal(deg) {
  if (isNaN(deg)) return '';
  return CARDINALS[Math.round(((deg % 360) / 22.5)) % 16];
}

// Numeric degrees for the compass needle, whether WindDir is "248" or "WSW".
function windDegrees(w) {
  const v = part(w, 0, '');
  const n = parseFloat(v);
  if (!isNaN(n)) return n;
  const i = CARDINALS.indexOf(String(v).toUpperCase());
  return i >= 0 ? i * 22.5 : NaN;
}

// Barometer display range per unit (matches the console's own scale bands).
function baroRange(unit) {
  const u = (unit || '').trim().toLowerCase();
  if (u.includes('inhg')) return [27.5, 31.5, 2];
  if (u.includes('mmhg')) return [699, 800, 0];
  return [950, 1050, 0]; // hPa / mb
}

function uvLabel(v) {
  if (v <= 2) return ['Low', 'var(--good)'];
  if (v <= 5) return ['Moderate', 'var(--good)'];
  if (v <= 7) return ['High', 'var(--warn)'];
  if (v <= 10) return ['Very High', 'var(--crit)'];
  return ['Extreme', 'var(--violet)'];
}

// ---- render ------------------------------------------------------------ //
let baroLen = 0;

function render(s) {
  const obs = s.obs || {}, astro = s.astro || {}, met = s.met || {},
        sager = s.sager || {}, meta = s.meta || {}, upd = s.update || {};
  if (s.display) displayPrefs = s.display;
  applyTheme(displayPrefs.Theme || 'dark');
  if (typeof s.configured === 'boolean') {
    setupVisible(!s.configured);
    if (!s.configured) updateSetupRemote(s.access);
  }

  // Layout dispatch: show the active screen (dashboard vs temperature).
  applyLayout(currentLayout());
  // Both temperature panes are the same component; render both (hidden one is cheap).
  if (dashTempPane) dashTempPane.render(s);
  if (layoutTempPane) layoutTempPane.render(s);

  // Header
  if (meta.name) set('station', meta.name);
  const loc = [meta.latitude && meta.longitude ? `${(+meta.latitude).toFixed(3)}, ${(+meta.longitude).toFixed(3)}` : '',
               meta.elevation ? `${Math.round(+meta.elevation * 3.28084).toLocaleString()} ft` : ''].filter(Boolean).join(' · ');
  if (loc) set('place', loc);

  // (Temperature pane is rendered by the shared component — see layout dispatch above.)

  // Wind — WindDir arrives formatted per the Direction unit ("248"+"°" or "WSW"),
  // so display it as-is and derive the needle angle (reverse-mapping cardinals).
  set('windSpd', part(obs.WindSpd, 0));
  const wdir = toArr(obs.WindDir);
  const dirVal = part(obs.WindDir, 0, '');
  const dirSuffix = (wdir[1] && wdir[1] !== '-') ? wdir[1] : '';
  const dirDisplay = (dirVal && dirVal !== '--') ? dirVal + dirSuffix : '';
  set('windDir', `${part(obs.WindSpd, 1, '')} ${dirDisplay}`.trim());
  const deg = windDegrees(obs.WindDir);
  const needle = $('needle');
  if (needle && !isNaN(deg)) needle.setAttribute('transform', `rotate(${deg} 100 100)`);
  set('windGust', vu(obs.WindGust));
  set('avgWind', vu(obs.AvgWind));
  set('maxGust', vu(obs.MaxGust));

  // Pressure
  set('slp', part(obs.SLP, 0));
  set('slpUnit', part(obs.SLP, 1, ''));
  set('slpMin', vu(obs.SLPMin));
  set('slpMax', vu(obs.SLPMax));
  const trendVal = parseFloat(part(obs.SLPTrend, 0, 'NaN'));
  if ($('slpTrend')) {
    if (isNaN(trendVal)) { set('slpTrend', ''); }
    else {
      const arrow = trendVal > 0.02 ? '▲ Rising' : trendVal < -0.02 ? '▼ Falling' : '▬ Steady';
      set('slpTrend', `${arrow}`);
      $('slpTrend').style.color = trendVal > 0.02 ? 'var(--good)' : trendVal < -0.02 ? 'var(--crit)' : 'var(--muted)';
    }
  }
  const slpVal = parseFloat(part(obs.SLP, 0, 'NaN'));
  const [bmin, bmax, bdp] = baroRange(part(obs.SLP, 1, ''));
  set('baroMinLbl', bmin.toFixed(bdp)); set('baroMaxLbl', bmax.toFixed(bdp));
  const baro = $('baroArc');
  if (baro && baroLen && !isNaN(slpVal)) {
    const frac = Math.max(0, Math.min(1, (slpVal - bmin) / (bmax - bmin)));
    baro.style.strokeDashoffset = baroLen * (1 - frac);
  }

  // Rainfall
  set('todayRain', vu(obs.TodayRain));
  set('rainRate', vu(obs.RainRate));
  set('yesterdayRain', vu(obs.YesterdayRain));
  set('monthRain', vu(obs.MonthRain));
  set('yearRain', vu(obs.YearRain));

  // Sun & UV
  const uv = parseFloat(part(obs.UVIndex, 0, 'NaN'));
  set('uvIndex', isNaN(uv) ? '--' : uv.toFixed(0));
  if (!isNaN(uv)) {
    const [lbl, col] = uvLabel(uv);
    set('uvLabel', `UV · ${lbl}`);
    if ($('uvLabel')) $('uvLabel').style.color = col;
    if ($('uvMarker')) $('uvMarker').style.left = `${Math.min(100, (uv / 11) * 100)}%`;
  }
  set('radiation', vu(obs.Radiation));
  set('peakSun', vu(obs.peakSun));
  set('sunrise', stripMarkup(part(astro.Sunrise, 1, '--')));
  set('sunset', stripMarkup(part(astro.Sunset, 1, '--')));

  // Lightning
  set('strikes3hr', part(obs.Strikes3hr, 0));
  const dt = toArr(obs.StrikeDeltaT);
  if (dt.length >= 4 && !missing(dt[0])) {
    set('strikeDeltaT', `${part(dt, 0)} ${part(dt, 1, '')} ago`);
  } else { set('strikeDeltaT', 'none'); }
  set('strikeDist', vu(obs.StrikeDist));
  set('strikesToday', part(obs.StrikesToday, 0));
  set('strikesMonth', part(obs.StrikesMonth, 0));

  // Header "now" summary (today's forecast at a glance)
  set('condText', stripMarkup(part(met.Conditions, 0, '—')));
  setWeatherIcon(part(met.Icon, 0, ''));
  set('condHi', vu(met.highTemp));
  set('condLo', vu(met.lowTemp));
  set('condPrecip', vu(met.PrecipPercnt));

  // Forecast narrative in the hero pane (Sager on the console; conditions text here)
  const forecast = stripMarkup(part(sager.Forecast, 0, ''));
  if (forecast && forecast !== '-') set('sager', forecast);

  // Moon
  const phaseText = stripMarkup(part(astro.Phase, 1, '—'));
  set('moonPhase', phaseText);
  const illum = parseFloat(part(astro.Phase, 2, 'NaN'));
  set('moonIllum', isNaN(illum) ? '--' : `${illum.toFixed(0)}%`);
  if (!isNaN(illum)) drawMoon(illum / 100, /wax|first|new/i.test(phaseText));
  set('moonrise', stripMarkup(part(astro.Moonrise, 1, '--')));
  set('moonset', stripMarkup(part(astro.Moonset, 1, '--')));
  set('fullMoon', stripMarkup(part(astro.FullMoon, 0, '--')));
  set('newMoon', stripMarkup(part(astro.NewMoon, 0, '--')));

  // Update notification badge (popover interactions wired in init)
  const badge = $('updateBadge');
  if (badge) {
    if (upd.available && upd.notify !== false) {
      badge.hidden = false;
      set('verCurrent', upd.current || '--');
      set('verLatest', upd.latest || '--');
      const notes = $('releaseNotes');
      if (notes) {
        const txt = cleanNotes(upd.notes);
        notes.textContent = txt;
        notes.hidden = !txt;
      }
    } else {
      badge.hidden = true;   // popover is closed by user interaction only, not render
    }
  }
}

// Tidy a GitHub release body for plain-text display in the popover: drop
// heading hashes, turn "- " / "* " bullets into "•", collapse blank runs.
function cleanNotes(md) {
  if (!md) return '';
  return String(md)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s*/, '').replace(/^\s*[-*]\s+/, '• '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Kick off a self-update: POST /api/update, then wait for the service to drop
// (it rebuilds and exits) and come back up, and reload onto the new build.
async function runUpdate() {
  const btn = $('updateRun'), st = $('updateStatus');
  if (!btn || btn.hidden) return;
  // Hide the button while updating so its label can't sit under the status.
  btn.hidden = true;
  st.hidden = false; st.className = 'update-status';
  st.innerHTML = '<span class="spinner"></span>Updating…';
  let res;
  try {
    res = await (await fetch('/api/update', { method: 'POST' })).json();
  } catch (err) {
    // Connection dropped mid-response — the server is restarting (success path).
    res = { ok: true };
  }
  if (!res.ok) {
    st.textContent = 'Update failed: ' + (res.error || 'unknown error') + '. Try again or update from the console.';
    st.classList.add('err');
    btn.hidden = false;
    return;
  }
  st.innerHTML = '<span class="spinner"></span>Installing &amp; restarting…';
  // Poll health: wait until the service goes down and comes back, then reload.
  const started = Date.now();
  let sawDown = false;
  const iv = setInterval(async () => {
    if (Date.now() - started > 150000) { clearInterval(iv); location.reload(); return; }
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) { if (sawDown) { clearInterval(iv); location.reload(); } }
      else sawDown = true;
    } catch (err) { sawDown = true; }
  }, 2500);
}

// ---- connection -------------------------------------------------------- //
let lastUpdate = 0, connected = false;

function setLive(state, text) {
  const el = $('live');
  if (el) el.dataset.state = state;
  set('liveText', text);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch (err) { return; }
  ws.onopen = () => { connected = true; setLive('ok', 'Live'); };
  ws.onmessage = (e) => {
    lastUpdate = Date.now();
    try { render(JSON.parse(e.data)); } catch (err) { console.error('render error', err); }
  };
  ws.onclose = () => { connected = false; setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}

// Polling fallback. Dormant when the WebSocket is connected (production on the
// Pi); keeps the UI live when only a plain HTTP server is available (the local
// dev-preview server, which has no WebSocket).
async function poll() {
  if (connected) return;
  try {
    const r = await fetch('/api/snapshot', { cache: 'no-store' });
    const s = await r.json();
    if (s && s.version !== undefined) { lastUpdate = Date.now(); render(s); setLive('ok', 'Live'); }
  } catch (err) {
    setLive('down', 'Offline');
  }
}
setInterval(poll, 4000);

// Flag stale data (connected but no fresh snapshot for a while)
setInterval(() => {
  if (Date.now() - lastUpdate > 15000) { if (connected) setLive('stale', 'Stale'); }
  else setLive('ok', 'Live');
}, 3000);

// Force an immediate snapshot fetch (used right after a settings change)
function refreshNow() {
  fetch('/api/snapshot', { cache: 'no-store' })
    .then(r => r.json())
    .then(s => { if (s && s.version !== undefined) { lastUpdate = Date.now(); render(s); } })
    .catch(() => {});
}

// ---- settings drawer ---------------------------------------------------- //
let settingsLoaded = false;

async function loadSettings() {
  const body = $('settingsBody');
  try {
    const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
    renderSettings(cfg);
    settingsLoaded = true;
  } catch (err) {
    if (body) body.innerHTML = '<p style="color:var(--muted);padding:16px 0">Settings are unavailable.</p>';
  }
}

function postConfig(section, key, value, reload) {
  fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section, key, value }),
  }).then(() => {
    setTimeout(refreshNow, 300);   // let the console apply the change, then refresh data
    if (reload) loadSettings();    // relabel/convert dependent fields (e.g. Feels-Like unit)
  }).catch(() => {});
}

function segControl(f) {
  const seg = document.createElement('div');
  seg.className = 'seg';
  (f.options || []).forEach(opt => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = (f.labels && f.labels[opt]) || opt;
    b.setAttribute('aria-pressed', String(opt === f.value));
    b.addEventListener('click', () => { if (opt !== f.value) postConfig(f.section, f.key, opt, true); });
    seg.appendChild(b);
  });
  return seg;
}

function toggleControl(f) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toggle';
  let on = f.value === '1' || f.value === 1 || f.value === true;
  btn.setAttribute('aria-pressed', String(on));
  btn.addEventListener('click', () => {
    on = !on;
    btn.setAttribute('aria-pressed', String(on));
    postConfig(f.section, f.key, on ? '1' : '0', false);
  });
  return btn;
}

function infoControl(f) {
  const span = document.createElement('span');
  span.className = 'set-info';
  span.textContent = f.value;
  return span;
}

function linkControl(f) {
  const a = document.createElement('a');
  a.className = 'set-link';
  a.href = f.value;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = f.label || f.value;
  return a;
}

function stepperControl(f) {
  const wrap = document.createElement('div');
  wrap.className = 'stepper';
  let v = parseInt(f.value, 10);
  if (isNaN(v)) v = 0;
  const val = document.createElement('span');
  val.className = 'val';
  const show = () => { val.textContent = v + (f.unit ? ` ${f.unit}` : ''); };
  show();
  let timer;
  const commit = () => { clearTimeout(timer); timer = setTimeout(() => postConfig(f.section, f.key, String(v), false), 400); };
  const minus = document.createElement('button');
  minus.type = 'button'; minus.textContent = '−';
  minus.addEventListener('click', () => { v -= 1; show(); commit(); });
  const plus = document.createElement('button');
  plus.type = 'button'; plus.textContent = '+';
  plus.addEventListener('click', () => { v += 1; show(); commit(); });
  wrap.append(minus, val, plus);
  return wrap;
}

function renderSettings(cfg) {
  const body = $('settingsBody');
  if (!body) return;
  body.innerHTML = '';
  (cfg.sections || []).forEach(sec => {
    const wrap = document.createElement('div');
    wrap.className = 'set-section';
    const h = document.createElement('h3');
    h.textContent = sec.title || sec.name;
    wrap.appendChild(h);
    if (sec.desc) {
      const d = document.createElement('div');
      d.className = 'sec-desc';
      d.textContent = sec.desc;
      wrap.appendChild(d);
    }
    (sec.fields || []).forEach(f => {
      const row = document.createElement('div');
      row.className = 'set-row';
      const label = document.createElement('div');
      label.className = 'set-label';
      label.textContent = f.title;
      row.appendChild(label);
      const control = f.type === 'stepper' ? stepperControl(f)
        : f.type === 'toggle' ? toggleControl(f)
        : f.type === 'info' ? infoControl(f)
        : f.type === 'link' ? linkControl(f)
        : segControl(f);
      row.appendChild(control);
      wrap.appendChild(row);
    });
    body.appendChild(wrap);
  });
}

function openSettings(open) {
  const drawer = $('settingsDrawer'), scrim = $('settingsScrim');
  if (!drawer || !scrim) return;
  drawer.classList.toggle('open', open);
  scrim.classList.toggle('open', open);
  if (open && !settingsLoaded) loadSettings();
}

// ---- system power actions ---------------------------------------------- //
const POWER = {
  exit: { title: 'Exit console?', body: 'The console app will close. Restart it from the Pi to resume.',
          confirm: 'Exit', danger: false, overlay: 'Console has exited.' },
  reboot: { title: 'Reboot console?', body: 'The Raspberry Pi will restart. This display reconnects automatically once it is back.',
            confirm: 'Reboot', danger: true, overlay: 'Rebooting… the console will reconnect when it’s back.' },
  shutdown: { title: 'Shut down console?', body: 'The Raspberry Pi will power off. You’ll need to power it back on manually.',
              confirm: 'Shut down', danger: true, overlay: 'Shutting down… it is now safe to remove power.' },
};

function confirmDialog(opts, onConfirm) {
  const scrim = document.createElement('div');
  scrim.className = 'confirm-scrim';
  scrim.innerHTML = '<div class="confirm-card" role="dialog" aria-modal="true">'
    + '<h4></h4><p></p><div class="confirm-row">'
    + '<button class="confirm-cancel" type="button">Cancel</button>'
    + `<button class="confirm-ok${opts.danger ? '' : ' neutral'}" type="button"></button>`
    + '</div></div>';
  scrim.querySelector('h4').textContent = opts.title;
  scrim.querySelector('p').textContent = opts.body;
  scrim.querySelector('.confirm-ok').textContent = opts.confirm;
  const close = () => scrim.remove();
  scrim.querySelector('.confirm-cancel').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('.confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
  document.body.appendChild(scrim);
}

function systemAction(action) {
  const cfg = POWER[action];
  if (!cfg) return;
  confirmDialog(cfg, () => {
    fetch('/api/system', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => {});
    const ov = document.createElement('div');
    ov.className = 'sys-overlay';
    ov.innerHTML = `<div class="spin"></div><p>${cfg.overlay}</p>`;
    document.body.appendChild(ov);
  });
}

// ---- first-run setup --------------------------------------------------- //
function setupVisible(show) {
  const el = $('setupScreen');
  if (el) el.hidden = !show;
}

// When the setup screen is shown on the device itself (kiosk at localhost), a
// user has no keyboard — point them to open it from a phone/computer instead.
function updateSetupRemote(access) {
  const el = $('setupRemote');
  if (!el) return;
  const onDevice = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  const urls = access ? [access.host, access.ip].filter(Boolean) : [];
  if (!onDevice || !urls.length) { el.hidden = true; return; }
  const links = urls.map((u) => `<a href="http://${u}">${u}</a>`).join(' &nbsp;·&nbsp; ');
  setHTML('setupRemoteText', `<b>No keyboard on this screen?</b><br>Scan the code — or open ${links} on a phone or computer on the same network.`);
  const qr = $('setupQR');
  if (qr) {
    if (access.qr) { if (qr.src !== access.qr) qr.src = access.qr; qr.hidden = false; }
    else qr.hidden = true;
  }
  el.hidden = false;
}

function setSetupError(msg) {
  const el = $('setupError');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function resetSetupBtn() {
  const b = $('setupConnect');
  if (b) { b.disabled = false; b.textContent = 'Connect'; }
}

async function doSetup(stationId) {
  const token = ($('setupToken').value || '').trim();
  if (!token) { setSetupError('Paste your token first.'); return; }
  setSetupError('');
  const btn = $('setupConnect');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  try {
    const body = stationId != null ? { token, stationId } : { token };
    const r = await fetch('/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((res) => res.json());
    if (!r.ok) { setSetupError('Couldn’t validate that token — double-check it and try again.'); resetSetupBtn(); return; }
    if (stationId == null && Array.isArray(r.stations) && r.stations.length > 1) {
      renderStationPicker(r.stations);
      resetSetupBtn();
      return;
    }
    // Success: the next snapshot reports configured=true and swaps to the dashboard.
    if (btn) btn.textContent = 'Connected!';
  } catch {
    setSetupError('Network error — is the token correct?');
    resetSetupBtn();
  }
}

function renderStationPicker(stations) {
  const el = $('setupStations');
  if (!el) return;
  el.hidden = false;
  el.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'setup-label';
  label.textContent = 'Choose your station';
  el.appendChild(label);
  stations.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'setup-station';
    b.textContent = s.name;
    b.addEventListener('click', () => doSetup(s.id));
    el.appendChild(b);
  });
}

// ---- clock (honors Display time/date format settings) ------------------ //
let displayPrefs = {};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');

function formatDate(d, fmt) {
  fmt = fmt || 'Mon, 01 Jan 0000';
  const weekday = fmt.indexOf('Monday') === 0 ? DAYS_LONG[d.getDay()] : DAYS[d.getDay()];
  const mon = MONS[d.getMonth()], dd = p2(d.getDate());
  const md = /Jan 01/.test(fmt) ? `${mon} ${dd}` : `${dd} ${mon}`;
  return `${weekday}, ${md} ${d.getFullYear()}`;
}

function tick() {
  const n = new Date();
  if (displayPrefs.TimeFormat === '24 hr') {
    set('time', `${p2(n.getHours())}:${p2(n.getMinutes())}:${p2(n.getSeconds())}`);
  } else {
    const ap = n.getHours() >= 12 ? 'PM' : 'AM';
    set('time', `${n.getHours() % 12 || 12}:${p2(n.getMinutes())}:${p2(n.getSeconds())} ${ap}`);
  }
  set('date', formatDate(n, displayPrefs.DateFormat));
}

// ---- boot -------------------------------------------------------------- //
(function init() {
  // Compass tick marks
  const g = $('ticks');
  if (g) {
    for (let i = 0; i < 72; i++) {
      const major = i % 6 === 0;
      const a = (i / 72) * 2 * Math.PI;
      const r1 = 88, r2 = major ? 79 : 83;
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', 100 + r1 * Math.sin(a)); l.setAttribute('y1', 100 - r1 * Math.cos(a));
      l.setAttribute('x2', 100 + r2 * Math.sin(a)); l.setAttribute('y2', 100 - r2 * Math.cos(a));
      l.setAttribute('stroke-width', major ? 1.8 : 0.9);
      l.setAttribute('opacity', major ? 1 : 0.6);
      g.appendChild(l);
    }
  }
  // Prep barometer arc for smooth fills
  const baro = $('baroArc');
  if (baro) {
    baroLen = baro.getTotalLength();
    baro.style.strokeDasharray = baroLen;
    baro.style.strokeDashoffset = baroLen;
    baro.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.2,.9,.25,1)';
  }
  const nd = $('needle');
  if (nd) nd.style.transition = 'transform 1.2s cubic-bezier(.2,.9,.25,1)';

  // Update popover: tap badge to toggle, dismiss on close / outside click / Esc
  const badge = $('updateBadge'), pop = $('updatePopover'), closeBtn = $('updateClose');
  function onDocClickPopover(e) {
    if (!pop.contains(e.target) && !badge.contains(e.target)) showPopover(false);
  }
  function showPopover(open) {
    if (!pop || !badge) return;
    pop.hidden = !open;
    badge.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Attach the outside-click listener only while open, on the next tick so
    // the click that opened it can't immediately close it.
    if (open) setTimeout(() => document.addEventListener('click', onDocClickPopover), 0);
    else document.removeEventListener('click', onDocClickPopover);
  }
  if (badge) badge.addEventListener('click', () => showPopover(pop.hidden));
  if (closeBtn) closeBtn.addEventListener('click', () => showPopover(false));
  const runBtn = $('updateRun');
  if (runBtn) runBtn.addEventListener('click', runUpdate);

  // Settings drawer
  // Mount the shared temperature pane in both hosts (dashboard tile + full layout).
  if ($('tempPaneHost')) dashTempPane = temperaturePane($('tempPaneHost'), { forecastDays: 5 });
  if ($('tempLayoutCard')) layoutTempPane = temperaturePane($('tempLayoutCard'), { forecastDays: 10 });

  // Hidden touch gesture: swipe left/right to flip between layouts. No chrome.
  // Ignored while the settings drawer or setup screen is open.
  const overlayOpen = (target) => {
    if ($('setupScreen') && !$('setupScreen').hidden) return true;
    if ($('settingsDrawer') && $('settingsDrawer').classList.contains('open')) return true;
    return !!(target && target.closest && target.closest('#settingsDrawer, #settingsScrim, #setupScreen'));
  };
  let sx = 0, sy = 0, swiping = false;
  document.addEventListener('touchstart', (e) => {
    swiping = e.touches.length === 1 && !overlayOpen(e.target);
    if (swiping) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!swiping) return;
    swiping = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) cycleLayout(dx < 0 ? 1 : -1);
  }, { passive: true });

  // Re-apply theme when the OS light/dark preference changes (only matters in 'auto').
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((displayPrefs.Theme || 'dark') === 'auto') applyTheme('auto');
  });

  // First-run setup
  const setupConnect = $('setupConnect'), setupToken = $('setupToken');
  if (setupConnect) setupConnect.addEventListener('click', () => doSetup());
  if (setupToken) setupToken.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSetup(); });

  const settingsBtn = $('settingsBtn'), settingsClose = $('settingsClose'), scrim = $('settingsScrim');
  if (settingsBtn) settingsBtn.addEventListener('click', () => openSettings(true));
  if (settingsClose) settingsClose.addEventListener('click', () => openSettings(false));
  if (scrim) scrim.addEventListener('click', () => openSettings(false));

  // Power actions
  document.querySelectorAll('.power-btn').forEach(b =>
    b.addEventListener('click', () => systemAction(b.dataset.action)));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      showPopover(false);
      const cs = document.querySelector('.confirm-scrim');
      if (cs) cs.remove(); else openSettings(false);
    }
  });

  tick(); setInterval(tick, 1000);
  connect();

  // Also grab an immediate snapshot in case the socket is slow to open.
  fetch('/api/snapshot').then(r => r.json()).then(render).catch(() => {});
})();
