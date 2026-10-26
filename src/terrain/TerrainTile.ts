import * as THREE from 'three';
import { TERRAIN } from '../config';
import { tileSceneBounds } from '../geo/projection';

export type TileState = 'empty' | 'loading' | 'ready' | 'error';

const SEG = TERRAIN.segments;
const GRID = SEG + 1;
const SKIRT_DEPTH_KM = 0.6;

// One canvas is shared by all decodes: drawImage + getImageData run synchronously together.
const decodeCanvas = new OffscreenCanvas(256, 256);
const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true })!;

/** Hypsometric ramp for Oklahoma's ~90 m – 1500 m range. */
const RAMP: Array<[number, THREE.Color]> = [
  [80, new THREE.Color('#2f4a2c')],
  [300, new THREE.Color('#4f6b3a')],
  [600, new THREE.Color('#8a8a55')],
  [1000, new THREE.Color('#a68b62')],
  [1500, new THREE.Color('#d6cbb8')],
];

function rampColor(heightM: number, out: THREE.Color): THREE.Color {
  if (heightM <= RAMP[0][0]) return out.copy(RAMP[0][1]);
  for (let i = 1; i < RAMP.length; i++) {
    const [h1, c1] = RAMP[i];
    if (heightM <= h1) {
      const [h0, c0] = RAMP[i - 1];
      return out.copy(c0).lerp(c1, (heightM - h0) / (h1 - h0));
    }
  }
  return out.copy(RAMP[RAMP.length - 1][1]);
}

export class TerrainTile {
  readonly key: string;
  readonly bounds: { x0: number; z0: number; x1: number; z1: number };
  state: TileState = 'empty';
  mesh: THREE.Mesh | null = null;
  /** Elevations in metres on a GRID x GRID lattice, row-major north→south. */
  heights: Float32Array | null = null;
  minHeightM = 0;
  maxHeightM = 0;
  /** Frame index when this tile was last touched by LOD traversal (for eviction). */
  lastUsed = 0;
  children: TerrainTile[] | null = null;

  constructor(
    readonly z: number,
    readonly x: number,
    readonly y: number,
  ) {
    this.key = `${z}/${x}/${y}`;
    this.bounds = tileSceneBounds(z, x, y);
  }

  get widthKm() {
    return this.bounds.x1 - this.bounds.x0;
  }

  async load(material: THREE.Material, signal?: AbortSignal): Promise<void> {
    this.state = 'loading';
    try {
      const res = await fetch(TERRAIN.tileUrl(this.z, this.x, this.y), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bitmap = await createImageBitmap(await res.blob());
      decodeCtx.drawImage(bitmap, 0, 0);
      const pixels = decodeCtx.getImageData(0, 0, 256, 256).data;
      bitmap.close();
      this.heights = decodeHeights(pixels);
      this.mesh = this.buildMesh(material);
      this.state = 'ready';
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.state = 'empty';
        return;
      }
      console.warn(`terrain tile ${this.key} failed`, err);
      this.state = 'error';
    }
  }

  /** Bilinear elevation (metres) at a scene point inside this tile. */
  sampleHeight(sx: number, sz: number): number {
    const h = this.heights!;
    const { x0, z0, x1, z1 } = this.bounds;
    const u = Math.min(Math.max((sx - x0) / (x1 - x0), 0), 1) * SEG;
    const v = Math.min(Math.max((sz - z0) / (z1 - z0), 0), 1) * SEG;
    const i = Math.min(Math.floor(u), SEG - 1);
    const j = Math.min(Math.floor(v), SEG - 1);
    const fu = u - i;
    const fv = v - j;
    const a = h[j * GRID + i];
    const b = h[j * GRID + i + 1];
    const c = h[(j + 1) * GRID + i];
    const d = h[(j + 1) * GRID + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mesh?.removeFromParent();
    this.mesh = null;
    this.heights = null;
    this.state = 'empty';
  }

  private buildMesh(material: THREE.Material): THREE.Mesh {
    const h = this.heights!;
    const { x0, z0, x1, z1 } = this.bounds;
    const dx = (x1 - x0) / SEG;
    const dz = (z1 - z0) / SEG;

    // Grid with an extra ring on each side that becomes a downward skirt,
    // hiding T-junction cracks between neighbours at different LODs.
    const ring = GRID + 2;
    const positions = new Float32Array(ring * ring * 3);
    const normals = new Float32Array(ring * ring * 3);
    const colors = new Float32Array(ring * ring * 3);
    const color = new THREE.Color();
    const n = new THREE.Vector3();
    let min = Infinity;
    let max = -Infinity;

    const at = (i: number, j: number) => h[j * GRID + i] / 1000;

    for (let rj = 0; rj < ring; rj++) {
      for (let ri = 0; ri < ring; ri++) {
        const i = Math.min(Math.max(ri - 1, 0), SEG);
        const j = Math.min(Math.max(rj - 1, 0), SEG);
        const isSkirt = i !== ri - 1 || j !== rj - 1;
        const hm = h[j * GRID + i];
        min = Math.min(min, hm);
        max = Math.max(max, hm);

        const k = (rj * ring + ri) * 3;
        positions[k] = x0 + i * dx;
        positions[k + 1] = hm / 1000 - (isSkirt ? SKIRT_DEPTH_KM : 0);
        positions[k + 2] = z0 + j * dz;

        // Central differences in km; one-sided at tile edges.
        const il = Math.max(i - 1, 0);
        const ir = Math.min(i + 1, SEG);
        const ju = Math.max(j - 1, 0);
        const jd = Math.min(j + 1, SEG);
        const gx = (at(ir, j) - at(il, j)) / ((ir - il) * dx);
        const gz = (at(i, jd) - at(i, ju)) / ((jd - ju) * dz);
        n.set(-gx, 1, -gz).normalize();
        normals[k] = n.x;
        normals[k + 1] = n.y;
        normals[k + 2] = n.z;

        rampColor(hm, color);
        colors[k] = color.r;
        colors[k + 1] = color.g;
        colors[k + 2] = color.b;
      }
    }

    const indices = new Uint32Array((ring - 1) * (ring - 1) * 6);
    let p = 0;
    for (let j = 0; j < ring - 1; j++) {
      for (let i = 0; i < ring - 1; i++) {
        const a = j * ring + i;
        const b = a + 1;
        const c = a + ring;
        const d = c + 1;
        indices.set([a, c, b, b, c, d], p);
        p += 6;
      }
    }

    this.minHeightM = min;
    this.maxHeightM = max;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `terrain ${this.key}`;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

/** Terrarium encoding: height = R*256 + G + B/256 − 32768 (metres). Downsampled to GRID². */
function decodeHeights(pixels: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(GRID * GRID);
  const step = 256 / SEG;
  for (let j = 0; j < GRID; j++) {
    const py = Math.min(Math.round(j * step), 255);
    for (let i = 0; i < GRID; i++) {
      const px = Math.min(Math.round(i * step), 255);
      const k = (py * 256 + px) * 4;
      out[j * GRID + i] = pixels[k] * 256 + pixels[k + 1] + pixels[k + 2] / 256 - 32768;
    }
  }
  return out;
}
