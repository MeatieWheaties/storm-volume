// Builds timed tornado tracks for the viewer.
//
//   node scripts/fetch-spc-tracks.mjs [--from 2013-05-19] [--to 2013-05-31] [--state OK] [--year 2024]
//
// Sources:
//   SPC tornado database (1950–present): the track list, rating and casualties.
//     https://www.spc.noaa.gov/wcm/data/SPC_severe_database_description.pdf
//   NCEI Storm Events details: per-county segments with begin/end times and
//     points, which SPC lacks. Segments are chained into a timed path for each
//     SPC track, so the viewer can show where each tornado was at radar time.
//
// Output: public/data/tracks.geojson. Each LineString vertex has a matching
// entry in properties.timesUtc (epoch ms). Tracks without an NCEI match get a
// two-point path with the duration estimated from length (timing: "estimated").
import { resolve } from 'node:path';
import { cachedDownload, parseArgs, PUBLIC_DATA_DIR, RAW_DIR, writeOut } from './lib/cli.mjs';
import { parseCsv } from './lib/csv.mjs';

const args = parseArgs({ from: '2013-05-19', to: '2013-05-31', state: 'OK', year: '2024' });
const STATE_NAMES = { OK: 'OKLAHOMA', KS: 'KANSAS', TX: 'TEXAS' };
const NCEI_DIR = 'https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/';
/** Typical tornado forward speed, used only when no NCEI timing exists. */
const ESTIMATED_SPEED_MPH = 30;
const MATCH_TIME_MS = 2 * 60_000;
const MATCH_DIST_KM = 2;
const MINUTE = 60_000;

// --- SPC tracks --------------------------------------------------------------
const spcUrl = `https://www.spc.noaa.gov/wcm/data/1950-${args.year}_actual_tornadoes.csv`;
const spcRows = parseCsv(
  (await cachedDownload(spcUrl, resolve(RAW_DIR, 'spc', `1950-${args.year}_actual_tornadoes.csv`))).toString('utf8'),
).filter(
  // sn=1 rows are the per-state record; sn=0 rows are whole multi-state tracks.
  (r) => r.st === args.state && r.date >= args.from && r.date <= args.to && r.sn === '1',
);

// --- NCEI Storm Events segments -----------------------------------------------
const years = [...new Set([args.from.slice(0, 4), args.to.slice(0, 4)])];
const segments = [];
for (const year of years) {
  // File names carry a revision date (…_d2013_c20260323.csv.gz), so look it up.
  const listing = await (await fetch(NCEI_DIR)).text();
  const names = [...listing.matchAll(new RegExp(`StormEvents_details-ftp_v1\\.0_d${year}_c\\d+\\.csv\\.gz`, 'g'))];
  const name = names.map((m) => m[0]).sort().at(-1);
  if (!name) {
    console.warn(`No NCEI Storm Events file for ${year}; timing will be estimated.`);
    continue;
  }
  const { gunzipSync } = await import('node:zlib');
  const gz = await cachedDownload(NCEI_DIR + name, resolve(RAW_DIR, 'ncei', name));
  for (const r of parseCsv(gunzipSync(gz).toString('utf8'))) {
    if (r.EVENT_TYPE !== 'Tornado' || r.STATE !== STATE_NAMES[args.state]) continue;
    if (!r.BEGIN_LAT || !r.END_LAT) continue;
    segments.push({
      id: +r.EVENT_ID,
      begin: { lon: +r.BEGIN_LON, lat: +r.BEGIN_LAT, t: parseNceiTime(r.BEGIN_DATE_TIME, r.CZ_TIMEZONE) },
      end: { lon: +r.END_LON, lat: +r.END_LAT, t: parseNceiTime(r.END_DATE_TIME, r.CZ_TIMEZONE) },
      beginLocation: r.BEGIN_LOCATION,
      endLocation: r.END_LOCATION,
    });
  }
}

// --- Join ----------------------------------------------------------------------
let matched = 0;
const features = spcRows.map((r) => {
  // SPC times are CST (tz=3) → UTC+6.
  const startUtc = Date.parse(`${r.date}T${r.time}Z`) + 6 * 60 * MINUTE;
  const start = { lon: +r.slon, lat: +r.slat, t: startUtc };
  const chain = chainSegments(start);

  let knots;
  let name = null;
  if (chain.length > 0) {
    matched++;
    knots = [chain[0].begin, ...chain.map((s) => s.end)];
    name = `${titleCase(chain[0].beginLocation)} → ${titleCase(chain.at(-1).endLocation)}`;
  } else {
    // Missing end points are recorded as 0.
    const end = +r.elat && +r.elon ? { lon: +r.elon, lat: +r.elat } : { lon: start.lon, lat: start.lat };
    const minutes = Math.max(1, (+r.len / ESTIMATED_SPEED_MPH) * 60);
    knots = [start, { ...end, t: start.t + minutes * MINUTE }];
  }

  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: knots.map((k) => [k.lon, k.lat]) },
    properties: {
      id: +r.om,
      name,
      mag: +r.mag,
      date: r.date,
      timeLocal: r.time,
      fatalities: +r.fat,
      injuries: +r.inj,
      lengthMi: +r.len,
      widthYd: +r.wid,
      timing: chain.length > 0 ? 'ncei' : 'estimated',
      timesUtc: knots.map((k) => k.t),
    },
  };
});

/** Follows NCEI county segments from the SPC start point, joining end → begin across county lines. */
function chainSegments(start) {
  const near = (a, b, dt) => Math.abs(a.t - b.t) <= dt && distanceKm(a, b) <= MATCH_DIST_KM;
  const first = segments.find((s) => near(s.begin, start, MATCH_TIME_MS));
  if (!first) return [];
  const chain = [first];
  const used = new Set([first.id]);
  for (;;) {
    const last = chain.at(-1);
    const next = segments.find((s) => !used.has(s.id) && near(s.begin, last.end, MATCH_TIME_MS));
    if (!next) return chain;
    chain.push(next);
    used.add(next.id);
  }
}

const out = resolve(PUBLIC_DATA_DIR, 'tracks.geojson');
await writeOut(out, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(
  `Wrote ${features.length} ${args.state} tornadoes (${args.from} → ${args.to}) to ${out}; ` +
    `${matched} timed from NCEI segments, ${features.length - matched} estimated`,
);
const strongest = features.reduce((a, b) => (b.properties.mag > (a?.properties.mag ?? -1) ? b : a), null);
if (strongest) {
  const p = strongest.properties;
  const fmt = (t) => new Date(t).toISOString().slice(11, 16);
  console.log(
    `Strongest: (E)F${p.mag} ${p.name ?? ''} ${p.date} ${fmt(p.timesUtc[0])}–${fmt(p.timesUtc.at(-1))} UTC, ` +
      `${strongest.geometry.coordinates.length - 1} segment(s)`,
  );
}

/** "20-MAY-13 13:56:00" in zone "CST-6" → epoch ms (UTC). */
function parseNceiTime(text, zone) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  const month = 'JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.indexOf(m[2]) / 3;
  const offsetHours = Number(/[-+]\d+$/.exec(zone)?.[0] ?? 0);
  return Date.UTC(2000 + +m[3], month, +m[1], +m[4], +m[5], +m[6]) - offsetHours * 60 * MINUTE;
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return R * Math.hypot(dLat, dLon);
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
