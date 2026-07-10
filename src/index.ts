/**
 * tempest-lens — entry point.
 * Wires the Tempest UDP listener + WeatherFlow REST into the state store,
 * serves the dashboard, and handles first-run setup + settings changes.
 *
 * The REST backfill starts as soon as a token + station are known — either
 * from the config file at boot, or from the first-run setup screen at runtime.
 */

import os from 'node:os';
import { exec } from 'node:child_process';
import QRCode from 'qrcode';
import { loadConfig, saveSettings, saveCredentials } from './config.js';
import { State, VERSION, REPO, REPO_URL } from './state.js';
import { startUdpListener, TEMPEST_UDP_PORT } from './udp.js';
import { startServer, type ServerHooks } from './server.js';
import { buildSchema, applyUnitChange } from './settings.js';
import {
  fetchStation,
  fetchStations,
  fetchStationObs,
  fetchForecast,
  fetchTodayHighLow,
  fetchTempAgo,
  fetchHistory,
  fetchLatestRelease,
} from './rest.js';

const HTTP_PORT = Number(process.env.PORT ?? 8000);
const cfg = loadConfig();
const state = new State(cfg.units, cfg.display);

// Reachable addresses, shown on the setup screen so a keyboard-less kiosk can
// point the user to open it from a phone/computer on the same network.
function lanIPv4(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '';
}
const accessInfo = {
  host: `${os.hostname()}.local:${HTTP_PORT}`,
  ip: lanIPv4() ? `${lanIPv4()}:${HTTP_PORT}` : '',
  qr: '',
};
state.setAccess(accessInfo);
// Generate a QR to the IP URL (more phone-friendly than mDNS) so a kiosk user
// can scan straight to the setup page and paste their token from their phone.
{
  const target = accessInfo.ip || accessInfo.host;
  if (target) {
    QRCode.toDataURL(`http://${target}`, { margin: 1, width: 260 })
      .then((qr) => state.setAccess({ ...accessInfo, qr }))
      .catch((err) => console.error('[tempest-lens] QR generation failed:', (err as Error).message));
  }
}

// Live credentials — mutable so first-run setup / Settings can update them
// without a restart. The REST refreshers read the latest values each tick.
const creds: { token: string | null; stationId: number | null } = {
  token: cfg.token,
  stationId: cfg.stationId,
};
let backfillStarted = false;

const warn = (what: string, err: unknown) =>
  console.error(`[tempest-lens] ${what} failed:`, (err as Error).message);

// --------------------------------------------------------------------------- //
// Live data                                                                   //
// --------------------------------------------------------------------------- //
startUdpListener(
  (msg) => {
    if (msg.type === 'obs_st') state.applyObsSt(msg);
    else if (msg.type === 'rapid_wind') state.applyRapidWind(msg);
  },
  ({ port }) => console.log(`[tempest-lens] listening for Tempest UDP broadcasts on :${port}`),
);

let refreshForecast = async (): Promise<void> => {};
let refreshStationObs = async (): Promise<void> => {};
let refreshHistory = async (): Promise<void> => {};

/** Start the REST backfill loops once (idempotent). Refreshers read `creds`
 *  each call, so a later credential change takes effect on the next tick. */
function startBackfill(): void {
  if (backfillStarted || !creds.token || !creds.stationId) return;
  backfillStarted = true;
  const token = () => creds.token as string;
  const stationId = () => creds.stationId as number;

  refreshForecast = async () => {
    try {
      const f = await fetchForecast(token(), stationId(), state.currentUnits, state.timezone);
      if (f) state.setForecast(f);
    } catch (err) {
      warn('forecast fetch', err);
    }
  };
  refreshStationObs = async () => {
    try {
      const o = await fetchStationObs(token(), stationId());
      if (o) state.setStationObs(o);
    } catch (err) {
      warn('station obs fetch', err);
    }
  };
  refreshHistory = async () => {
    const { id, type } = state.device;
    if (!id || !type) return;
    const nowS = Math.floor(Date.now() / 1000);
    try {
      state.setHighLow(await fetchTodayHighLow(token(), id, type, nowS, state.timezone, state.elevation));
    } catch (err) {
      warn('today high/low fetch', err);
    }
    try {
      state.setTemp24hAgo(await fetchTempAgo(token(), id, type, nowS, 24 * 3600));
    } catch (err) {
      warn('24h history fetch', err);
    }
    try {
      state.setTemp3hAgo(await fetchTempAgo(token(), id, type, nowS, 3 * 3600));
    } catch (err) {
      warn('3h history fetch', err);
    }
    try {
      state.setHistory(await fetchHistory(token(), id, type, nowS, state.timezone));
    } catch (err) {
      warn('rain/lightning history fetch', err);
    }
  };

  void bootBackfillUntilReady();
  setInterval(refreshForecast, 30 * 60 * 1000); // forecast: 30 min
  setInterval(refreshStationObs, 60 * 1000); // derived/accumulated: 1 min
  setInterval(refreshHistory, 5 * 60 * 1000); // daily high/low + 24h + rain/lightning: 5 min
  console.log('[tempest-lens] REST backfill active (station obs, history, forecast).');
}

