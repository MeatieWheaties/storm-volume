import * as THREE from 'three';
import { RADAR_SITE } from '../config';
import { GRADIENT_SCALE, GradientBaker } from './GradientBaker';
import { createTransferTexture, dbzToValue } from './reflectivity';
import fragmentShader from './volume.frag.glsl?raw';
import vertexShader from './volume.vert.glsl?raw';

/** Shape of public/data/radar/index.json (written by scripts/bake-radar.mjs). */
interface RadarIndex {
  station: string;
  dims: { x: number; y: number; z: number };
  bounds: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number };
  frames: Array<{ id: string; file: string; timeUtc: string }>;
}

export interface RadarFrame {
  id: string;
  time: Date;
  texture: THREE.Data3DTexture;
}

/** Radar antenna height above sea level (km), used to seat the volume on exaggerated terrain. */
const SITE_GROUND_KM = 0.37;
const MAX_STEPS = 640;

/**
 * Front-to-back raymarched reflectivity volume. The box's back faces are drawn
 * so every covered pixel gets exactly one ray, even with the camera inside.
 * Rays are clipped by a terrain depth pre-pass, so mountains and ridges hide
 * echoes behind them.
 */
export class RadarVolume {
  readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
  frames: RadarFrame[] = [];
  private index: RadarIndex | null = null;
  private readonly boxMin = new THREE.Vector3();
  private readonly boxMax = new THREE.Vector3();
  private readonly box = new THREE.Box3();
  private heightScale = 2;
  private terrainExaggeration = 1;
  private readonly gradientBaker = new GradientBaker();
  /** Two gradient volumes, one per displayed scan, re-baked only when the scan pair changes. */
  private readonly gradientSlots: Array<{ frame: number; target: THREE.WebGL3DRenderTarget | null }> = [
    { frame: -1, target: null },
    { frame: -1, target: null },
  ];
  private frameA = 0;
  private frameB = 0;

  constructor() {
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uVolA: { value: null },
        uVolB: { value: null },
        uMix: { value: 0 },
        uTransfer: { value: createTransferTexture() },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uLogDepthFar: { value: 1 },
        uCamForward: { value: new THREE.Vector3() },
        uBoxMin: { value: this.boxMin },
        uBoxMax: { value: this.boxMax },
        uOpacity: { value: 1 },
        uMinValue: { value: dbzToValue(15) / 255 },
        uMinStep: { value: 0.25 },
        uMaxSteps: { value: MAX_STEPS },
        uVoxelSize: { value: new THREE.Vector3(1, 1, 1) },
        uGradA: { value: null },
        uGradB: { value: null },
        uGradScale: { value: GRADIENT_SCALE },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color('#fff1dc').multiplyScalar(0.95) },
        uAmbient: { value: new THREE.Color('#9fb4cf').multiplyScalar(0.38) },
        uLighting: { value: 1 },
        uShadowStrength: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    this.mesh.name = `radar volume ${RADAR_SITE.id}`;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  get uniforms() {
    return this.mesh.material.uniforms;
  }

  /** Loads every frame up front so scrubbing is instant (~5 MB gzipped for the Moore window). */
  async load(baseUrl: string, onProgress?: (loaded: number, total: number) => void): Promise<RadarFrame[]> {
    const res = await fetch(`${baseUrl}index.json`);
    if (!res.ok) return [];
    const index = (this.index = (await res.json()) as RadarIndex);

    let loaded = 0;
    this.frames = await Promise.all(
      index.frames.map(async (f) => {
        const voxels = await fetchVoxels(`${baseUrl}${f.file}`);
        const expected = index.dims.x * index.dims.y * index.dims.z;
        if (voxels.length !== expected) throw new Error(`${f.file}: ${voxels.length} voxels, expected ${expected}`);
        const texture = new THREE.Data3DTexture(voxels, index.dims.x, index.dims.z, index.dims.y);
        texture.format = THREE.RedFormat;
        texture.type = THREE.UnsignedByteType;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.unpackAlignment = 1;
        texture.needsUpdate = true;
        onProgress?.(++loaded, index.frames.length);
        return { id: f.id, time: new Date(f.timeUtc), texture };
      }),
    );

    this.layout();
    this.setTime(0);
    this.mesh.visible = this.frames.length > 0;
    return this.frames;
  }

