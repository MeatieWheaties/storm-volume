import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { EVENT, TERRAIN } from './config';
import { lonLatToScene } from './geo/projection';
import { RadarVolume } from './radar/RadarVolume';
import { drawLegend } from './radar/reflectivity';
import { RadarSite } from './overlays/RadarSite';
import { TornadoTracks, type ActiveTornado } from './overlays/TornadoTracks';
import { TerrainManager } from './terrain/TerrainManager';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const SKY = new THREE.Color('#1a2633');
const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 250, 900);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 3000);
const focus = lonLatToScene(EVENT.focus);
camera.position.set(focus.x + 15, 55, focus.z + 120);

const controls = new MapControls(camera, canvas);
controls.target.set(focus.x, 0, focus.z);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 1;
controls.maxDistance = 1200;
controls.update();

// Late-afternoon sun from the west-southwest, matching a ~20 UTC May event.
scene.add(new THREE.HemisphereLight('#bcd3ee', '#3a2f22', 0.9));
const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
sun.position.set(-300, 220, 120);
scene.add(sun);

const terrain = new TerrainManager();
scene.add(terrain.group);

const tracks = new TornadoTracks(terrain);
scene.add(tracks.group);

const radar = new RadarSite();
scene.add(radar.group);

const volume = new RadarVolume();
scene.add(volume.mesh);

// Terrain-only depth pass; the raymarcher reads it to stop rays at the ground.
const depthTarget = new THREE.WebGLRenderTarget(1, 1, {
  depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
});

// --- HUD -------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const exagInput = $<HTMLInputElement>('exag');
const exagValue = $('exag-value');
const stats = $('stats');
$('event-label').textContent = EVENT.label;

let exaggeration = TERRAIN.defaultExaggeration;
function setExaggeration(value: number) {
  exaggeration = value;
  exagInput.value = String(value);
  exagValue.textContent = `${value}×`;
  terrain.setExaggeration(value);
  radar.setExaggeration(value);
  volume.setTerrainExaggeration(value);
  tracks.drape(value);
}
setExaggeration(exaggeration);
exagInput.addEventListener('input', () => setExaggeration(Number(exagInput.value)));
$<HTMLInputElement>('show-tracks').addEventListener('change', (e) => {
  tracks.group.visible = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('show-radar').addEventListener('change', (e) => {
  radar.group.visible = (e.target as HTMLInputElement).checked;
});

tracks
  .load(`${import.meta.env.BASE_URL}data/tracks.geojson`)
  .then((count) => {
    if (count === 0) console.info('No tracks.geojson yet — run `npm run data:tracks`.');
    // Radar may have loaded first; sync the tracks to the current time.
    if (volume.frames.length > 0) setRadarTime(radarTime);
  })
  .catch((err) => console.warn('Failed to load tornado tracks', err));

// --- Radar volume controls ---------------------------------------------------
const timeInput = $<HTMLInputElement>('time');
const timeLabel = $('time-label');
const playButton = $<HTMLButtonElement>('play');
let radarTime = 0;
let playing = false;
/** Frames advanced per second of wall-clock time during playback. */
const PLAYBACK_FPS = 0.8;

const utcFormat = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});
const cdtFormat = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Chicago',
});

function setRadarTime(t: number) {
  radarTime = t;
  timeInput.value = String(t);
  volume.setTime(t);
  const time = volume.timeAt(t);
  if (time) timeLabel.textContent = `${utcFormat.format(time)} UTC · ${cdtFormat.format(time)} CDT`;
  renderActive(tracks.setTime(time?.getTime() ?? null));
}

const activeList = $('active-tornadoes');
let activeKey = '';
function renderActive(active: ActiveTornado[]) {
  // Rebuild only when the set of tornadoes changes; just move the progress bars otherwise.
  const key = active.map((a) => a.props.id).join(',');
  if (key !== activeKey) {
    activeKey = key;
    activeList.innerHTML = active
      .map(({ props: p }) => {
        const span = `${utcFormat.format(p.timesUtc[0]).slice(0, 5)}–${utcFormat.format(p.timesUtc.at(-1)!).slice(0, 5)} UTC`;
        return `<li data-id="${p.id}"><b class="ef ef${Math.max(p.mag, 0)}">EF${p.mag}</b> ${p.name ?? 'Tornado'}<small>${span}</small><i></i></li>`;
      })
      .join('');
  }
  for (const a of active) {
    const bar = activeList.querySelector<HTMLElement>(`li[data-id="${a.props.id}"] i`);
    if (bar) bar.style.width = `${(a.progress * 100).toFixed(1)}%`;
  }
}

