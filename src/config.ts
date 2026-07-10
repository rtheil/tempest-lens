/**
 * Configuration: WeatherFlow API token + station id + display units.
 * Read from env vars first, then a gitignored tempest-lens.config.json.
 * The token is a secret and must never be committed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_UNITS, type Units } from './units.js';
import { DEFAULT_DISPLAY, type DisplayPrefs } from './settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(ROOT, 'tempest-lens.config.json');

export interface Config {
  token: string | null;
  stationId: number | null;
  units: Units;
  display: DisplayPrefs;
}

export function loadConfig(): Config {
  const file = readFile();
  const token = process.env.WEATHERFLOW_TOKEN ?? file.token ?? null;
  const stationId = process.env.WEATHERFLOW_STATION_ID
    ? Number(process.env.WEATHERFLOW_STATION_ID)
    : file.stationId ?? null;
  const units: Units = { ...DEFAULT_UNITS, ...(file.units ?? {}) };
  const rawDisplay: any = { ...(file.display ?? {}) };
  // Migration: the light/dark setting was renamed Theme -> Mode. Carry an old
  // config's value over so upgrades keep the user's choice.
  if (rawDisplay.Theme != null && rawDisplay.Mode == null) rawDisplay.Mode = rawDisplay.Theme;
  delete rawDisplay.Theme;
  const display: DisplayPrefs = { ...DEFAULT_DISPLAY, ...rawDisplay };
  return { token, stationId, units, display };
}

/** Persist units + display to the config file, preserving token/stationId. */
export function saveSettings(units: Units, display: DisplayPrefs): void {
  const file = readFile();
  file.units = units;
  file.display = display;
  write(file);
}

/** Persist the Tempest token + station id (from the first-run setup or the
 *  Settings→Station editor), preserving units/display. */
export function saveCredentials(token: string, stationId: number): void {
  const file = readFile();
  file.token = token;
  file.stationId = stationId;
  write(file);
}

function write(file: object): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  } catch (err) {
    console.error('[config] failed to write tempest-lens.config.json:', err);
  }
}

function readFile(): {
  token?: string;
  stationId?: number;
  units?: Partial<Units>;
  display?: Partial<DisplayPrefs>;
} {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[config] failed to read tempest-lens.config.json:', err);
    return {};
  }
}
