/**
 * Moon phase via a standard synodic-month approximation (accurate to well
 * within a day — plenty for a dashboard). Ported from the Python dev-preview.
 * Sun times come from the forecast API (see rest.ts), not computed here.
 */

import { Observer, SearchRiseSet, Body } from 'astronomy-engine';

const SYNODIC = 29.530588853; // days
const KNOWN_NEW_MOON = 947182440; // 2000-01-06 18:14 UTC, epoch seconds

export interface MoonInfo {
  text: string;
  illum: number; // 0..100 %
  waxing: boolean;
  daysToFull: number;
  daysToNew: number;
}

export function moonPhase(nowEpochS: number): MoonInfo {
  const age = mod((nowEpochS - KNOWN_NEW_MOON) / 86400, SYNODIC);
  const illum = (1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2;
  const p = age / SYNODIC;

  let text: string;
  if (p < 0.02 || p > 0.98) text = 'New Moon';
  else if (p < 0.24) text = 'Waxing Crescent';
  else if (p < 0.26) text = 'First Quarter';
  else if (p < 0.49) text = 'Waxing Gibbous';
  else if (p < 0.51) text = 'Full Moon';
  else if (p < 0.74) text = 'Waning Gibbous';
  else if (p < 0.76) text = 'Last Quarter';
  else text = 'Waning Crescent';

  const daysToFull = mod(SYNODIC / 2 - age, SYNODIC);
  const daysToNew = mod(SYNODIC - age, SYNODIC);

  return {
    text,
    illum: illum * 100,
    waxing: p < 0.5,
    daysToFull,
    daysToNew,
  };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Today's moonrise/moonset epochs (seconds) for the given location, searching
 *  from `startEpochS` (local midnight) forward one day. Null if none occurs. */
export function moonRiseSet(
  lat: number | null,
  lon: number | null,
  elevM: number | null,
  startEpochS: number,
): { rise: number | null; set: number | null } {
  if (lat == null || lon == null) return { rise: null, set: null };
  try {
    const observer = new Observer(lat, lon, elevM ?? 0);
    const start = new Date(startEpochS * 1000);
    const rise = SearchRiseSet(Body.Moon, observer, +1, start, 1);
    const set = SearchRiseSet(Body.Moon, observer, -1, start, 1);
    return {
      rise: rise ? Math.floor(rise.date.getTime() / 1000) : null,
      set: set ? Math.floor(set.date.getTime() / 1000) : null,
    };
  } catch {
    return { rise: null, set: null };
  }
}
