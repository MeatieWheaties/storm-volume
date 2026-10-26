// Downloads NEXRAD Level II volume scans for one radar and UTC time window from
// the public Unidata/NOAA archive on AWS (no account needed).
//
//   node scripts/fetch-nexrad.mjs [--station KTLX] [--date 2013-05-20] [--start 19:30] [--end 20:40]
//
// Defaults cover the Moore EF5 (touchdown 19:56 UTC, lift 20:35 UTC).
import { resolve } from 'node:path';
import { cachedDownload, parseArgs, RAW_DIR } from './lib/cli.mjs';

const BUCKET = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const args = parseArgs({ station: 'KTLX', date: '2013-05-20', start: '19:30', end: '20:40' });

const [yyyy, mm, dd] = args.date.split('-');
const prefix = `${yyyy}/${mm}/${dd}/${args.station}/`;
const toHHMMSS = (hhmm) => hhmm.replace(':', '') + '00';
const start = toHHMMSS(args.start);
const end = toHHMMSS(args.end);

async function listKeys() {
  const keys = [];
  let token = '';
  do {
    const url = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const xml = await (await fetch(url)).text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    token = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? '';
  } while (token);
  return keys;
}

const keys = (await listKeys()).filter((key) => {
  // e.g. KTLX20130520_195941_V06.gz — skip _MDM metadata files.
  const m = /_(\d{6})_V\d+(\.gz)?$/.exec(key);
  return m && m[1] >= start && m[1] <= end;
});

if (keys.length === 0) {
  console.error(`No volumes found under ${prefix} between ${args.start} and ${args.end} UTC.`);
  process.exit(1);
}

console.log(`Downloading ${keys.length} volumes for ${args.station} ${args.date} ${args.start}–${args.end} UTC`);
for (const key of keys) {
  const file = resolve(RAW_DIR, 'nexrad', key);
  const buf = await cachedDownload(`${BUCKET}/${key}`, file);
  console.log(`  ${key}  ${(buf.length / 1e6).toFixed(1)} MB`);
}
