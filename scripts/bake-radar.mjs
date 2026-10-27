// Bakes downloaded NEXRAD Level II volumes into compact Cartesian reflectivity
// grids the viewer can upload straight into a 3D texture.
//
//   node scripts/bake-radar.mjs [--station KTLX] [--date 2013-05-20]
//
// Output (public/data/radar/):
//   index.json          grid metadata + list of frames
//   <frame>.bin.gz      gzipped Uint8 voxels, x fastest, then z (north→south), then y (up)
//                       value 0 = no echo, else dBZ = value / 2 − 32
//
// Gridding is done voxel → polar: each voxel centre is converted to (azimuth,
// slant range, elevation angle) with the standard 4/3 effective-earth-radius
// beam model, sampled on the tilts directly below and above it, and linearly
// interpolated in elevation angle. Every voxel inside radar coverage gets a
// value, so there are no rings or holes where tilts are sparse at long range
// (forward-binning gates leaves both).
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { parseArgs, PUBLIC_DATA_DIR, RAW_DIR, writeOut } from './lib/cli.mjs';

const require = createRequire(import.meta.url);
const { Level2Radar } = require('nexrad-level-2-data');

const args = parseArgs({ station: 'KTLX', date: '2013-05-20' });

/** Grid centred on the radar (scene origin). Units: km. */
const GRID = {
  nx: 256,
  nz: 256,
  ny: 40,
  halfWidthKm: 120,
  topKm: 20,
};
const MIN_DBZ = 5;
/** WSR-88D half-power beamwidth is ~0.95°; echoes extend half a beam beyond a tilt's centreline. */
const HALF_BEAM_DEG = 0.5;
/** Tilts closer than this are the same cut (split-cut surveillance/Doppler pairs, SAILS repeats). */
const SAME_TILT_DEG = 0.15;
const AZ_BINS = 720;
/** Horizontal voxel size; radar samples are averaged over this footprint. */
const CELL_KM = (2 * GRID.halfWidthKm) / GRID.nx;
/** Caps the azimuth averaging right next to the radar, where one voxel spans many degrees. */
const MAX_AZ_FOOTPRINT_DEG = 6;
const EFFECTIVE_EARTH_RADIUS_KM = (4 / 3) * 6371;
const DEG = Math.PI / 180;

const [yyyy, mm, dd] = args.date.split('-');
const inDir = resolve(RAW_DIR, 'nexrad', yyyy, mm, dd, args.station);
const outDir = resolve(PUBLIC_DATA_DIR, 'radar');

const files = (await readdir(inDir)).filter((f) => /_V\d+(\.gz)?$/.test(f)).sort();
if (files.length === 0) {
  console.error(`No raw volumes in ${inDir}. Run \`npm run data:nexrad\` first.`);
  process.exit(1);
}

const frames = [];
for (const file of files) {
  const t0 = performance.now();
  const radar = new Level2Radar(await readFile(resolve(inDir, file)), { logger: false });
  const { tilts, site } = readTilts(radar);
  const { voxels, echoes } = gridVolume(tilts, site);
  const id = file.replace(/(_V\d+)?(\.gz)?$/, '');
  // Mostly empty air, so gzip shrinks frames ~10×; the viewer inflates them with DecompressionStream.
  const compressed = gzipSync(voxels, { level: 9 });
  await writeOut(resolve(outDir, `${id}.bin.gz`), compressed);

  const time = /(\d{8})_(\d{6})/.exec(file);
  frames.push({
    id,
    file: `${id}.bin.gz`,
    timeUtc: `${time[1].slice(0, 4)}-${time[1].slice(4, 6)}-${time[1].slice(6)}T${time[2].slice(0, 2)}:${time[2].slice(2, 4)}:${time[2].slice(4)}Z`,
    tilts: tilts.map((t) => Math.round(t.elevationDeg * 100) / 100),
  });
  console.log(
    `  ${id}: ${(compressed.length / 1e3).toFixed(0)} kB, ${tilts.length} tilts, ${(echoes / 1e3).toFixed(0)}k echo voxels, ` +
      `site ${site.lat.toFixed(4)},${site.lon.toFixed(4)} — ${(performance.now() - t0).toFixed(0)} ms`,
  );
}

await writeOut(
  resolve(outDir, 'index.json'),
  JSON.stringify(
    {
      station: args.station,
      date: args.date,
      encoding: { type: 'uint8', noData: 0, dbz: 'value / 2 - 32' },
      dims: { x: GRID.nx, y: GRID.ny, z: GRID.nz },
      // Scene-space box (km): x east, z south, y up (above sea level).
      bounds: {
        x0: -GRID.halfWidthKm,
        x1: GRID.halfWidthKm,
        z0: -GRID.halfWidthKm,
        z1: GRID.halfWidthKm,
        y0: 0,
        y1: GRID.topKm,
      },
      frames,
    },
    null,
    2,
  ),
);
console.log(`Baked ${frames.length} frames → ${outDir}`);