// The boot backfill can hit a not-yet-ready network (esp. right after a Pi
// reboot). fetchStation isn't on an interval and the forecast interval is 30m,
// so a failed boot would leave the dashboard half-empty for a long time. Retry
// the full backfill with a short backoff until station metadata loads.
const BACKFILL_BACKOFF_S = [10, 20, 30, 60, 120];
let backfillRetry = 0;
async function bootBackfillUntilReady(): Promise<void> {
  if (await refreshAll(backfillRetry === 0)) return;
  const wait = BACKFILL_BACKOFF_S[Math.min(backfillRetry++, BACKFILL_BACKOFF_S.length - 1)];
  console.warn(`[tempest-lens] backfill not ready (network?) — retrying in ${wait}s`);
  setTimeout(() => void bootBackfillUntilReady(), wait * 1000);
}

/** Re-fetch station metadata (name/elevation/device) then everything else.
 *  Returns true once station metadata has loaded (the readiness signal). */
async function refreshAll(logStation = false): Promise<boolean> {
  let stationOk = false;
  try {
    const info = await fetchStation(creds.token as string, creds.stationId as number);
    if (info) {
      state.setStation(info);
      stationOk = true;
      if (logStation) {
        console.log(
          `[tempest-lens] station: ${info.name} — ${info.elevationM}m, ${info.timezone}, ` +
            `device ${info.deviceType} ${info.deviceId}`,
        );
      }
    }
  } catch (err) {
    warn('station fetch', err);
  }
  await Promise.all([refreshForecast(), refreshStationObs(), refreshHistory()]);
  return stationOk;
}

/** Apply new credentials from setup / settings: persist, (re)start backfill. */
async function applyCredentials(token: string, stationId: number): Promise<void> {
  creds.token = token;
  creds.stationId = stationId;
  saveCredentials(token, stationId);
  state.setConfigured(true);
  if (!backfillStarted) startBackfill();
  else await refreshAll();
  console.log(`[tempest-lens] credentials applied (station ${stationId}).`);
}

// --------------------------------------------------------------------------- //
// Self-update: pull the release, rebuild, then exit so systemd relaunches on    //
// the new code (the unit is Restart=always). No privilege needed — we never     //
// call systemctl; we just replace dist/ and let the service restart itself.     //
// --------------------------------------------------------------------------- //
function sh(cmd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // Prepend /usr/local/bin so the systemd service (minimal PATH) finds the
    // node/npm symlinks the Pi installer created.
    const env = { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` };
    exec(cmd, { cwd: process.cwd(), env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as any).code ?? 1 : 0, out: `${stdout}${stderr}` });
    });
  });
}

let updating = false;
async function runUpdate(): Promise<{ ok: boolean; error?: string; log?: string }> {
  if (!state.update.available) return { ok: false, error: 'already up to date' };
  if (updating) return { ok: false, error: 'update already in progress' };
  updating = true;
  const steps = [
    'git fetch --depth 1 origin',
    'git reset --hard @{u}',
    'npm install --no-audit --no-fund',
    'npm run build',
  ];
  let log = '';
  for (const cmd of steps) {
    console.log(`[tempest-lens] update: ${cmd}`);
    const { code, out } = await sh(cmd);
    log += `$ ${cmd}\n${out}\n`;
    if (code !== 0) {
      updating = false;
      console.error(`[tempest-lens] update step failed (${code}): ${cmd}`);
      return { ok: false, error: `\`${cmd}\` failed`, log };
    }
  }
  console.log('[tempest-lens] update complete — restarting to load the new build.');
  // Let the HTTP response flush before we exit; systemd (Restart=always) relaunches.
  setTimeout(() => process.exit(0), 1000);
  return { ok: true, log };
}

