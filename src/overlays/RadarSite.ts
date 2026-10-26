import * as THREE from 'three';
import { RADAR_SITE } from '../config';
import { lonLatToScene } from '../geo/projection';

const TOWER_HEIGHT_KM = 3;
const RINGS_KM = [50, 100, 150, 230];

/**
 * KTLX site marker with range rings. Placeholder until the baked radar volume
 * is rendered (see scripts/bake-radar.mjs and docs/ROADMAP.md).
 */
export class RadarSite {
  readonly group = new THREE.Group();

  constructor() {
    this.group.name = `radar ${RADAR_SITE.id}`;
    const { x, z } = lonLatToScene(RADAR_SITE.position);
    this.group.position.set(x, 0, z);

    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, TOWER_HEIGHT_KM, 12),
      new THREE.MeshBasicMaterial({ color: '#ff5a3c' }),
    );
    tower.position.y = TOWER_HEIGHT_KM / 2;
    this.group.add(tower);

    const ringMaterial = new THREE.LineBasicMaterial({
      color: '#ff5a3c',
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    for (const r of RINGS_KM) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 256; i++) {
        const a = (i / 256) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMaterial));
    }
  }

  /** Rings float just above the highest terrain in range so they stay visible. */
  setExaggeration(exaggeration: number) {
    for (const child of this.group.children) {
      if (child instanceof THREE.Line) child.position.y = 0.6 * exaggeration;
    }
  }
}
