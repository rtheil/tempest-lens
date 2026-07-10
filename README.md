# TempestLens

A modern, self-hosted dashboard for the [WeatherFlow Tempest](https://weatherflow.com/tempest-weather-system/) weather station. Runs anywhere Node runs — and great as a Raspberry Pi wall kiosk.

> **Status: early, active development.** Unofficial project, not affiliated with WeatherFlow.

## Why

Setting up the old Kivy console meant hunting down an API token, a station ID, a device ID, and a third‑party forecast key. TempestLens needs **one thing**: your Tempest **personal access token**. Everything else — station ID, device ID, elevation, timezone, coordinates — is discovered automatically, and the forecast comes from WeatherFlow's own BetterForecast (no third‑party key). If you only want live data, even the token is optional: the dashboard reads your hub's **local UDP broadcast** with zero configuration.

## Features

- **Live local data** over the Tempest UDP broadcast (port 50222) — no cloud, no account required for real‑time obs.
- **Full weather picture** via the WeatherFlow REST API: today's high/low with times, 24‑hour trend, 3‑hour trend, daily pressure min/max, rain accumulations (today / yesterday / month / year), lightning (last 3 h / today / this month), peak‑sun hours.
- **5‑day forecast**, sunrise/sunset, and moon phase with moonrise/moonset.
- **First‑run setup in the browser** — paste your token, it finds your station, done.
- **Settings** — units (temperature, wind, pressure, rain, distance, wind direction), time/date format, update notifications.
- Responsive dark UI designed for 1280×800 and 800×480 touchscreens.

## Requirements

- **Node.js 18+**
- A **WeatherFlow Tempest** on the same LAN (for live UDP data)
- A **Tempest personal access token** for forecast + history — create one at [tempestwx.com → Settings → Tokens](https://tempestwx.com/settings/tokens)

## Quick start

```bash
git clone https://github.com/rtheil/tempest-lens.git
cd tempest-lens
npm install
npm run build
npm start            # or: npm run dev  (auto-reload while developing)
```

Open **http://localhost:8000**, paste your token on the setup screen, and you're live. (Set `PORT` to change the port.)

## Configuration

Config lives in **`tempest-lens.config.json`** at the project root. You can fill it via the setup screen, the in‑app Settings drawer, or by editing the file directly — all three write the same file:

```jsonc
{
  "token": "your-tempest-token",   // required for forecast + history
  "stationId": 12345,               // auto-discovered from the token
  "units": {
    "temp": "f", "wind": "mph", "pressure": "inhg",
    "rain": "in", "distance": "mi", "direction": "cardinal"
  },
  "display": { "TimeFormat": "12 hr", "DateFormat": "Mon, Jan 01 0000" }
}
```

Environment overrides: `WEATHERFLOW_TOKEN`, `WEATHERFLOW_STATION_ID`, `PORT`.

> The config file holds your token — it's git‑ignored. Don't commit it.

## Raspberry Pi kiosk (one‑line install)

On a Raspberry Pi running Pi OS with a desktop, install everything — Node, the app, a systemd service, and a fullscreen Chromium kiosk — with:

```bash
curl -fsSL https://raw.githubusercontent.com/rtheil/tempest-lens/main/scripts/install-pi.sh | bash
```

Then, from any device on your network, open **http://<your-pi>.local:8000** and paste your token. The kiosk reboots into the dashboard automatically. See [`scripts/install-pi.sh`](scripts/install-pi.sh) for what it does and how to customize it.

The installer **enables desktop auto-login by default** so the kiosk launches unattended on boot. Anyone who can power on the Pi then lands in the desktop session — to skip it (and log in manually), run:

```bash
curl -fsSL https://raw.githubusercontent.com/rtheil/tempest-lens/main/scripts/install-pi.sh | AUTOLOGIN=0 bash
```

Other overrides: `PORT`, `BRANCH`, `APP_DIR`.

## Updating

- **Manual / dev:** `git pull && npm install && npm run build` then restart.
- **Pi:** re‑run the installer, or `cd ~/tempest-lens && git pull && npm install && npm run build && sudo systemctl restart tempest-lens`.
- The dashboard shows an update badge when a newer GitHub release is available (toggle it under Settings → About).

## How it works

```
Tempest hub ──UDP:50222──▶  TempestLens (Node/TS)  ──WS + /api/snapshot──▶  browser dashboard
WeatherFlow REST ──────────▶  (station, forecast, history backfill)
```

A small Node service listens to the hub's UDP broadcast for live observations and backfills the derived + historical fields from the WeatherFlow REST API. It serves a vanilla‑JS dashboard over a WebSocket (plus a REST fallback), pushing a new snapshot only when data changes.

## Project layout

```
src/
  index.ts     entry — wires UDP + REST into the store, serves the app, setup/settings
  udp.ts       Tempest UDP listener + parsing
  rest.ts      WeatherFlow REST (stations, station obs, device history, forecast, releases)
  station.ts   maps a station observation to the dashboard fields
  derived.ts   sea-level pressure, feels-like
  astro.ts     moon phase + moonrise/moonset
  units.ts     unit conversions
  settings.ts  settings schema + About
  config.ts    load/save tempest-lens.config.json
  state.ts     snapshot store
  server.ts    HTTP static + REST + WebSocket
  types.ts     the snapshot contract
web/           the dashboard frontend
fonts/         bundled Inter fonts
scripts/       install / deployment helpers
```

## Credits

TempestLens was inspired by [**WeatherFlow PiConsole**](https://github.com/peted-davis/WeatherFlow_PiConsole) by Peter Davis — a superb Raspberry Pi console for the Tempest. The original project is where this one's derived‑variable math and WeatherFlow API usage (station/device observations, history buckets, BetterForecast) were first worked out, and those served as the reference while porting the data pipeline to Node/TypeScript. Huge thanks to that project and its community.

## License

MIT
