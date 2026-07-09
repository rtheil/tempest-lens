/**
 * Unit conversions. The Tempest UDP broadcast is SI (°C, m/s, mb, mm); we
 * convert to the configured display units here and emit [value, unit] tuples.
 * Defaults to imperial (US); switch DEFAULT_UNITS for metric.
 */

export interface Units {
  temp: 'f' | 'c';
  wind: 'mph' | 'kmh' | 'ms';
  pressure: 'inhg' | 'mb' | 'mmhg';
  rain: 'in' | 'mm';
  distance: 'mi' | 'km';
}

export const DEFAULT_UNITS: Units = {
  temp: 'f',
  wind: 'mph',
  pressure: 'inhg',
  rain: 'in',
  distance: 'mi',
};

type V = [string, string];

const ok = (n: number | null | undefined): n is number =>
  n != null && Number.isFinite(n);

const fmt = (n: number, dp: number, unit: string): V => [n.toFixed(dp), unit];

export function temp(c: number | null, u: Units, dp = 1): V {
  const unit = u.temp === 'f' ? '°F' : '°C';
  if (!ok(c)) return ['--', unit];
  return fmt(u.temp === 'f' ? c * 9 / 5 + 32 : c, dp, unit);
}

export function wind(ms: number | null, u: Units, dp = 1): V {
  const unit = u.wind === 'mph' ? 'mph' : u.wind === 'kmh' ? 'km/h' : 'm/s';
  if (!ok(ms)) return ['--', unit];
  const v = u.wind === 'mph' ? ms * 2.236936 : u.wind === 'kmh' ? ms * 3.6 : ms;
  return fmt(v, dp, unit);
}

export function pressure(mb: number | null, u: Units): V {
  const unit = u.pressure === 'inhg' ? 'inHg' : u.pressure === 'mmhg' ? 'mmHg' : 'mb';
  if (!ok(mb)) return ['--', unit];
  const v =
    u.pressure === 'inhg' ? mb * 0.0295299830714 :
    u.pressure === 'mmhg' ? mb * 0.750061683 : mb;
  const dp = u.pressure === 'inhg' ? 3 : u.pressure === 'mmhg' ? 0 : 1;
  return fmt(v, dp, unit);
}

export function rainRate(mmPerHr: number | null, u: Units): V {
  const unit = u.rain === 'in' ? 'in/hr' : 'mm/hr';
  if (!ok(mmPerHr)) return ['--', unit];
  return fmt(u.rain === 'in' ? mmPerHr / 25.4 : mmPerHr, 2, unit);
}

export function humidity(pct: number | null): V {
  return ok(pct) ? [pct.toFixed(0), '%'] : ['--', '%'];
}

export function raw(n: number | null, unit: string, dp = 0): V {
  return ok(n) ? [n.toFixed(dp), unit] : ['--', unit];
}

/** Rain accumulation (mm in -> display). */
export function rain(mm: number | null, u: Units): V {
  const unit = u.rain === 'in' ? '"' : ' mm';
  if (!ok(mm)) return ['--', unit];
  return u.rain === 'in' ? [(mm / 25.4).toFixed(2), unit] : [mm.toFixed(1), unit];
}

/** Distance (km -> display). */
export function dist(km: number | null, u: Units): V {
  const unit = u.distance === 'mi' ? 'miles' : 'km';
  if (!ok(km)) return ['--', unit];
  return [(u.distance === 'mi' ? km * 0.621371 : km).toFixed(0), unit];
}

/** Wind direction in degrees. */
export function dir(deg: number | null): V {
  return ok(deg) ? [Math.round(deg).toString(), '°'] : ['--', '°'];
}

/** Dew point (Magnus formula), returns °C from air temp °C and RH %. */
export function dewPointC(tempC: number, rh: number): number {
  const a = 17.625, b = 243.04;
  const g = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}
