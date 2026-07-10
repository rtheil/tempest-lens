/**
 * WeatherFlow REST client. Fetches station metadata (name, location, elevation,
 * timezone) and the BetterForecast (current conditions, 5-day daily, sun times).
 * Temps are requested in the display unit so WeatherFlow does the rounding —
 * matching the Tempest app.
 */

import type { Units } from './units.js';
import { seaLevelPressureMb } from './derived.js';

const BASE = 'https://swd.weatherflow.com/swd/rest';

export interface StationInfo {
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  timezone: string | null;
  deviceId: number | null;
  deviceType: 'ST' | 'AR' | null;
}

export interface ForecastResult {
  met: Record<string, unknown>;
  sunriseEpoch: number | null;
  sunsetEpoch: number | null;
  forecast: ForecastDay[];
}

export interface ForecastDay {
  day: string;
  icon: string;
  high: [string, string];
  low: [string, string];
  precip: [string, string];
}

/** List all stations available to a token (for first-run setup + station
 *  picker). Also validates the token: an invalid token throws. */
export async function fetchStations(token: string): Promise<{ id: number; name: string }[]> {
  const r = await fetch(`${BASE}/stations?token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`stations HTTP ${r.status}`);
  const j: any = await r.json();
  const list: any[] = j?.stations ?? [];
  return list
    .map((s) => ({ id: num(s.station_id), name: s.name ?? s.public_name ?? `Station ${s.station_id}` }))
    .filter((s): s is { id: number; name: string } => s.id != null);
}

export async function fetchStation(token: string, stationId: number): Promise<StationInfo | null> {
  const url = `${BASE}/stations/${stationId}?token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`stations HTTP ${r.status}`);
  const j: any = await r.json();
  const s = j?.stations?.[0];
  if (!s) return null;

  // Prefer the Tempest (ST), else an Air (AR), for device-history lookups.
  let deviceId: number | null = null;
  let deviceType: 'ST' | 'AR' | null = null;
  const devices: any[] = s.devices ?? [];
  for (const want of ['ST', 'AR'] as const) {
    const d = devices.find((x) => x.device_type === want);
    if (d) {
      deviceId = num(d.device_id);
      deviceType = want;
      break;
    }
  }

  return {
    name: s.name ?? s.public_name ?? null,
    latitude: num(s.latitude),
    longitude: num(s.longitude),
    elevationM: num(s.station_meta?.elevation),
    timezone: s.timezone ?? null,
    deviceId,
    deviceType,
  };
}

/** Check GitHub for the latest release of the given repo (e.g. "owner/name").
 *  Returns the tag + URL, or null if there are no releases / on error. */
export async function fetchLatestRelease(
  repo: string,
): Promise<{ tag: string; url: string } | null> {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tempest-lens' },
  });
  if (r.status === 404) return null; // no releases yet
  if (!r.ok) throw new Error(`github releases HTTP ${r.status}`);
  const j: any = await r.json();
  return j?.tag_name ? { tag: String(j.tag_name), url: j.html_url ?? '' } : null;
}

/** Latest station observation object (WeatherFlow's server-side derived +
 *  accumulated fields). Returns obs[0], or null. */
