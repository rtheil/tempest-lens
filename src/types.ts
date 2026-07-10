/**
 * The snapshot contract — the JSON shape the frontend (web/app.js) consumes.
 * Ported verbatim from the Python bridge's snapshot so the existing UI works
 * against this server unchanged. Each displayed value is a [value, unit, ...]
 * tuple, matching the original console's observation shape.
 */

export type Value = (string | number | null)[];

export interface Meta {
  name?: string;
  latitude?: string;
  longitude?: string;
  elevation?: string;
  timezone?: string;
  hardware?: string;
  connection?: string;
}

/**
 * Observation fields read by web/app.js. All optional: the PoC fills the ones
 * the Tempest UDP broadcast provides directly; derived variables (feels-like,
 * true SLP, daily min/max, accumulations, trends) come in a later phase and
 * simply render as "--" until then.
 */
export interface Obs {
  outTemp?: Value;
  DewPoint?: Value;
  Humidity?: Value;
  WindSpd?: Value;
  WindDir?: Value;
  WindGust?: Value;
  AvgWind?: Value;
  SLP?: Value; // station pressure for now; true sea-level pressure is a derived var (later)
  UVIndex?: Value;
  Radiation?: Value;
  RainRate?: Value;
  [key: string]: Value | undefined;
}

export interface Snapshot {
  build: string;
  version: number;
  configured: boolean; // false = no token yet -> frontend shows first-run setup
  meta: Meta;
  obs: Obs;
  astro: Record<string, unknown>;
  met: Record<string, unknown>;
  sager: Record<string, unknown>;
  forecast: unknown[];
  update: { available: boolean; current: string; latest: string; url: string; notify: boolean };
  display: { TimeFormat: string; DateFormat: string };
}
