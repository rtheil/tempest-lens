/**
 * tempest-lens — entry point.
 * Wires the Tempest UDP listener + WeatherFlow REST (station metadata, station
 * observations, device history, forecast) into the state store and serves the
 * dashboard.
 */

import { loadConfig } from './config.js';
import { State } from './state.js';
import { startUdpListener, TEMPEST_UDP_PORT } from './udp.js';
import { startServer } from './server.js';
import {
  fetchStation,
  fetchStationObs,
  fetchForecast,
  fetchTodayHighLow,
  fetchTempAgo,
  fetchHistory,
} from './rest.js';

const HTTP_PORT = Number(process.env.PORT ?? 8000);
const cfg = loadConfig();
const state = new State(cfg.units);

startUdpListener(
  (msg) => {
    if (msg.type === 'obs_st') state.applyObsSt(msg);
    else if (msg.type === 'rapid_wind') state.applyRapidWind(msg);
  },
  ({ port }) => console.log(`[tempest-lens] listening for Tempest UDP broadcasts on :${port}`),
);

startServer(state, HTTP_PORT);

if (cfg.token && cfg.stationId) {
  const token = cfg.token;
  const stationId = cfg.stationId;
  const warn = (what: string, err: unknown) =>
    console.error(`[tempest-lens] ${what} failed:`, (err as Error).message);

  const refreshForecast = async () => {
    try {
      const f = await fetchForecast(token, stationId, cfg.units, state.timezone);
      if (f) state.setForecast(f);
    } catch (err) {
      warn('forecast fetch', err);
    }
  };

  const refreshStationObs = async () => {
    try {
      const o = await fetchStationObs(token, stationId);
      if (o) state.setStationObs(o);
    } catch (err) {
      warn('station obs fetch', err);
    }
  };

  const refreshHistory = async () => {
    const { id, type } = state.device;
    if (!id || !type) return;
    const nowS = Math.floor(Date.now() / 1000);
    try {
      state.setHighLow(await fetchTodayHighLow(token, id, type, nowS, state.timezone, state.elevation));
    } catch (err) {
      warn('today high/low fetch', err);
    }
    try {
      state.setTemp24hAgo(await fetchTempAgo(token, id, type, nowS, 24 * 3600));
    } catch (err) {
      warn('24h history fetch', err);
    }
    try {
      state.setTemp3hAgo(await fetchTempAgo(token, id, type, nowS, 3 * 3600));
    } catch (err) {
      warn('3h history fetch', err);
    }
    try {
      state.setHistory(await fetchHistory(token, id, type, nowS, state.timezone));
    } catch (err) {
      warn('rain/lightning history fetch', err);
    }
  };

  void (async () => {
    try {
      const info = await fetchStation(token, stationId);
      if (info) {
        state.setStation(info);
        console.log(
          `[tempest-lens] station: ${info.name} — ${info.elevationM}m, ${info.timezone}, ` +
            `device ${info.deviceType} ${info.deviceId}`,
        );
      }
    } catch (err) {
      warn('station fetch', err);
    }
    await Promise.all([refreshForecast(), refreshStationObs(), refreshHistory()]);
    setInterval(refreshForecast, 30 * 60 * 1000); // forecast: 30 min
    setInterval(refreshStationObs, 60 * 1000); // derived/accumulated: 1 min
    setInterval(refreshHistory, 5 * 60 * 1000); // daily high/low + 24h: 5 min
    console.log('[tempest-lens] REST backfill active (station obs, history, forecast).');
  })();
} else {
  console.warn('[tempest-lens] no token/stationId configured — UDP-only (no forecast/history).');
}

console.log(
  `[tempest-lens] up. Open http://localhost:${HTTP_PORT} — ` +
    `UDP on :${TEMPEST_UDP_PORT} (same LAN as the hub).`,
);
