// Tiny shared helpers for the data pipeline scripts.
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW_DIR = resolve(ROOT, 'data', 'raw');
export const PUBLIC_DATA_DIR = resolve(ROOT, 'public', 'data');

/** Parses `--key value` pairs into an object, merged over defaults. */
export function parseArgs(defaults) {
  const args = { ...defaults };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (m) args[m[1]] = argv[++i];
  }
  return args;
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeOut(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/** Downloads `url` to `path` unless it is already cached. Returns the file contents. */
export async function cachedDownload(url, path) {
  if (await exists(path)) return readFile(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeOut(path, buf);
  return buf;
}
