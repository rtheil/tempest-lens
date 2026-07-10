/**
 * In-memory state store. Assembles the snapshot the frontend consumes.
 *
 * Two observation sources:
 *   - Station REST (/observations/station) is the authoritative source for the
 *     derived + accumulated fields WeatherFlow computes (feels-like, SLP, trend,
 *     rain accumulations, lightning). Device history seeds daily high/low + 24h.
 *   - UDP is the live overlay (rapid_wind for a responsive needle), and the
 *     full fallback when no token is configured (obs derived locally).
 */

import type { Snapshot, Obs, Meta } from './types.js';
import type { ObsSt, RapidWind } from './udp.js';
import type { Units } from './units.js';
import { temp, wind, pressure, humidity, rainRate, raw, dir, dewPointC } from './units.js';
import { seaLevelPressureMb, feelsLike } from './derived.js';
import { moonPhase, moonRiseSet } from './astro.js';
import {
  formatClock,
  localMidnightEpoch,
  type StationInfo,
  type ForecastResult,
  type History,
  type HighLow,
} from './rest.js';
import { mapStationObs } from './station.js';
import type { DisplayPrefs } from './settings.js';

export const BUILD = '1.1.3';
export const VERSION = '1.1.3';
export const REPO = 'rtheil/tempest-lens';
export const REPO_URL = 'https://github.com/rtheil/tempest-lens';

interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  url: string;
  notes: string;
}

export class State {
  private version = 0;
  private obsSt: ObsSt | null = null;
  private rapid: RapidWind | null = null;

  private meta: Meta = { connection: 'UDP' };
  private elevationM: number | null = null;
  private lat: number | null = null;
  private lon: number | null = null;
  private tz: string | null = null;
  private deviceId: number | null = null;
  private deviceType: 'ST' | 'AR' | null = null;

  private met: Record<string, unknown> = {};
  private fcast: unknown[] = [];
  private hourly: unknown[] = [];
  private sunriseEpoch: number | null = null;
  private sunsetEpoch: number | null = null;

  private stationObs: Record<string, unknown> | null = null;
  private hl: HighLow | null = null;
  private temp24hAgoC: number | null = null;
  private temp3hAgoC: number | null = null;
  private hist: History | null = null;
  private updateInfo: UpdateInfo = { available: false, current: VERSION, latest: '', url: '', notes: '' };
  private configured = false;
  private access = { host: '', ip: '', qr: '' };

  constructor(private units: Units, private display: DisplayPrefs) {}

  setAccess(a: { host: string; ip: string; qr: string }): void {
    this.access = a;
  }

  setConfigured(b: boolean): void {
    if (this.configured !== b) {
      this.configured = b;
      this.version++;
    }
  }

  get update(): UpdateInfo {
    return this.updateInfo;
  }

  setUpdate(info: { available: boolean; latest: string; url: string; notes?: string }): void {
    this.updateInfo = { available: info.available, current: VERSION, latest: info.latest, url: info.url, notes: info.notes ?? '' };
    this.version++;
  }

  get timezone(): string | null {
    return this.tz;
  }

  get currentUnits(): Units {
    return this.units;
  }

  get displayPrefs(): DisplayPrefs {
    return this.display;
  }

  setUnits(u: Units): void {
    this.units = u;
    this.version++;
  }

  setDisplay(d: DisplayPrefs): void {
    this.display = d;
    this.version++;
  }

  get elevation(): number | null {
    return this.elevationM;
  }

  get device(): { id: number | null; type: 'ST' | 'AR' | null } {
    return { id: this.deviceId, type: this.deviceType };
  }

  applyObsSt(o: ObsSt): void {
    this.obsSt = o;
    this.version++;
  }

  applyRapidWind(o: RapidWind): void {
    this.rapid = o;
    this.version++;
  }

  setStation(info: StationInfo): void {
    this.meta = {
      ...this.meta,
      name: info.name ?? this.meta.name,
      latitude: info.latitude != null ? String(info.latitude) : this.meta.latitude,
      longitude: info.longitude != null ? String(info.longitude) : this.meta.longitude,
      elevation: info.elevationM != null ? String(info.elevationM) : this.meta.elevation,
      timezone: info.timezone ?? this.meta.timezone,
      connection: 'UDP + REST',
    };
    if (info.elevationM != null) this.elevationM = info.elevationM;
    if (info.latitude != null) this.lat = info.latitude;
    if (info.longitude != null) this.lon = info.longitude;
    if (info.timezone) this.tz = info.timezone;
    if (info.deviceId != null) this.deviceId = info.deviceId;
    if (info.deviceType) this.deviceType = info.deviceType;
    this.version++;
  }