/**
 * Collects reflectivity tilts sorted by elevation angle, each with an
 * azimuth → radial lookup so sampling is O(1). Duplicate cuts keep the one
 * reaching furthest (split-cut surveillance scans carry the long-range data).
 */
function readTilts(radar) {
  let site = null;
  const tilts = [];
  for (const elevation of radar.listElevations()) {
    radar.setElevation(elevation);
    const records = radar.getHeader().filter((r) => r.reflect);
    if (records.length === 0) continue; // Doppler-only cut

    const v = records[0].volume;
    site ??= v
      ? { lat: v.latitude, lon: v.longitude, heightKm: v.elevation / 1000 }
      : { lat: NaN, lon: NaN, heightKm: 0.37 };

    const elevationDeg = records.reduce((s, r) => s + r.elevation_angle, 0) / records.length;
    const radials = records.map((r) => ({
      firstGate: r.reflect.first_gate,
      gateSize: r.reflect.gate_size,
      data: smoothAlongRange(r.reflect.moment_data, Math.round(CELL_KM / r.reflect.gate_size)),
    }));
    const tilt = {
      elevationDeg,
      radials,
      azIndex: buildAzimuthIndex(records.map((r) => r.azimuth)),
      maxRangeKm: Math.max(...radials.map((r) => r.firstGate + r.data.length * r.gateSize)),
    };

    const dup = tilts.findIndex((t) => Math.abs(t.elevationDeg - elevationDeg) < SAME_TILT_DEG);
    if (dup < 0) tilts.push(tilt);
    else if (tilt.maxRangeKm > tilts[dup].maxRangeKm) tilts[dup] = tilt;
  }
  tilts.sort((a, b) => a.elevationDeg - b.elevationDeg);
  return { tilts, site };
}

/** Maps each 0.5° azimuth bin to the radial whose centre is nearest. Handles 1° legacy radials too. */
function buildAzimuthIndex(azimuths) {
  const index = new Int32Array(AZ_BINS).fill(-1);
  const best = new Float32Array(AZ_BINS).fill(Infinity);
  const binWidth = 360 / AZ_BINS;
  azimuths.forEach((az, i) => {
    // Claim the bins within ±1° of this radial, keeping the closest radial per bin.
    for (let k = -2; k <= 2; k++) {
      const bin = (((Math.round(az / binWidth) + k) % AZ_BINS) + AZ_BINS) % AZ_BINS;
      const centre = (bin + 0.5) * binWidth;
      const d = Math.abs(((centre - az + 540) % 360) - 180);
      if (d < best[bin]) {
        best[bin] = d;
        index[bin] = i;
      }
    }
  });
  return index;
}

/**
 * Reflectivity (dBZ) on a tilt at azimuth/slant range; NaN when no echo.
 * Averages (in linear Z) every radial whose beam falls inside the voxel's
 * azimuthal footprint, which is several radials near the radar and one far
 * out. Single-gate sampling there turns natural reflectivity speckle into
 * voxel-scale noise that shading exaggerates into a dot pattern.
 */
function sampleTilt(tilt, azDeg, rangeKm) {
  const binWidth = 360 / AZ_BINS;
  const footprintDeg = Math.min((CELL_KM / Math.max(rangeKm, 1)) / DEG, MAX_AZ_FOOTPRINT_DEG);
  const reach = Math.floor(footprintDeg / 2 / binWidth);
  const centre = Math.floor(azDeg / binWidth);

  let sumZ = 0;
  let echoes = 0;
  let samples = 0;
  let lastRadial = -1;
  for (let k = -reach; k <= reach; k++) {
    const radialIndex = tilt.azIndex[(((centre + k) % AZ_BINS) + AZ_BINS) % AZ_BINS];
    // 1° radials span two bins; count each radial once.
    if (radialIndex < 0 || radialIndex === lastRadial) continue;
    lastRadial = radialIndex;
    samples++;
    const dbz = sampleRadial(tilt.radials[radialIndex], rangeKm);
    if (!Number.isNaN(dbz)) {
      sumZ += 10 ** (dbz / 10);
      echoes++;
    }
  }
  // Keep echo edges where they are: a voxel needs echo in most of its footprint.
  if (echoes === 0 || echoes * 2 < samples) return NaN;
  return 10 * Math.log10(sumZ / echoes);
}

