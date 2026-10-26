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
// Gridding: every gate is placed with the standard 4/3 effective-earth-radius
// beam model and max-binned into its voxel. Empty voxels between tilts are
// then filled vertically from the nearest echoes in the same column.
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
const FILL_MAX_GAP = 4;
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
  const { voxels, gates, tilts, site } = gridVolume(radar);
  const filled = fillColumns(voxels);
  const id = file.replace(/(_V\d+)?(\.gz)?$/, '');
  // Mostly empty air, so gzip shrinks frames ~10×; the viewer inflates them with DecompressionStream.
  const compressed = gzipSync(voxels, { level: 9 });
  await writeOut(resolve(outDir, `${id}.bin.gz`), compressed);

  const time = /(\d{8})_(\d{6})/.exec(file);
  frames.push({
    id,
    file: `${id}.bin.gz`,
    timeUtc: `${time[1].slice(0, 4)}-${time[1].slice(4, 6)}-${time[1].slice(6)}T${time[2].slice(0, 2)}:${time[2].slice(2, 4)}:${time[2].slice(4)}Z`,
    tilts,
  });
  console.log(
    `  ${id}: ${(compressed.length / 1e3).toFixed(0)} kB, ${tilts.length} tilts, ${(gates / 1e6).toFixed(1)}M gates, +${filled} filled, ` +
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

function gridVolume(radar) {
  const { nx, nz, ny, halfWidthKm, topKm } = GRID;
  const voxels = new Uint8Array(nx * nz * ny);
  const cellXZ = (2 * halfWidthKm) / nx;
  const cellY = topKm / ny;
  let gates = 0;
  let site = null;
  const tilts = [];

  for (const elevation of radar.listElevations()) {
    radar.setElevation(elevation);
    const records = radar.getHeader();
    if (!records[0]?.reflect) continue; // Doppler-only cut
    site ??= records[0].volume
      ? { lat: records[0].volume.latitude, lon: records[0].volume.longitude, heightKm: records[0].volume.elevation / 1000 }
      : { lat: NaN, lon: NaN, heightKm: 0.37 };
    tilts.push(Math.round(records[0].elevation_angle * 100) / 100);

    for (const record of records) {
      const refl = record.reflect;
      if (!refl) continue;
      const el = record.elevation_angle * DEG;
      const az = record.azimuth * DEG;
      const sinAz = Math.sin(az);
      const cosAz = Math.cos(az);
      const cosEl = Math.cos(el);
      const sinEl = Math.sin(el);
      const data = refl.moment_data;

      for (let g = 0; g < data.length; g++) {
        const dbz = data[g];
        if (dbz === null || dbz < MIN_DBZ) continue;
        gates++;
        const r = refl.first_gate + g * refl.gate_size;
        // Beam height above the radar and great-circle ground distance.
        const h =
          Math.sqrt(r * r + EFFECTIVE_EARTH_RADIUS_KM ** 2 + 2 * r * EFFECTIVE_EARTH_RADIUS_KM * sinEl) -
          EFFECTIVE_EARTH_RADIUS_KM;
        const s = EFFECTIVE_EARTH_RADIUS_KM * Math.asin((r * cosEl) / (EFFECTIVE_EARTH_RADIUS_KM + h));
        const east = s * sinAz;
        const south = -s * cosAz;
        const up = h + site.heightKm;

        const ix = Math.floor((east + halfWidthKm) / cellXZ);
        const iz = Math.floor((south + halfWidthKm) / cellXZ);
        const iy = Math.floor(up / cellY);
        if (ix < 0 || ix >= nx || iz < 0 || iz >= nz || iy < 0 || iy >= ny) continue;

        const v = Math.min(255, Math.max(1, Math.round((dbz + 32) * 2)));
        const idx = (iy * nz + iz) * nx + ix;
        if (v > voxels[idx]) voxels[idx] = v;
      }
    }
  }
  return { voxels, gates, tilts, site };
}

/** Linearly interpolates short vertical gaps between echoes (beam spacing at long range). */
function fillColumns(voxels) {
  const { nx, nz, ny } = GRID;
  const layer = nx * nz;
  let filled = 0;
  for (let c = 0; c < layer; c++) {
    let last = -1;
    for (let y = 0; y < ny; y++) {
      const v = voxels[y * layer + c];
      if (v === 0) continue;
      const gap = y - last - 1;
      if (last >= 0 && gap > 0 && gap <= FILL_MAX_GAP) {
        const a = voxels[last * layer + c];
        for (let k = 1; k <= gap; k++) {
          voxels[(last + k) * layer + c] = Math.round(a + ((v - a) * k) / (gap + 1));
          filled++;
        }
      }
      last = y;
    }
  }
  return filled;
}