export async function fetchStationObs(
  token: string,
  stationId: number,
): Promise<Record<string, unknown> | null> {
  const url = `${BASE}/observations/station/${stationId}?token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`station obs HTTP ${r.status}`);
  const j: any = await r.json();
  return j?.obs?.[0] ?? null;
}

export interface HighLow {
  high: { v: number; t: number } | null; // °C + epoch
  low: { v: number; t: number } | null;
  slpMinMb: number | null; // daily sea-level pressure min/max
  slpMaxMb: number | null;
  peakSunHours: number | null; // integrated solar radiation since midnight
}

/** Today's observed temperature high/low (°C, with the epoch each occurred) and
 *  the daily sea-level-pressure min/max, from device history since local
 *  midnight. SLP is reduced per-row from station pressure using elevation and
 *  that row's air temperature. */
export async function fetchTodayHighLow(
  token: string,
  deviceId: number,
  deviceType: 'ST' | 'AR',
  nowS: number,
  tz: string | null,
  elevationM: number | null,
): Promise<HighLow> {
  const tIdx = deviceType === 'ST' ? 7 : 2; // air_temperature
  const pIdx = deviceType === 'ST' ? 6 : 1; // station_pressure (mb)
  const solIdx = deviceType === 'ST' ? 11 : -1; // solar_radiation (W/m²)
  const midnight = localMidnightEpoch(nowS, tz);
  const rows = await deviceObs(token, deviceId, midnight, nowS, 'a');

  let high: { v: number; t: number } | null = null;
  let low: { v: number; t: number } | null = null;
  let slpMinMb: number | null = null;
  let slpMaxMb: number | null = null;
  let wattHours = 0; // Wh/m² accumulated from per-minute radiation samples
  let sawSolar = false;

  for (const row of rows) {
    const t = row[tIdx];
    if (typeof t === 'number' && Number.isFinite(t)) {
      if (!high || t > high.v) high = { v: t, t: row[0] };
      if (!low || t < low.v) low = { v: t, t: row[0] };
    }
    const p = row[pIdx];
    if (typeof p === 'number' && Number.isFinite(p) && elevationM != null && typeof t === 'number') {
      const slp = seaLevelPressureMb(p, elevationM, t);
      if (slp != null) {
        if (slpMinMb == null || slp < slpMinMb) slpMinMb = slp;
        if (slpMaxMb == null || slp > slpMaxMb) slpMaxMb = slp;
      }
    }
    if (solIdx >= 0) {
      const s = row[solIdx];
      if (typeof s === 'number' && Number.isFinite(s)) {
        wattHours += s / 60; // each sample ≈ 1 minute
        sawSolar = true;
      }
    }
  }
  const peakSunHours = sawSolar ? wattHours / 1000 : null;
  return { high, low, slpMinMb, slpMaxMb, peakSunHours };
}

/** Air temperature (°C) ~`secondsAgo` in the past, for day-over-day and 3-hr
 *  trend comparisons. Picks the observation closest to the target time. */
export async function fetchTempAgo(
  token: string,
  deviceId: number,
  deviceType: 'ST' | 'AR',
  nowS: number,
  secondsAgo: number,
): Promise<number | null> {
  const idx = deviceType === 'ST' ? 7 : 2;
  const target = nowS - secondsAgo;
  const rows = await deviceObs(token, deviceId, target - 1800, target + 1800, 'a');
  let best: number | null = null;
  let bestDt = Infinity;
  for (const row of rows) {
    const v = row[idx];
    if (typeof v !== 'number') continue;
    const dt = Math.abs(row[0] - target);
    if (dt < bestDt) {
      bestDt = dt;
      best = v;
    }
  }
  return best;
}

async function deviceObs(
  token: string,
  deviceId: number,
  timeStart: number,
  timeEnd: number,
  bucket?: 'a' | 'e',
): Promise<number[][]> {
  let url =
    `${BASE}/observations/device/${deviceId}?token=${encodeURIComponent(token)}` +
    `&time_start=${Math.floor(timeStart)}&time_end=${Math.floor(timeEnd)}`;
  if (bucket) url += `&bucket=${bucket}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`device obs HTTP ${r.status}`);
  const j: any = await r.json();
  return (j?.obs as number[][]) ?? [];
}

// Tempest (ST) device-obs column indices (nc_rain off), per the WeatherFlow API
// and the original project: bucket=a is intraday, bucket=e is daily-aggregated.
const ST = { aStrikes: 15, aRain: 12, eStrikes: 24, eRain: 28 };

export interface History {
  todayStrikes: number | null; // from bucket=a (midnight -> now)
  monthStrikes: number | null; // bucket=e daily sums, EXCLUDING today
  monthRainMm: number | null; // bucket=e daily sums, EXCLUDING today
  yearRainMm: number | null; // bucket=e daily sums, EXCLUDING today
}

/** Rain + lightning totals from device history. Month/year exclude today
 *  (WeatherFlow's daily buckets lag); the live "today" portion is added by the
 *  station mapper so the totals track through the day. Tempest (ST) only. */
export async function fetchHistory(
  token: string,
  deviceId: number,
  deviceType: 'ST' | 'AR',
  nowS: number,
  tz: string | null,
): Promise<History> {
  const empty: History = { todayStrikes: null, monthStrikes: null, monthRainMm: null, yearRainMm: null };
  if (deviceType !== 'ST') return empty;

  const { y, m, d } = localYMD(nowS, tz);
  const todayMidnight = zonedEpoch(y, m, d, tz);
  const monthStart = zonedEpoch(y, m, 1, tz);
  const yearStart = zonedEpoch(y, 1, 1, tz);
  const yesterdayEnd = todayMidnight - 1;

  const sum = (rows: number[][], idx: number): number | null => {
    let s = 0;
    let any = false;
    for (const r of rows) {
      const v = r[idx];
      if (typeof v === 'number' && Number.isFinite(v)) {
        s += v;
        any = true;
      }
    }
    return any ? s : null;
  };

  const todayRows = await deviceObs(token, deviceId, todayMidnight, nowS, 'a');
  const todayStrikes = sum(todayRows, ST.aStrikes) ?? 0;

  let monthStrikes = 0;
  let monthRainMm = 0;
  if (todayMidnight > monthStart) {
    const rows = await deviceObs(token, deviceId, monthStart, yesterdayEnd, 'e');
    monthStrikes = sum(rows, ST.eStrikes) ?? 0;
    monthRainMm = sum(rows, ST.eRain) ?? 0;
  }

  let yearRainMm = 0;
  if (todayMidnight > yearStart) {
    const rows = await deviceObs(token, deviceId, yearStart, yesterdayEnd, 'e');
    yearRainMm = sum(rows, ST.eRain) ?? 0;
  }

  return { todayStrikes, monthStrikes, monthRainMm, yearRainMm };
}