  setForecast(f: ForecastResult): void {
    this.met = f.met;
    this.fcast = f.forecast;
    this.hourly = f.hourly;
    this.sunriseEpoch = f.sunriseEpoch;
    this.sunsetEpoch = f.sunsetEpoch;
    this.version++;
  }

  setStationObs(o: Record<string, unknown>): void {
    this.stationObs = o;
    this.version++;
  }

  setHighLow(hl: HighLow): void {
    this.hl = hl;
    this.version++;
  }

  setTemp24hAgo(c: number | null): void {
    this.temp24hAgoC = c;
    this.version++;
  }

  setTemp3hAgo(c: number | null): void {
    this.temp3hAgoC = c;
    this.version++;
  }

  setHistory(h: History): void {
    this.hist = h;
    this.version++;
  }

  private buildObs(nowS: number): Obs {
    if (this.stationObs) {
      const obs = mapStationObs(
        this.stationObs, this.units, this.hl, this.temp24hAgoC, this.temp3hAgoC, nowS, this.tz, this.hist,
      );
      // Live wind overlay between station polls.
      if (this.rapid) {
        obs.WindSpd = wind(this.rapid.windSpeed, this.units);
        obs.WindDir = dir(Math.round(this.rapid.windDir), this.units);
      }
      return obs;
    }
    return this.buildObsFromUdp();
  }

  /** Fallback used when no REST data is available yet (or no token): derive
   *  what we can straight from the UDP broadcast. */
  private buildObsFromUdp(): Obs {
    const u = this.units;
    const obs: Obs = {};
    const o = this.obsSt;

    if (o) {
      const dew =
        Number.isFinite(o.airTemp) && Number.isFinite(o.rh) ? dewPointC(o.airTemp, o.rh) : null;
      obs.outTemp = temp(o.airTemp, u);
      obs.DewPoint = temp(dew, u);
      obs.Humidity = humidity(o.rh);
      obs.AvgWind = wind(o.windAvg, u);
      obs.WindGust = wind(o.windGust, u);
      obs.UVIndex = raw(o.uv, '', 1);
      obs.Radiation = raw(o.solarRad, 'W/m²');
      obs.RainRate = rainRate(o.rainLastMin != null ? o.rainLastMin * 60 : null, u);

      const slp = seaLevelPressureMb(o.pressure, this.elevationM, o.airTemp);
      obs.SLP = pressure(slp ?? o.pressure, u);

      const windForFeel = this.rapid?.windSpeed ?? o.windAvg;
      const fl = feelsLike(o.airTemp, o.rh, windForFeel);
      const ft = temp(fl.c, u, 0);
      obs.FeelsLike = [ft[0], ft[1], fl.word];

      if (!this.rapid) {
        obs.WindSpd = wind(o.windAvg, u);
        obs.WindDir = dir(o.windDir, u);
      }
    }

    if (this.rapid) {
      obs.WindSpd = wind(this.rapid.windSpeed, u);
      obs.WindDir = dir(Math.round(this.rapid.windDir), u);
    }

    return obs;
  }

  private buildAstro(nowEpochS: number): Record<string, unknown> {
    const m = moonPhase(nowEpochS);
    const { rise, set } = moonRiseSet(
      this.lat, this.lon, this.elevationM, localMidnightEpoch(nowEpochS, this.tz),
    );
    return {
      Sunrise: ['-', formatClock(this.sunriseEpoch, this.tz), this.sunriseEpoch],
      Sunset: ['-', formatClock(this.sunsetEpoch, this.tz), this.sunsetEpoch],
      Phase: ['-', m.text, m.illum.toFixed(0), m.waxing ? 1 : 0],
      FullMoon: [daysLabel(m.daysToFull)],
      NewMoon: [daysLabel(m.daysToNew)],
      Moonrise: ['-', formatClock(rise, this.tz)],
      Moonset: ['-', formatClock(set, this.tz)],
    };
  }

  snapshot(): Snapshot {
    const nowEpochS = Math.floor(Date.now() / 1000);
    return {
      build: BUILD,
      version: this.version,
      configured: this.configured,
      access: this.access,
      meta: this.meta,
      obs: this.buildObs(nowEpochS),
      astro: this.buildAstro(nowEpochS),
      met: this.met,
      sager: {},
      forecast: this.fcast,
      hourly: this.hourly,
      update: { ...this.updateInfo, notify: this.display.UpdateNotification === '1' },
      display: this.display,
    };
  }
}

function daysLabel(days: number): string {
  const d = Math.round(days);
  if (d <= 0) return 'today';
  if (d === 1) return 'in 1 day';
  return `in ${d} days`;
}
