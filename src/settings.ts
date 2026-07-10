/**
 * Settings schema served at GET /api/config and rendered by the frontend's
 * settings drawer. Just Units + Display now (feels-like thresholds were dropped
 * in favor of a fixed temperature-band color on the value).
 */

import type { Units } from './units.js';

export interface DisplayPrefs {
  Theme: string; // 'dark' | 'light' | 'auto'
  Layout: string; // 'dashboard' | 'temp'
  TimeFormat: string; // '12 hr' | '24 hr'
  DateFormat: string;
  UpdateNotification: string; // '1' | '0'
}

export const DEFAULT_DISPLAY: DisplayPrefs = {
  Theme: 'dark',
  Layout: 'dashboard',
  TimeFormat: '12 hr',
  DateFormat: 'Mon, Jan 01 0000',
  UpdateNotification: '1',
};

export interface ConfigField {
  section: string;
  key: string;
  title: string;
  type?: 'stepper' | 'toggle' | 'info' | 'link';
  value: string;
  options?: string[];
  labels?: Record<string, string>;
  unit?: string;
  label?: string; // display text for 'link' fields
}

export interface ConfigSchema {
  sections: { name: string; title: string; desc?: string; fields: ConfigField[] }[];
}

export interface About {
  version: string;
  updateAvailable: boolean;
  latest: string;
  url: string; // release/repo URL
  repoUrl: string;
  repoLabel: string;
}

export function buildSchema(u: Units, d: DisplayPrefs, about: About): ConfigSchema {
  return {
    sections: [
      {
        name: 'Appearance',
        title: 'Appearance',
        fields: [
          { section: 'Display', key: 'Theme', title: 'Theme', value: d.Theme, options: ['dark', 'light', 'auto'], labels: { dark: 'Dark', light: 'Light', auto: 'Auto' } },
          { section: 'Display', key: 'Layout', title: 'Layout', value: d.Layout, options: ['dashboard', 'temp'], labels: { dashboard: 'Dashboard', temp: 'Temperature' } },
        ],
      },
      {
        name: 'Units',
        title: 'Units',
        fields: [
          { section: 'Units', key: 'temp', title: 'Temperature', value: u.temp, options: ['f', 'c'], labels: { f: '°F', c: '°C' } },
          { section: 'Units', key: 'wind', title: 'Wind speed', value: u.wind, options: ['mph', 'kmh', 'ms'], labels: { mph: 'mph', kmh: 'km/h', ms: 'm/s' } },
          { section: 'Units', key: 'pressure', title: 'Pressure', value: u.pressure, options: ['inhg', 'mb', 'mmhg'], labels: { inhg: 'inHg', mb: 'mb', mmhg: 'mmHg' } },
          { section: 'Units', key: 'rain', title: 'Rainfall', value: u.rain, options: ['in', 'mm'], labels: { in: 'in', mm: 'mm' } },
          { section: 'Units', key: 'distance', title: 'Distance', value: u.distance, options: ['mi', 'km'], labels: { mi: 'mi', km: 'km' } },
          { section: 'Units', key: 'direction', title: 'Wind direction', value: u.direction, options: ['cardinal', 'degrees'], labels: { cardinal: 'Compass', degrees: 'Degrees' } },
        ],
      },
      {
        name: 'Display',
        title: 'Display',
        fields: [
          { section: 'Display', key: 'TimeFormat', title: 'Time format', value: d.TimeFormat, options: ['12 hr', '24 hr'], labels: { '12 hr': '12-hour', '24 hr': '24-hour' } },
          { section: 'Display', key: 'DateFormat', title: 'Date format', value: d.DateFormat, options: ['Mon, 01 Jan 0000', 'Mon, Jan 01 0000', 'Monday, 01 Jan 0000', 'Monday, Jan 01 0000'] },
        ],
      },
      {
        name: 'About',
        title: 'About',
        fields: [
          { section: 'Display', key: 'UpdateNotification', title: 'Update notifications', type: 'toggle', value: d.UpdateNotification },
          { section: 'About', key: 'version', title: 'Version', type: 'info', value: about.version },
          {
            section: 'About', key: 'status', title: 'Updates', type: about.updateAvailable ? 'link' : 'info',
            value: about.updateAvailable ? about.url : 'Up to date',
            label: about.updateAvailable ? `${about.latest} available` : undefined,
          },
          { section: 'About', key: 'repo', title: 'Project', type: 'link', value: about.repoUrl, label: about.repoLabel },
        ],
      },
    ],
  };
}

/** Validate + coerce an incoming unit value against the allowed options. */
export function applyUnitChange(units: Units, key: string, value: string): Units {
  const allowed: Record<string, string[]> = {
    temp: ['f', 'c'],
    wind: ['mph', 'kmh', 'ms'],
    pressure: ['inhg', 'mb', 'mmhg'],
    rain: ['in', 'mm'],
    distance: ['mi', 'km'],
    direction: ['cardinal', 'degrees'],
  };
  if (!(key in allowed) || !allowed[key].includes(value)) return units;
  return { ...units, [key]: value };
}