/** Linear interpolation along range on a (pre-smoothed) radial. */
function sampleRadial(radial, rangeKm) {
  const g = (rangeKm - radial.firstGate) / radial.gateSize;
  const i = Math.floor(g);
  if (i < 0 || i >= radial.data.length) return NaN;
  const a = radial.data[i];
  const b = i + 1 < radial.data.length ? radial.data[i + 1] : NaN;
  if (Number.isNaN(b)) return a;
  if (Number.isNaN(a)) return b;
  return a + (b - a) * (g - i);
}

/**
 * Box-filters a radial over `window` gates (≈ one voxel) in linear Z, so each
 * range sample represents the voxel's radial extent rather than one 250 m gate.
 * Gates with echo in under half the window become NaN, preserving edges.
 */
function smoothAlongRange(moments, window) {
  const n = moments.length;
  const z = new Float64Array(n + 1);
  const count = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const d = moments[i];
    const has = d !== null && d >= MIN_DBZ;
    z[i + 1] = z[i] + (has ? 10 ** (d / 10) : 0);
    count[i + 1] = count[i] + (has ? 1 : 0);
  }
  const half = Math.max(0, Math.floor(window / 2));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const c = count[hi] - count[lo];
    out[i] = c * 2 < hi - lo ? NaN : 10 * Math.log10((z[hi] - z[lo]) / c);
  }
  return out;
}

function gridVolume(tilts, site) {
  const { nx, nz, ny, halfWidthKm, topKm } = GRID;
  const voxels = new Uint8Array(nx * nz * ny);
  const cellXZ = (2 * halfWidthKm) / nx;
  const cellY = topKm / ny;
  const Re = EFFECTIVE_EARTH_RADIUS_KM;
  const lowest = tilts[0].elevationDeg;
  const highest = tilts[tilts.length - 1].elevationDeg;
  let echoes = 0;

  for (let iz = 0; iz < nz; iz++) {
    const south = (iz + 0.5) * cellXZ - halfWidthKm;
    for (let ix = 0; ix < nx; ix++) {
      const east = (ix + 0.5) * cellXZ - halfWidthKm;
      const groundKm = Math.hypot(east, south);
      // Meteorological azimuth: clockwise from north (north is −z in the scene).
      const azDeg = (Math.atan2(east, -south) / DEG + 360) % 360;
      const phi = groundKm / Re;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      for (let iy = 0; iy < ny; iy++) {
        const hKm = (iy + 0.5) * cellY - site.heightKm;
        if (hKm < 0) continue;
        // Inverse 4/3-earth beam model: voxel centre → slant range and elevation angle.
        const dx = (Re + hKm) * sinPhi;
        const dy = (Re + hKm) * cosPhi - Re;
        const rangeKm = Math.hypot(dx, dy);
        const elDeg = Math.atan2(dy, dx) / DEG;
        if (elDeg < lowest - HALF_BEAM_DEG || elDeg > highest + HALF_BEAM_DEG) continue;

        const dbz = sampleBetweenTilts(tilts, elDeg, azDeg, rangeKm);
        if (Number.isNaN(dbz)) continue;
        voxels[(iy * nz + iz) * nx + ix] = Math.min(255, Math.max(1, Math.round((dbz + 32) * 2)));
        echoes++;
      }
    }
  }
  return { voxels, echoes };
}

/**
 * Interpolates linearly in elevation angle between the bracketing tilts. Where
 * only one side has echo (storm top/edge), that echo extends half a beamwidth
 * and stops, rather than fading into the empty tilt.
 */
function sampleBetweenTilts(tilts, elDeg, azDeg, rangeKm) {
  let upper = tilts.findIndex((t) => t.elevationDeg >= elDeg);
  if (upper === -1) upper = tilts.length;
  const below = upper > 0 ? tilts[upper - 1] : null;
  const above = upper < tilts.length ? tilts[upper] : null;

  const a = below ? sampleTilt(below, azDeg, rangeKm) : NaN;
  const b = above ? sampleTilt(above, azDeg, rangeKm) : NaN;
  const hasA = !Number.isNaN(a);
  const hasB = !Number.isNaN(b);

  if (hasA && hasB) {
    const t = (elDeg - below.elevationDeg) / (above.elevationDeg - below.elevationDeg);
    return a + (b - a) * t;
  }
  if (hasA && elDeg - below.elevationDeg <= HALF_BEAM_DEG) return a;
  if (hasB && above.elevationDeg - elDeg <= HALF_BEAM_DEG) return b;
  return NaN;
}
