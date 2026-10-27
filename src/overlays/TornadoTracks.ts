import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { lonLatToScene } from '../geo/projection';
import type { TerrainManager } from '../terrain/TerrainManager';

/** Properties written by scripts/fetch-spc-tracks.mjs. */
export interface TrackProps {
  id: number;
  name: string | null;
  mag: number;
  date: string;
  timeLocal: string;
  fatalities: number;
  injuries: number;
  lengthMi: number;
  widthYd: number;
  timing: 'ncei' | 'estimated';
  /** Epoch ms for each LineString vertex. */
  timesUtc: number[];
}

interface TrackCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
    properties: TrackProps;
  }>;
}

export interface ActiveTornado {
  props: TrackProps;
  /** 0–1 through the tornado's lifetime. */
  progress: number;
}

/** (E)F-scale colours, unknown (-9) → grey. */
const MAG_COLORS = ['#9ad0ff', '#6fd36f', '#f2e24b', '#f59b3a', '#e8452c', '#c42bd6'];
const DRAPE_STEP_KM = 0.25;
const LIFT_KM = 0.03;
const FUNNEL_HEIGHT_KM = 2.5;

/** A densified path point with its interpolated time. */
interface PathPoint {
  x: number;
  z: number;
  t: number;
}

interface Track {
  props: TrackProps;
  color: THREE.Color;
  points: PathPoint[];
  /** Full path, dimmed while the tornado hasn't happened yet. */
  ghost: Line2;
  /** Path covered so far at the current time; drawn over the radar volume. */
  progress: Line2;
  funnel: THREE.Group;
  /** Identifies what `progress` currently shows, so playback only rebuilds lines that changed. */
  shownKey: string;
}

/** Tracks further than this from the current time belong to another day of the outbreak. */
const SAME_EVENT_MS = 12 * 3600_000;

/**
 * SPC tornado damage paths draped over the streamed terrain, animated against
 * radar time: future paths are faint, the covered part of an active tornado's
 * path is bright and a funnel marker shows its current position.
 */
export class TornadoTracks {
  readonly group = new THREE.Group();
  private readonly tracks: Track[] = [];
  private readonly materials: LineMaterial[] = [];
  private exaggeration = 1;
  private time: number | null = null;
  private readonly funnelGeometry = new THREE.ConeGeometry(0.45, FUNNEL_HEIGHT_KM, 24, 1, true);
  private readonly ringGeometry = new THREE.RingGeometry(0.7, 1.0, 48).rotateX(-Math.PI / 2);

  constructor(private readonly terrain: TerrainManager) {
    this.group.name = 'tornado tracks';
    // Point the cone down so its tip touches the ground.
    this.funnelGeometry.rotateX(Math.PI);
    this.funnelGeometry.translate(0, FUNNEL_HEIGHT_KM / 2, 0);
  }

  async load(url: string): Promise<number> {
    const res = await fetch(url);
    if (!res.ok) return 0;
    const data = (await res.json()) as TrackCollection;

    for (const feature of data.features) {
      const { coordinates } = feature.geometry;
      const props = feature.properties;
      const knots = coordinates.map(([lon, lat], i) => ({ ...lonLatToScene({ lon, lat }), t: props.timesUtc[i] }));
      const color = new THREE.Color(props.mag >= 0 ? MAG_COLORS[props.mag] : '#888888');
      // Wider lines for stronger tornadoes; width is in pixels.
      const width = 2 + Math.max(props.mag, 0) * 1.2;

      const ghost = this.makeLine(color, width * 0.6, { opacity: 0.35 });
      // Transparent + high renderOrder puts it after the radar volume, so it isn't hidden by echo.
      const progress = this.makeLine(color, width + 1.5, { opacity: 1, renderOrder: 11 });
      const funnel = this.makeFunnel(color);

      ghost.userData = props;
      progress.userData = props;
      this.tracks.push({ props, color, points: densify(knots), ghost, progress, funnel, shownKey: '' });
      this.group.add(ghost, progress, funnel);
    }
    this.drape(this.exaggeration);
    return data.features.length;
  }

  /** Re-sample terrain heights under each track. Call as tiles stream in or exaggeration changes. */
  drape(exaggeration: number) {
    this.exaggeration = exaggeration;
    for (const track of this.tracks) {
      track.ghost.geometry.setPositions(this.positions(track.points));
      track.ghost.computeLineDistances();
      track.shownKey = '';
    }
    this.applyTime();
  }

