# TempestLens

An unofficial, self-hosted dashboard for the [WeatherFlow Tempest](https://weatherflow.com/tempest-weather-system/) weather station. Runs great as a Raspberry Pi kiosk.

> **Status: early proof-of-concept.** A TypeScript/Node service reads the Tempest's local UDP broadcast and serves a modern browser dashboard. This is the start of a full rewrite of a Kivy/Python console into a standalone, web-first, Node project — no Python, no cloud account required for live data.

## How it works

The Tempest hub broadcasts observations as JSON over **UDP port 50222** to every device on your LAN — no token, no account, no cloud round-trip. This service listens for those packets, builds a snapshot, and serves it to a vanilla-JS dashboard over WebSocket + REST.

```
Tempest hub  ──UDP:50222──▶  tempest-lens (Node/TS)  ──WS + /api/snapshot──▶  browser dashboard
```

## Quick start

```bash
npm install
npm run dev            # tsx watch — live reload on source changes
# open http://localhost:8000
```

Production-style run:

```bash
npm run build          # tsc -> dist/
npm start
```

The machine you run this on **must be on the same LAN/subnet as the Tempest hub** to receive its UDP broadcasts. Set `PORT` to change the HTTP port (default `8000`).

## What's implemented (PoC scope)

Live from UDP: outdoor temp, dew point, humidity, wind (speed/direction/gust/avg), UV, solar radiation, rain rate, and station pressure.

**Not yet** (next phase — port from the Python console's derived variables):
- Feels-like, **true sea-level pressure** (the gauge currently shows raw *station* pressure, which reads low at altitude), daily high/low, rain/lightning accumulations, pressure/temperature trends.
- Astronomy (sun/moon) and the 5-day forecast (BetterForecast REST).
- Settings write-path and system power actions.

The frontend in `web/` is carried over from the original project and still shows its temporary build-stamp/auto-reload scaffolding; that will be cleaned up as the rewrite matures.

## Layout

```
src/
  index.ts    entry — wires UDP -> state -> server
  udp.ts      Tempest UDP listener + message parsing
  state.ts    snapshot store (applies messages, emits the contract)
  units.ts    SI -> display-unit conversions
  server.ts   HTTP static + REST + WebSocket
  types.ts    the snapshot contract (shared shape the frontend consumes)
web/          the dashboard frontend
fonts/        bundled Inter fonts
```

## License

MIT