// --------------------------------------------------------------------------- //
// Power actions. reboot/shutdown need root — granted via a NOPASSWD sudoers    //
// rule the Pi installer writes (/etc/sudoers.d/tempest-lens). 'exit' just      //
// closes the kiosk browser (drops to the desktop); no privilege needed.        //
// --------------------------------------------------------------------------- //
async function runSystem(action: string): Promise<{ ok: boolean; error?: string }> {
  let cmd: string;
  if (action === 'reboot') cmd = 'sudo -n systemctl reboot';
  else if (action === 'shutdown') cmd = 'sudo -n systemctl poweroff';
  else if (action === 'exit') cmd = 'pkill -f chromium';
  else return { ok: false, error: 'unknown action' };
  console.log(`[tempest-lens] system action: ${action}`);
  const { code, out } = await sh(cmd); // systemctl returns 0 immediately, then the box goes down
  if (code !== 0) return { ok: false, error: out.trim().slice(0, 200) || `\`${cmd}\` failed` };
  return { ok: true };
}

// --------------------------------------------------------------------------- //
// Server + settings/setup hooks                                               //
// --------------------------------------------------------------------------- //
const hooks: ServerHooks = {
  getConfig: () =>
    buildSchema(state.currentUnits, state.displayPrefs, {
      version: VERSION,
      updateAvailable: state.update.available,
      latest: state.update.latest,
      url: state.update.url || REPO_URL,
      repoUrl: REPO_URL,
      repoLabel: REPO_URL.replace(/^https?:\/\//, ''),
    }),
  setConfig: (section, key, value) => {
    if (section === 'Units') {
      const units = applyUnitChange(state.currentUnits, key, value);
      state.setUnits(units);
      saveSettings(units, state.displayPrefs);
      if (key === 'temp') void refreshForecast();
      console.log(`[tempest-lens] units.${key} -> ${value}`);
    } else if (section === 'Display') {
      const display = { ...state.displayPrefs, [key]: value };
      state.setDisplay(display);
      saveSettings(state.currentUnits, display);
      console.log(`[tempest-lens] display.${key} -> ${value}`);
    }
  },
  setup: async (token, stationId) => {
    const stations = await fetchStations(token); // throws on invalid token
    if (!stations.length) return { ok: false };
    if (stationId != null) {
      await applyCredentials(token, stationId);
      return { ok: true, stations };
    }
    if (stations.length === 1) {
      await applyCredentials(token, stations[0].id);
      return { ok: true, stations };
    }
    return { ok: true, stations }; // caller must pick, then POST with stationId
  },
  update: runUpdate,
  system: runSystem,
};

startServer(state, HTTP_PORT, '0.0.0.0', hooks);

// --------------------------------------------------------------------------- //
// Update check (no token needed; dormant until releases exist)                //
// --------------------------------------------------------------------------- //
const checkUpdate = async (): Promise<boolean> => {
  try {
    const rel = await fetchLatestRelease(REPO); // null == 404 (no releases yet); still a success
    const latest = rel ? rel.tag.replace(/^v/, '') : '';
    state.setUpdate({
      available: !!latest && latest !== VERSION,
      latest: rel?.tag ?? '',
      url: rel?.url ?? REPO_URL,
      notes: rel?.body ?? '',
    });
    return true;
  } catch (err) {
    warn('update check', err);
    return false;
  }
};

// At boot the network is often not ready yet (a bare `network-online.target`
// isn't enough on the Pi), so the first check can fail and would otherwise
// leave us blind for 6h. Retry with a short backoff until the first success,
// then settle into the 6-hour interval.
const RETRY_BACKOFF_S = [15, 30, 60, 120, 300];
let updateRetry = 0;
async function checkUpdateUntilFirstSuccess(): Promise<void> {
  if (await checkUpdate()) {
    setInterval(checkUpdate, 6 * 60 * 60 * 1000);
    return;
  }
  const wait = RETRY_BACKOFF_S[Math.min(updateRetry++, RETRY_BACKOFF_S.length - 1)];
  console.warn(`[tempest-lens] update check failed — retrying in ${wait}s`);
  setTimeout(() => void checkUpdateUntilFirstSuccess(), wait * 1000);
}
void checkUpdateUntilFirstSuccess();

// --------------------------------------------------------------------------- //
// Boot                                                                        //
// --------------------------------------------------------------------------- //
if (creds.token && creds.stationId) {
  state.setConfigured(true);
  startBackfill();
} else {
  console.warn('[tempest-lens] no token configured — first-run setup required (UDP live only).');
}

console.log(
  `[tempest-lens] up. Open http://localhost:${HTTP_PORT} — ` +
    `UDP on :${TEMPEST_UDP_PORT} (same LAN as the hub).`,
);