  /**
   * Sets the displayed moment (epoch ms), or null to show every path in full.
   * Returns the tornadoes on the ground at that moment.
   */
  setTime(time: number | null): ActiveTornado[] {
    this.time = time;
    return this.applyTime();
  }

  setResolution(width: number, height: number) {
    for (const m of this.materials) m.resolution.set(width, height);
  }

  /** Called every frame for the funnel's spin and pulse. */
  animate(elapsedSeconds: number) {
    for (const { funnel } of this.tracks) {
      if (!funnel.visible) continue;
      funnel.children[0].rotation.y = elapsedSeconds * 3;
      const pulse = (elapsedSeconds * 0.8) % 1;
      const ring = funnel.children[1] as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
      ring.scale.setScalar(1 + pulse * 2.5);
      ring.material.opacity = 0.8 * (1 - pulse);
    }
  }

  private applyTime(): ActiveTornado[] {
    const active: ActiveTornado[] = [];
    for (const track of this.tracks) {
      const { points, progress, ghost, funnel, props } = track;
      const start = points[0].t;
      const end = points[points.length - 1].t;
      const t = this.time;

      if (t !== null && Math.abs(t - start) > SAME_EVENT_MS) {
        // Another day of the outbreak: context only.
        ghost.visible = true;
        progress.visible = false;
        funnel.visible = false;
        continue;
      }
      if (t === null || t >= end) {
        // Finished (or no time set): the whole path is history.
        this.setProgress(track, points, 'full');
        funnel.visible = false;
        ghost.visible = false;
        continue;
      }
      ghost.visible = true;
      if (t < start) {
        progress.visible = false;
        funnel.visible = false;
        continue;
      }

      // On the ground: path up to the current position, plus the funnel there.
      let i = 1;
      while (i < points.length - 1 && points[i].t <= t) i++;
      const a = points[i - 1];
      const b = points[i];
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      const here = { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, t };
      this.setProgress(track, [...points.slice(0, i), here], `${i}:${f.toFixed(3)}`);

      funnel.visible = true;
      funnel.position.set(here.x, this.groundY(here), here.z);
      active.push({ props, progress: (t - start) / Math.max(end - start, 1) });
    }
    return active;
  }

  private setProgress(track: Track, points: PathPoint[], key: string) {
    track.progress.visible = true;
    if (track.shownKey === key) return;
    track.shownKey = key;
    // Line2 needs at least two points.
    const pts = points.length >= 2 ? points : [points[0], { ...points[0], x: points[0].x + 0.01 }];
    track.progress.geometry.dispose();
    track.progress.geometry = new LineGeometry().setPositions(this.positions(pts));
  }

  private positions(points: PathPoint[]): number[] {
    const out: number[] = [];
    for (const p of points) out.push(p.x, this.groundY(p), p.z);
    return out;
  }

  private groundY(p: { x: number; z: number }) {
    const hM = this.terrain.heightAt(p.x, p.z) ?? 350;
    return (hM / 1000) * this.exaggeration + LIFT_KM;
  }

  private makeLine(color: THREE.Color, linewidth: number, opts: { opacity: number; renderOrder?: number }) {
    const material = new LineMaterial({
      color: color.getHex(),
      linewidth,
      transparent: true,
      opacity: opts.opacity,
      depthTest: true,
    });
    this.materials.push(material);
    const line = new Line2(new LineGeometry(), material);
    line.renderOrder = opts.renderOrder ?? 0;
    return line;
  }

  private makeFunnel(color: THREE.Color) {
    const funnel = new THREE.Group();
    funnel.visible = false;
    funnel.renderOrder = 11;
    const cone = new THREE.Mesh(
      this.funnelGeometry,
      new THREE.MeshBasicMaterial({
        color: color.clone().lerp(new THREE.Color('#ffffff'), 0.35),
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const ring = new THREE.Mesh(
      this.ringGeometry,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    ring.position.y = 0.05;
    cone.renderOrder = ring.renderOrder = 11;
    funnel.add(cone, ring);
    return funnel;
  }
}

/** Resamples knots every DRAPE_STEP_KM, interpolating time linearly between knots. */
function densify(knots: PathPoint[]): PathPoint[] {
  const out: PathPoint[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / DRAPE_STEP_KM));
    for (let s = 0; s < steps; s++) {
      const f = s / steps;
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, t: a.t + (b.t - a.t) * f });
    }
  }
  out.push(knots[knots.length - 1]);
  if (out.length === 1) out.push({ ...out[0], x: out[0].x + 0.01 });
  return out;
}
