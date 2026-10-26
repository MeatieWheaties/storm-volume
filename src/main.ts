import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { EVENT, TERRAIN } from './config';
import { lonLatToScene } from './geo/projection';
import { RadarSite } from './overlays/RadarSite';
import { TornadoTracks } from './overlays/TornadoTracks';
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
camera.position.set(focus.x - 10, 28, focus.z + 48);

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
  })
  .catch((err) => console.warn('Failed to load tornado tracks', err));

function renderStats() {
  const s = terrain.stats;
  const rows: Array<[string, string]> = [
    ['Tiles visible', String(s.visible)],
    ['Tiles cached', String(s.cached)],
    ['Loading / queued', `${s.loading} / ${s.queued}`],
    ['Camera altitude', `${camera.position.y.toFixed(1)} km`],
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
}
window.addEventListener('resize', resize);
resize();

let frame = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  terrain.update(camera);
  frame++;
  // Tiles stream in continuously; re-drape tracks and refresh the HUD a few times a second.
  if (frame % 20 === 0) {
    tracks.drape(exaggeration);
    renderStats();
  }
  renderer.render(scene, camera);
});
