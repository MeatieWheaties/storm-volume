// Downloads the SPC tornado database (1950–present, CSV) and writes the Oklahoma
// tornadoes in a date range as GeoJSON LineStrings for the viewer.
//
//   node scripts/fetch-spc-tracks.mjs [--from 2013-05-19] [--to 2013-05-31] [--state OK] [--year 2024]
//
// Format reference: https://www.spc.noaa.gov/wcm/data/SPC_severe_database_description.pdf
import { resolve } from 'node:path';
import { cachedDownload, parseArgs, PUBLIC_DATA_DIR, RAW_DIR, writeOut } from './lib/cli.mjs';

const args = parseArgs({ from: '2013-05-19', to: '2013-05-31', state: 'OK', year: '2024' });
const url = `https://www.spc.noaa.gov/wcm/data/1950-${args.year}_actual_tornadoes.csv`;

const csv = (await cachedDownload(url, resolve(RAW_DIR, 'spc', `1950-${args.year}_actual_tornadoes.csv`))).toString('utf8');
const [headerLine, ...lines] = csv.trim().split(/\r?\n/);
const header = headerLine.split(',');
const col = Object.fromEntries(header.map((name, i) => [name, i]));

const features = [];
for (const line of lines) {
  const f = line.split(',');
  const date = f[col.date];
  if (f[col.st] !== args.state || date < args.from || date > args.to) continue;
  // sn=1 rows are the per-state record; sn=0 rows are whole multi-state tracks.
  if (f[col.sn] !== '1') continue;

  const slat = +f[col.slat];
  const slon = +f[col.slon];
  let elat = +f[col.elat];
  let elon = +f[col.elon];
  // Missing end points are recorded as 0.
  if (!elat || !elon) {
    elat = slat;
    elon = slon;
  }

  features.push({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[slon, slat], [elon, elat]] },
    properties: {
      id: +f[col.om],
      mag: +f[col.mag],
      date,
      timeLocal: f[col.time],
      fatalities: +f[col.fat],
      injuries: +f[col.inj],
      lengthMi: +f[col.len],
      widthYd: +f[col.wid],
    },
  });
}

const out = resolve(PUBLIC_DATA_DIR, 'tracks.geojson');
await writeOut(out, JSON.stringify({ type: 'FeatureCollection', features }));
const strongest = features.reduce((a, b) => (b.properties.mag > (a?.properties.mag ?? -1) ? b : a), null);
console.log(`Wrote ${features.length} ${args.state} tornadoes (${args.from} → ${args.to}) to ${out}`);
if (strongest) {
  const p = strongest.properties;
  console.log(`Strongest: (E)F${p.mag} on ${p.date} ${p.timeLocal} CST, ${p.lengthMi} mi long, ${p.widthYd} yd wide`);
}
