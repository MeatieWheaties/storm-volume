import * as THREE from 'three';
import { OKLAHOMA_BOUNDS, TERRAIN } from '../config';
import { lonLatToScene, tileForLonLat } from '../geo/projection';
import { TerrainTile } from './TerrainTile';

interface LoadRequest {
  tile: TerrainTile;
  distance: number;
}

/**
 * Quadtree LOD terrain streamer. Each frame it walks the tile tree from the
 * root zoom, splitting tiles near the camera. A tile only swaps to its
 * children once all four are loaded, so the surface never has holes while
 * streaming. Loads are prioritised by distance to the camera.
 */
export class TerrainManager {
  readonly group = new THREE.Group();
  readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });

  private readonly roots: TerrainTile[] = [];
  private readonly tiles = new Map<string, TerrainTile>();
  private readonly clip: { x0: number; z0: number; x1: number; z1: number };
  private readonly visible = new Set<TerrainTile>();
  private requests: LoadRequest[] = [];
  private inFlight = 0;
  private frame = 0;
  private exaggeration = TERRAIN.defaultExaggeration;
  private readonly camLocal = new THREE.Vector3();

  constructor() {
    this.group.name = 'terrain';
    this.group.scale.y = this.exaggeration;

    const nw = lonLatToScene({ lon: OKLAHOMA_BOUNDS.west, lat: OKLAHOMA_BOUNDS.north });
    const se = lonLatToScene({ lon: OKLAHOMA_BOUNDS.east, lat: OKLAHOMA_BOUNDS.south });
    this.clip = { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z };

    const z = TERRAIN.rootZoom;
    const a = tileForLonLat({ lon: OKLAHOMA_BOUNDS.west, lat: OKLAHOMA_BOUNDS.north }, z);
    const b = tileForLonLat({ lon: OKLAHOMA_BOUNDS.east, lat: OKLAHOMA_BOUNDS.south }, z);
    for (let y = a.y; y <= b.y; y++) {
      for (let x = a.x; x <= b.x; x++) this.roots.push(this.getTile(z, x, y));
    }
  }

  get stats() {
    return {
      cached: this.tiles.size,
      visible: this.visible.size,
      loading: this.inFlight,
      queued: this.requests.length,
    };
  }

  setExaggeration(value: number) {
    this.exaggeration = value;
    this.group.scale.y = value;
  }

  /** Elevation in metres at a scene point, from the finest loaded tile. */
  heightAt(sx: number, sz: number): number | null {
    let best: TerrainTile | null = null;
    let level = this.roots.find((t) => contains(t, sx, sz)) ?? null;
    while (level) {
      if (level.state === 'ready') best = level;
      level = level.children?.find((t) => contains(t, sx, sz)) ?? null;
    }
    return best ? best.sampleHeight(sx, sz) : null;
  }

  update(camera: THREE.Camera) {
    this.frame++;
    // Work in the group's local space so vertical exaggeration is accounted for.
    this.camLocal.copy(camera.position);
    this.camLocal.y /= this.exaggeration;

    const previouslyVisible = new Set(this.visible);
    this.visible.clear();
    this.requests = [];
    for (const root of this.roots) this.traverse(root);

    for (const tile of previouslyVisible) {
      if (!this.visible.has(tile) && tile.mesh) tile.mesh.visible = false;
    }
    for (const tile of this.visible) {
      if (!tile.mesh) continue;
      if (!tile.mesh.parent) this.group.add(tile.mesh);
      tile.mesh.visible = true;
    }

    this.pumpLoads();
    if (this.frame % 60 === 0) this.evict();
  }

  private traverse(tile: TerrainTile) {
    tile.lastUsed = this.frame;
    const distance = this.distanceTo(tile);

    if (tile.state !== 'ready') {
      if (tile.state === 'empty') this.requests.push({ tile, distance });
      return;
    }

    const wantSplit = tile.z < TERRAIN.maxZoom && distance < tile.widthKm * TERRAIN.splitFactor;
    if (wantSplit) {
      const children = this.childrenOf(tile);
      let allReady = true;
      for (const child of children) {
        child.lastUsed = this.frame;
        if (child.state === 'empty') this.requests.push({ tile: child, distance: this.distanceTo(child) });
        if (child.state !== 'ready' && child.state !== 'error') allReady = false;
      }
      if (allReady && children.length > 0) {
        for (const child of children) if (child.state === 'ready') this.traverse(child);
        return;
      }
    }
    this.visible.add(tile);
  }

  private childrenOf(tile: TerrainTile): TerrainTile[] {
    if (!tile.children) {
      const z = tile.z + 1;
      const candidates = [
        this.getTile(z, tile.x * 2, tile.y * 2),
        this.getTile(z, tile.x * 2 + 1, tile.y * 2),
        this.getTile(z, tile.x * 2, tile.y * 2 + 1),
        this.getTile(z, tile.x * 2 + 1, tile.y * 2 + 1),
      ];
      // Only refine inside Oklahoma; the parent tile still covers the margin.
      tile.children = candidates.filter((c) => this.intersectsClip(c));
    }
    return tile.children;
  }

  private getTile(z: number, x: number, y: number): TerrainTile {
    const key = `${z}/${x}/${y}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = new TerrainTile(z, x, y);
      this.tiles.set(key, tile);
    }
    return tile;
  }

  private pumpLoads() {
    this.requests.sort((a, b) => a.distance - b.distance);
    for (const { tile } of this.requests) {
      if (this.inFlight >= TERRAIN.maxConcurrentLoads) break;
      if (tile.state !== 'empty') continue;
      this.inFlight++;
      tile.load(this.material).finally(() => this.inFlight--);
    }
  }

  /** Drop least-recently-used tiles (never roots) once the cache is over budget. */
  private evict() {
    const over = this.tiles.size - TERRAIN.maxCachedTiles;
    if (over <= 0) return;
    const candidates = [...this.tiles.values()]
      .filter((t) => t.z > TERRAIN.rootZoom && t.state !== 'loading' && t.lastUsed < this.frame)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, over);
    for (const tile of candidates) {
      tile.dispose();
      this.tiles.delete(tile.key);
      // Detach from parent so the subtree is rebuilt on demand.
      for (const t of this.tiles.values()) {
        if (t.children?.includes(tile)) t.children = null;
      }
    }
  }

  private distanceTo(tile: TerrainTile): number {
    const { x0, z0, x1, z1 } = tile.bounds;
    const c = this.camLocal;
    const dx = Math.max(x0 - c.x, 0, c.x - x1);
    const dz = Math.max(z0 - c.z, 0, c.z - z1);
    const groundKm = tile.state === 'ready' ? tile.maxHeightM / 1000 : 0.4;
    const dy = Math.max(c.y - groundKm, 0) * this.exaggeration;
    return Math.hypot(dx, dy, dz);
  }

  private intersectsClip(tile: TerrainTile): boolean {
    const b = tile.bounds;
    const c = this.clip;
    return b.x1 > c.x0 && b.x0 < c.x1 && b.z1 > c.z0 && b.z0 < c.z1;
  }
}

function contains(tile: TerrainTile, sx: number, sz: number) {
  const b = tile.bounds;
  return sx >= b.x0 && sx < b.x1 && sz >= b.z0 && sz < b.z1;
}