/** Local calendar Y/M/D in the station timezone. */
function localYMD(nowS: number, tz: string | null): { y: number; m: number; d: number } {
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (tz) opts.timeZone = tz;
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date(nowS * 1000));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: g('year'), m: g('month'), d: g('day') };
}

/** Timezone offset (ms) at a given UTC instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const opts: Intl.DateTimeFormatOptions = {
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  };
  opts.timeZone = tz;
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUTC - utcMs;
}

/** Epoch (seconds) of local midnight on the given calendar day in tz. */
function zonedEpoch(y: number, m: number, d: number, tz: string | null): number {
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off = tz ? tzOffsetMs(utcGuess, tz) : 0;
  return Math.floor((utcGuess - off) / 1000);
}

/** Epoch (seconds) of the most recent local midnight in tz. */
export function localMidnightEpoch(nowS: number, tz: string | null): number {
  const { y, m, d } = localYMD(nowS, tz);
  return zonedEpoch(y, m, d, tz);
}

/** Seconds elapsed since local midnight in the given timezone (DST-safe enough
 *  for a daily boundary). */
function secondsIntoLocalDay(nowS: number, tz: string | null): number {
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  };
  if (tz) opts.timeZone = tz;
  const parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(new Date(nowS * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  let h = get('hour');
  if (h === 24) h = 0; // some engines emit 24 at midnight
  return h * 3600 + get('minute') * 60 + get('second');
}

export async function fetchForecast(
  token: string,
  stationId: number,
  units: Units,
  tz: string | null,
): Promise<ForecastResult | null> {
  const url =
    `${BASE}/better_forecast?station_id=${stationId}` +
    `&token=${encodeURIComponent(token)}&units_temp=${units.temp}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`better_forecast HTTP ${r.status}`);
  const j: any = await r.json();

  const daily: any[] = j?.forecast?.daily ?? [];
  const cc = j?.current_conditions ?? {};
  const d0 = daily[0] ?? {};
  const tempUnit = units.temp === 'f' ? '°F' : '°C';

  const met = {
    Conditions: [d0.conditions ?? cc.conditions ?? ''],
    Icon: [d0.icon ?? cc.icon ?? ''],
    highTemp: temp(d0.air_temp_high, tempUnit),
    lowTemp: temp(d0.air_temp_low, tempUnit),
    PrecipPercnt: pct(d0.precip_probability),
  };

  const forecast: ForecastDay[] = daily.slice(0, 10).map((d, i) => ({
    day: i === 0 ? 'Today' : weekday(d.day_start_local, tz),
    icon: d.icon ?? '',
    high: temp(d.air_temp_high, tempUnit),
    low: temp(d.air_temp_low, tempUnit),
    precip: pct(d.precip_probability),
  }));

  return {
    met,
    sunriseEpoch: num(d0.sunrise),
    sunsetEpoch: num(d0.sunset),
    forecast,
  };
}

/** Format an epoch (seconds) as a local clock time in the station timezone. */
export function formatClock(epochS: number | null, tz: string | null, hour12 = true): string {
  if (epochS == null) return '--';
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12 };
  if (tz) opts.timeZone = tz;
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(epochS * 1000)).toLowerCase();
}

function weekday(epochS: number | null | undefined, tz: string | null): string {
  if (epochS == null) return '';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short' };
  if (tz) opts.timeZone = tz;
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(epochS * 1000));
}

function temp(v: unknown, unit: string): [string, string] {
  const n = num(v);
  return n == null ? ['--', unit] : [n.toFixed(0), unit];
}

function pct(v: unknown): [string, string] {
  const n = num(v);
  return n == null ? ['0', '%'] : [n.toFixed(0), '%'];
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}
