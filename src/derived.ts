/**
 * Derived variables computed from raw observations. Ported from the Python
 * console's derived_variables. Currently: sea-level pressure and feels-like.
 * (Daily min/max, accumulations, and trends — which need history — come with
 * the REST backfill phase.)
 */

/** Reduce station pressure (mb) to sea-level pressure (mb) using elevation and
 *  temperature (hypsometric approximation). */
export function seaLevelPressureMb(
  stationMb: number | null,
  elevationM: number | null,
  tempC: number | null,
): number | null {
  if (stationMb == null || elevationM == null || tempC == null) return null;
  if (!Number.isFinite(stationMb) || !Number.isFinite(elevationM) || !Number.isFinite(tempC)) {
    return null;
  }
  const factor = 1 - (0.0065 * elevationM) / (tempC + 0.0065 * elevationM + 273.15);
  return stationMb * Math.pow(factor, -5.257);
}

export interface FeelsLike {
  c: number;
  word: string;
}

/** Apparent temperature: heat index when warm, wind chill when cold, else air
 *  temperature. Returns °C plus a plain descriptor word. */
export function feelsLike(
  tempC: number,
  rh: number | null,
  windMs: number | null,
): FeelsLike {
  const tF = tempC * 9 / 5 + 32;
  const windMph = (windMs ?? 0) * 2.236936;
  let apparentF = tF;

  if (tF >= 80 && rh != null && Number.isFinite(rh)) {
    apparentF = heatIndexF(tF, rh);
  } else if (tF <= 50 && windMph > 3) {
    apparentF = windChillF(tF, windMph);
  }

  return { c: (apparentF - 32) * 5 / 9, word: feelsWord(apparentF) };
}

/** NWS Rothfusz heat-index regression (valid for T >= 80°F). */
function heatIndexF(T: number, R: number): number {
  return (
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R
  );
}

/** NWS wind-chill (valid for T <= 50°F and wind > 3 mph). */
function windChillF(T: number, V: number): number {
  const v16 = Math.pow(V, 0.16);
  return 35.74 + 0.6215 * T - 35.75 * v16 + 0.4275 * T * v16;
}

/** Descriptor word using minimum-threshold semantics (>= is that level).
 *  `f` is the apparent temperature in °F. */
export function feelsWord(f: number): string {
  if (f >= 100) return 'Extremely hot';
  if (f >= 90) return 'Very hot';
  if (f >= 80) return 'Hot';
  if (f >= 70) return 'Warm';
  if (f >= 55) return 'Mild';
  if (f >= 40) return 'Cold';
  if (f >= 25) return 'Very cold';
  if (f >= 10) return 'Freezing cold';
  return 'Extremely cold';
}
