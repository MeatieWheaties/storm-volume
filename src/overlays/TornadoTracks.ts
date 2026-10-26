import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { lonLatToScene } from '../geo/projection';
import type { TerrainManager } from '../terrain/TerrainManager';

/** Properties written by scripts/fetch-spc-tracks.mjs. */
export interface TrackProps {
  id: number;
  mag: number;
  date: string;
  timeLocal: string;
  fatalities: number;
  injuries: number;
  lengthMi: number;
  widthYd: number;
}

interface TrackCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
    properties: TrackProps;
  }>;
}

/** (E)F-scale colours, unknown (-9) → grey. */
const MAG_COLORS = ['#9ad0ff', '#6fd36f', '#f2e24b', '#f59b3a', '#e8452c', '#c42bd6'];
const DRAPE_STEP_KM = 0.25;
const LIFT_KM = 0.03;

interface Track {
  line: Line2;
  points: Array<{ x: number; z: number }>;
}

/** Draws SPC tornado damage paths draped over the streamed terrain. */
export class TornadoTracks {
  readonly group = new THREE.Group();
  private readonly tracks: Track[] = [];
  private readonly materials: LineMaterial[] = [];

  constructor(private readonly terrain: TerrainManager) {
    this.group.name = 'tornado tracks';
  }

  async load(url: string): Promise<number> {
    const res = await fetch(url);
    if (!res.ok) return 0;
    const data = (await res.json()) as TrackCollection;

    for (const feature of data.features) {
      const coords = feature.geometry.coordinates.map(([lon, lat]) => lonLatToScene({ lon, lat }));
      const points = densify(coords);
      const mag = feature.properties.mag;
      const material = new LineMaterial({
        color: new THREE.Color(mag >= 0 ? MAG_COLORS[mag] : '#888888').getHex(),
        // Wider lines for stronger tornadoes; width is in pixels.
        linewidth: 2 + Math.max(mag, 0) * 1.2,
        depthTest: true,
      });
      this.materials.push(material);
      const line = new Line2(new LineGeometry(), material);
      line.userData = feature.properties;
      this.tracks.push({ line, points });
      this.group.add(line);
    }
    this.drape(1);
    return data.features.length;
  }

  /** Re-sample terrain heights under each track. Call as tiles stream in or exaggeration changes. */
  drape(exaggeration: number) {
    for (const { line, points } of this.tracks) {
      const positions: number[] = [];
      for (const p of points) {
        const hM = this.terrain.heightAt(p.x, p.z) ?? 350;
        positions.push(p.x, (hM / 1000) * exaggeration + LIFT_KM, p.z);
      }
      line.geometry.setPositions(positions);
      line.computeLineDistances();
    }
  }

  setResolution(width: number, height: number) {
    for (const m of this.materials) m.resolution.set(width, height);
  }
}

function densify(coords: Array<{ x: number; z: number }>) {
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / DRAPE_STEP_KM));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  out.push(coords[coords.length - 1]);
  // Line2 needs at least two points.
  if (out.length === 1) out.push({ x: out[0].x + 0.01, z: out[0].z });
  return out;
}
