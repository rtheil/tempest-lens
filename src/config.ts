/**
 * Configuration: WeatherFlow API token + station id + display units.
 * Read from env vars first, then a gitignored tempest-lens.config.json.
 * The token is a secret and must never be committed.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_UNITS, type Units } from './units.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export interface Config {
  token: string | null;
  stationId: number | null;
  units: Units;
}

export function loadConfig(): Config {
  let file: { token?: string; stationId?: number; units?: Partial<Units> } = {};
  const p = path.join(ROOT, 'tempest-lens.config.json');
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      console.error('[config] failed to read tempest-lens.config.json:', err);
    }
  }
  const token = process.env.WEATHERFLOW_TOKEN ?? file.token ?? null;
  const stationId = process.env.WEATHERFLOW_STATION_ID
    ? Number(process.env.WEATHERFLOW_STATION_ID)
    : file.stationId ?? null;
  const units: Units = { ...DEFAULT_UNITS, ...(file.units ?? {}) };
  return { token, stationId, units };
}