  /** Fractional frame index; blends the two neighbouring scans. */
  setTime(t: number) {
    if (this.frames.length === 0) return;
    const i = Math.min(Math.floor(t), this.frames.length - 1);
    const j = Math.min(i + 1, this.frames.length - 1);
    this.uniforms.uVolA.value = this.frames[i].texture;
    this.uniforms.uVolB.value = this.frames[j].texture;
    this.uniforms.uMix.value = t - i;
    this.frameA = i;
    this.frameB = j;
  }

  /** Interpolated wall-clock time for a fractional frame index. */
  timeAt(t: number): Date | null {
    if (this.frames.length === 0) return null;
    const i = Math.min(Math.floor(t), this.frames.length - 1);
    const j = Math.min(i + 1, this.frames.length - 1);
    const a = this.frames[i].time.getTime();
    const b = this.frames[j].time.getTime();
    return new Date(a + (b - a) * (t - i));
  }

  setOpacity(value: number) {
    this.uniforms.uOpacity.value = value;
  }

  setMinDbz(dbz: number) {
    this.uniforms.uMinValue.value = dbzToValue(dbz) / 255;
  }

  /** Vertical stretch for the storm, independent of terrain exaggeration. */
  setHeightScale(value: number) {
    this.heightScale = value;
    this.layout();
  }

  /** Toggles gradient shading + sun shadow rays (off = flat colour with a height cue, cheaper). */
  setLighting(enabled: boolean) {
    this.uniforms.uLighting.value = enabled ? 1 : 0;
  }

  /** World-space direction towards the sun; shared with the scene's directional light. */
  setSunDirection(dir: THREE.Vector3) {
    this.uniforms.uSunDir.value.copy(dir).normalize();
  }

  /** Scales optical depth along shadow rays: 0 = no shadows, 1 = physically consistent with the view opacity. */
  setShadowStrength(value: number) {
    this.uniforms.uShadowStrength.value = value;
  }

  setTerrainExaggeration(value: number) {
    this.terrainExaggeration = value;
    this.layout();
  }

  /** Per-frame camera/target state for the raymarcher; also bakes gradients for newly shown scans. */
  updateView(
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    depth: THREE.DepthTexture,
    width: number,
    height: number,
  ) {
    const u = this.uniforms;
    if (this.frames.length > 0 && u.uLighting.value > 0.5) {
      u.uGradA.value = this.gradientFor(renderer, this.frameA, this.frameB);
      u.uGradB.value = this.gradientFor(renderer, this.frameB, this.frameA);
    }
    u.uDepth.value = depth;
    u.uResolution.value.set(width, height);
    u.uLogDepthFar.value = Math.log2(camera.far + 1);
    camera.getWorldDirection(u.uCamForward.value);
  }

  /**
   * Gradient texture for `frame`, reusing a slot that already holds it. During
   * playback the next pair shares one scan with the current pair, so each step
   * bakes only one new volume (40 slice draws).
   */
  private gradientFor(renderer: THREE.WebGLRenderer, frame: number, keep: number): THREE.Texture {
    let slot = this.gradientSlots.find((s) => s.frame === frame);
    if (!slot) {
      // Evict whichever slot isn't holding the partner frame.
      slot = this.gradientSlots.find((s) => s.frame !== keep) ?? this.gradientSlots[0];
      const source = this.frames[frame].texture;
      slot.target ??= this.gradientBaker.createTarget(source);
      this.gradientBaker.bake(renderer, source, slot.target);
      slot.frame = frame;
    }
    return slot.target!.texture;
  }

  private layout() {
    if (!this.index) return;
    const b = this.index.bounds;
    // Lift the volume so its sea-level base sits on the exaggerated ground at the radar site.
    const lift = (this.terrainExaggeration - 1) * SITE_GROUND_KM;
    this.box.min.set(b.x0, lift + b.y0 * this.heightScale, b.z0);
    this.box.max.set(b.x1, lift + b.y1 * this.heightScale, b.z1);
    this.boxMin.copy(this.box.min);
    this.boxMax.copy(this.box.max);
    this.box.getCenter(this.mesh.position);
    this.box.getSize(this.mesh.scale);
    const { dims } = this.index;
    this.uniforms.uVoxelSize.value.set(this.mesh.scale.x / dims.x, this.mesh.scale.y / dims.y, this.mesh.scale.z / dims.z);
  }
}

/** Fetches a voxel frame, inflating gzip ourselves unless the server already did. */
async function fetchVoxels(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
