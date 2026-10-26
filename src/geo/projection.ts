import { ORIGIN, type LonLat } from '../config';

// Local Web Mercator projection, rescaled by cos(origin latitude) so that one
// scene unit is ~1 km of ground distance near the origin. Using Mercator keeps
// terrain tile edges axis-aligned in scene space.

const EARTH_RADIUS_M = 6378137;
const DEG = Math.PI / 180;
const SCALE_KM = Math.cos(ORIGIN.lat * DEG) / 1000;

export const mercatorX = (lon: number) => EARTH_RADIUS_M * lon * DEG;
export const mercatorY = (lat: number) =>
  EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));

const ORIGIN_MX = mercatorX(ORIGIN.lon);
const ORIGIN_MY = mercatorY(ORIGIN.lat);

/** Mercator metres → scene km (x east, z south). */
export function mercatorToScene(mx: number, my: number): { x: number; z: number } {
  return { x: (mx - ORIGIN_MX) * SCALE_KM, z: -(my - ORIGIN_MY) * SCALE_KM };
}

export function lonLatToScene({ lon, lat }: LonLat): { x: number; z: number } {
  return mercatorToScene(mercatorX(lon), mercatorY(lat));
}

/** Slippy-map tile containing a lon/lat at zoom z. */
export function tileForLonLat({ lon, lat }: LonLat, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = lat * DEG;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Scene-space rectangle covered by a slippy-map tile. */
export function tileSceneBounds(z: number, x: number, y: number) {
  const world = 2 * Math.PI * EARTH_RADIUS_M;
  const size = world / 2 ** z;
  const minMx = -world / 2 + x * size;
  const maxMy = world / 2 - y * size;
  const nw = mercatorToScene(minMx, maxMy);
  const se = mercatorToScene(minMx + size, maxMy - size);
  return { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z };
}
