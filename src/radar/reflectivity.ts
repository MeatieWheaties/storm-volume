import * as THREE from 'three';

/** Baked voxel encoding (see scripts/bake-radar.mjs): 0 = no echo, else dBZ = value / 2 − 32. */
export const dbzToValue = (dbz: number) => Math.min(255, Math.max(0, (dbz + 32) * 2));
export const valueToDbz = (value: number) => value / 2 - 32;

/** NWS-style reflectivity colours. */
const COLOR_STOPS: Array<[number, string]> = [
  [5, '#04e9e7'],
  [10, '#019ff4'],
  [15, '#0300f4'],
  [20, '#02fd02'],
  [25, '#01c501'],
  [30, '#008e00'],
  [35, '#fdf802'],
  [40, '#e5bc00'],
  [45, '#fd9500'],
  [50, '#fd0000'],
  [55, '#d40000'],
  [60, '#bc0000'],
  [65, '#f800fd'],
  [70, '#9854c6'],
  [75, '#fdfdfd'],
];

/** Opacity per 0.5 km of path. Light rain stays a haze; cores and hail read as solid. */
const ALPHA_STOPS: Array<[number, number]> = [
  [5, 0],
  [20, 0.003],
  [30, 0.012],
  [40, 0.07],
  [50, 0.3],
  [60, 0.65],
  [70, 0.9],
];

function interpolate<T>(stops: Array<[number, T]>, x: number, lerp: (a: T, b: T, t: number) => T): T {
  if (x <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [x0, a] = stops[i - 1];
      const [x1, b] = stops[i];
      return lerp(a, b, (x - x0) / (x1 - x0));
    }
  }
  return stops[stops.length - 1][1];
}

const colorStops = COLOR_STOPS.map(([d, c]) => [d, new THREE.Color(c)] as [number, THREE.Color]);
const lerpColor = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);
const lerpNumber = (a: number, b: number, t: number) => a + (b - a) * t;

export function reflectivityColor(dbz: number): THREE.Color {
  return interpolate(colorStops, dbz, lerpColor);
}

/** 256×1 RGBA lookup indexed by the raw voxel value (so the shader needs no dBZ conversion). */
export function createTransferTexture(): THREE.DataTexture {
  const data = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v++) {
    const dbz = valueToDbz(v);
    const c = reflectivityColor(dbz);
    const a = v === 0 ? 0 : interpolate(ALPHA_STOPS, dbz, lerpNumber);
    data.set([c.r * 255, c.g * 255, c.b * 255, a * 255], v * 4);
  }
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Paints a horizontal dBZ legend into a canvas. */
export function drawLegend(canvas: HTMLCanvasElement, minDbz = 5, maxDbz = 75) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  for (let x = 0; x < width; x++) {
    const dbz = minDbz + ((maxDbz - minDbz) * x) / (width - 1);
    ctx.fillStyle = `#${reflectivityColor(dbz).getHexString()}`;
    ctx.fillRect(x, 0, 1, height);
  }
}
