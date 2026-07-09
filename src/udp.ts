/**
 * Tempest local UDP listener. The Tempest hub broadcasts JSON on UDP port
 * 50222 to every device on the LAN — live observations with no cloud, token,
 * or account required. We parse the two message types the dashboard needs.
 *
 * Field layout per the WeatherFlow UDP API:
 *   https://weatherflow.github.io/Tempest/api/udp.html
 */

import dgram from 'node:dgram';

export const TEMPEST_UDP_PORT = 50222;

export interface ObsSt {
  type: 'obs_st';
  epoch: number;
  windLull: number;
  windAvg: number;
  windGust: number;
  windDir: number;
  pressure: number; // station pressure, mb
  airTemp: number; // °C
  rh: number; // %
  illuminance: number; // lux
  uv: number; // index
  solarRad: number; // W/m²
  rainLastMin: number; // mm in the previous minute
  precipType: number; // 0 none, 1 rain, 2 hail
  strikeDist: number; // km
  strikeCount: number;
  battery: number; // V
}

export interface RapidWind {
  type: 'rapid_wind';
  epoch: number;
  windSpeed: number; // m/s
  windDir: number; // deg
}

export type TempestMessage = ObsSt | RapidWind;

export function startUdpListener(
  onMessage: (msg: TempestMessage) => void,
  onReady?: (info: { port: number }) => void,
  port = TEMPEST_UDP_PORT,
): dgram.Socket {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (buf) => {
    let json: unknown;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      return; // ignore non-JSON traffic on the port
    }
    const parsed = parse(json);
    if (parsed) onMessage(parsed);
  });

  sock.on('listening', () => onReady?.({ port }));
  sock.on('error', (err) => console.error('[udp] error:', err.message));
  sock.bind(port, '0.0.0.0');
  return sock;
}

function parse(m: any): TempestMessage | null {
  if (m?.type === 'obs_st' && Array.isArray(m.obs?.[0])) {
    const o = m.obs[0] as number[];
    return {
      type: 'obs_st',
      epoch: o[0],
      windLull: o[1],
      windAvg: o[2],
      windGust: o[3],
      windDir: o[4],
      pressure: o[6],
      airTemp: o[7],
      rh: o[8],
      illuminance: o[9],
      uv: o[10],
      solarRad: o[11],
      rainLastMin: o[12],
      precipType: o[13],
      strikeDist: o[14],
      strikeCount: o[15],
      battery: o[16],
    };
  }
  if (m?.type === 'rapid_wind' && Array.isArray(m.ob)) {
    const o = m.ob as number[];
    return { type: 'rapid_wind', epoch: o[0], windSpeed: o[1], windDir: o[2] };
  }
  return null;
}