function setPlaying(value: boolean) {
  playing = value;
  playButton.textContent = value ? '❚❚' : '▶';
  playButton.setAttribute('aria-label', value ? 'Pause' : 'Play');
}

function bindRange(id: string, initial: number, format: (v: number) => string, apply: (v: number) => void) {
  const input = $<HTMLInputElement>(id);
  const label = $(`${id}-value`);
  const update = () => {
    const v = Number(input.value);
    label.textContent = format(v);
    apply(v);
  };
  input.value = String(initial);
  input.addEventListener('input', update);
  update();
}

bindRange('opacity', 1, (v) => `${v.toFixed(2)}×`, (v) => volume.setOpacity(v));
bindRange('min-dbz', 20, (v) => `${v} dBZ`, (v) => volume.setMinDbz(v));
bindRange('height', 1.5, (v) => `${v}×`, (v) => volume.setHeightScale(v));
bindRange('shadow', 1, (v) => `${v.toFixed(1)}×`, (v) => volume.setShadowStrength(v));
volume.setSunDirection(sun.position);
$<HTMLInputElement>('lighting').addEventListener('change', (e) => {
  volume.setLighting((e.target as HTMLInputElement).checked);
});
drawLegend($<HTMLCanvasElement>('legend'));

timeInput.addEventListener('input', () => {
  setPlaying(false);
  setRadarTime(Number(timeInput.value));
});
playButton.addEventListener('click', () => {
  if (!playing && radarTime >= volume.frames.length - 1) setRadarTime(0);
  setPlaying(!playing);
});
$<HTMLInputElement>('show-volume').addEventListener('change', (e) => {
  volume.mesh.visible = (e.target as HTMLInputElement).checked && volume.frames.length > 0;
});

volume
  .load(`${import.meta.env.BASE_URL}data/radar/`, (loaded, total) => {
    timeLabel.textContent = `Loading radar ${loaded}/${total}…`;
  })
  .then((frames) => {
    if (frames.length === 0) {
      timeLabel.textContent = 'No radar data — run `npm run data`';
      return;
    }
    timeInput.max = String(frames.length - 1);
    // Open on the scan closest to the Moore touchdown (19:56 UTC).
    const touchdown = Date.UTC(2013, 4, 20, 19, 56);
    const nearest = frames.reduce(
      (best, f, i) =>
        Math.abs(f.time.getTime() - touchdown) < Math.abs(frames[best].time.getTime() - touchdown) ? i : best,
      0,
    );
    setRadarTime(nearest);
  })
  .catch((err) => {
    console.error('Failed to load radar volume', err);
    timeLabel.textContent = 'Radar failed to load';
  });

function renderStats() {
  const s = terrain.stats;
  const rows: Array<[string, string]> = [
    ['Tiles visible', String(s.visible)],
    ['Tiles cached', String(s.cached)],
    ['Loading / queued', `${s.loading} / ${s.queued}`],
    ['Camera altitude', `${camera.position.y.toFixed(1)} km`],
    ['Frame rate', `${fps.toFixed(0)} fps`],
  ];
  stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// --- Loop ------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  tracks.setResolution(w, h);
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  depthTarget.setSize(buffer.x, buffer.y);
}
window.addEventListener('resize', resize);
resize();

let frame = 0;
let fps = 0;
let statsTime = performance.now();
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  tracks.animate(clock.elapsedTime);
  controls.update();
  terrain.update(camera);
  frame++;

  if (playing) {
    const next = radarTime + dt * PLAYBACK_FPS;
    if (next >= volume.frames.length - 1) {
      setRadarTime(volume.frames.length - 1);
      setPlaying(false);
    } else {
      setRadarTime(next);
    }
  }

  if (volume.mesh.visible) {
    renderer.setRenderTarget(depthTarget);
    renderer.render(terrain.group, camera);
    renderer.setRenderTarget(null);
    volume.updateView(renderer, camera, depthTarget.depthTexture!, depthTarget.width, depthTarget.height);
  }
  // Tiles stream in continuously; re-drape tracks and refresh the HUD a few times a second.
  if (frame % 20 === 0) {
    const now = performance.now();
    fps = (20 * 1000) / (now - statsTime);
    statsTime = now;
    tracks.drape(exaggeration);
    renderStats();
  }
  renderer.render(scene, camera);
});
