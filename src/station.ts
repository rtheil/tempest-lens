/**
 * Maps a WeatherFlow /observations/station observation object to the frontend
 * Obs shape. This is the authoritative source for the derived + accumulated
 * fields WeatherFlow computes server-side (feels-like, sea-level pressure,
 * pressure trend, rain accumulations, lightning). Daily high/low (with the time
 * each occurred) and the 24h-ago temperature come from device history and are
 * passed in. Field mapping mirrors the original Python project.
 */

import type { Obs, Value } from './types.js';
import type { Units } from './units.js';
import {
  temp, wind, pressure, humidity, rainRate, rain, dist, dir, raw,
} from './units.js';
import { feelsWord } from './derived.js';
import { formatClock, type History, type HighLow } from './rest.js';

type Obj = Record<string, unknown>;

export function mapStationObs(
  o: Obj,
  u: Units,
  hl: HighLow | null,
  temp24hAgoC: number | null,
  temp3hAgoC: number | null,
  nowS: number,
  tz: string | null,
  history: History | null,
): Obs {
  const g = (k: string): number | null => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  const obs: Obs = {};
  obs.outTemp = temp(g('air_temperature'), u);

  const fl = g('feels_like');
  const ft = temp(fl, u, 0);
  obs.FeelsLike = [ft[0], ft[1], fl != null ? feelsWord(fl * 9 / 5 + 32) : ''];

  obs.DewPoint = temp(g('dew_point'), u, 0);
  obs.Humidity = humidity(g('relative_humidity'));

  obs.WindSpd = wind(g('wind_avg'), u);
  obs.AvgWind = wind(g('wind_avg'), u);
  obs.WindGust = wind(g('wind_gust'), u);
  obs.MaxGust = wind(g('wind_gust'), u);
  obs.WindDir = dir(g('wind_direction'));

  obs.SLP = pressure(g('sea_level_pressure') ?? g('barometric_pressure'), u);
  obs.SLPTrend = trendPseudo(String(o.pressure_trend ?? ''), u);
  if (hl?.slpMinMb != null) obs.SLPMin = pressure(hl.slpMinMb, u);
  if (hl?.slpMaxMb != null) obs.SLPMax = pressure(hl.slpMaxMb, u);

  obs.UVIndex = raw(g('uv'), '', 1);
  obs.Radiation = raw(g('solar_radiation'), 'W/m²');
  if (hl?.peakSunHours != null) obs.peakSun = raw(hl.peakSunHours, 'hrs', 2);

  const precip = g('precip');
  const todayRainMm = g('precip_accum_local_day');
  obs.RainRate = rainRate(precip != null ? precip * 60 : null, u);
  obs.TodayRain = rain(todayRainMm, u);
  obs.YesterdayRain = rain(g('precip_accum_local_yesterday'), u);

  // Month/year rain: device-history buckets (which exclude today) + today's live
  // accumulation, so the totals climb through the day.
  if (history?.monthRainMm != null) {
    obs.MonthRain = rain(history.monthRainMm + (todayRainMm ?? 0), u);
  }
  if (history?.yearRainMm != null) {
    obs.YearRain = rain(history.yearRainMm + (todayRainMm ?? 0), u);
  }

  // Daily high/low: prefer device-history (value + time); fall back to the
  // station summary value with no timestamp.
  const hiV = hl?.high?.v ?? g('air_temp_high_today');
  const loV = hl?.low?.v ?? g('air_temp_low_today');
  obs.outTempMax = withTime(temp(hiV, u, 1), hl?.high?.t, tz);
  obs.outTempMin = withTime(temp(loV, u, 1), hl?.low?.t, tz);

  // Lightning. Today/month come from device history (the station obs
  // lightning_strike_count is only the last report interval, not a daily total).
  obs.Strikes3hr = [numStr(g('lightning_strike_count_last_3hr'))];
  obs.StrikeDist = dist(g('lightning_strike_last_distance'), u);
  obs.StrikeDeltaT = strikeDelta(g('lightning_strike_last_epoch'), nowS);
  if (history?.todayStrikes != null) {
    obs.StrikesToday = [numStr(history.todayStrikes)];
    const month = (history.monthStrikes ?? 0) + history.todayStrikes;
    obs.StrikesMonth = [numStr(month)];
  }

  // 24-hour temperature difference + 3-hr trend rate
  obs.outTempDiff = tempDiff(g('air_temperature'), temp24hAgoC, u);
  obs.outTempTrend = tempTrend(g('air_temperature'), temp3hAgoC, u);

  return obs;
}

function withTime(v: [string, string], epoch: number | undefined, tz: string | null): Value {
  return epoch ? [v[0], v[1], formatClock(epoch, tz)] : [v[0], v[1], ''];
}

function trendPseudo(trend: string, u: Units): Value {
  const unit = ' ' + (u.pressure === 'inhg' ? 'inHg' : u.pressure === 'mmhg' ? 'mmHg' : 'mb') + '/hr';
  const t = trend.toLowerCase();
  if (t === 'rising') return ['+0.03', unit];
  if (t === 'falling') return ['-0.03', unit];
  return ['0.00', unit];
}

function strikeDelta(lastEpoch: number | null, nowS: number): Value {
  if (!lastEpoch) return ['-', '-', '-', '-', '#fff'];
  const mins = Math.max(0, Math.floor((nowS - lastEpoch) / 60));
  if (mins < 60) return [String(mins), plural(mins, 'min'), '-', '-', '#fff'];
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [String(h), plural(h, 'hr'), String(m), plural(m, 'min'), '#fff'];
}

function plural(n: number, unit: string): string {
  return n === 1 ? unit : unit + 's';
}

function tempTrend(curC: number | null, prev3C: number | null, u: Units): Value {
  const unit = (u.temp === 'f' ? '°F' : '°C') + '/hr';
  if (curC == null || prev3C == null) return ['--', unit, '-'];
  const rateC = (curC - prev3C) / 3; // per hour over the 3-hour window
  const rate = u.temp === 'f' ? rateC * 9 / 5 : rateC;
  const sign = rate > 0 ? '+' : '';
  return [sign + rate.toFixed(1), unit, '-'];
}

function tempDiff(curC: number | null, prevC: number | null, u: Units): Value {
  const unit = u.temp === 'f' ? '°F' : '°C';
  if (curC == null || prevC == null) return ['--', unit, '-'];
  const dC = curC - prevC;
  const dDisp = u.temp === 'f' ? dC * 9 / 5 : dC;
  const word = dC > 0.05 ? 'warmer' : dC < -0.05 ? 'colder' : 'same';
  return [Math.abs(dDisp).toFixed(1), unit, word];
}

function numStr(n: number | null): string {
  return n == null ? '-' : String(n);
}
