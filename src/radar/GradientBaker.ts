import * as THREE from 'three';

/**
 * Bakes a smoothed gradient volume (3×3×3 Sobel) from a reflectivity volume on
 * the GPU, one slice per draw into a 3D render target. The raymarcher then
 * reads normals with trilinear filtering, which stays continuous across voxel
 * boundaries (differencing the trilinear field directly does not, and its
 * per-cell discontinuities show up as a hatch pattern under lighting).
 *
 * Encoding: rgb = d/ds, d/dt, d/dr in normalised value per voxel, as
 * g * GRADIENT_SCALE * 0.5 + 0.5. Texture axes match the source (s = east,
 * t = south, r = up).
 */
export const GRADIENT_SCALE = 4;

const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform int uLayer;
uniform ivec3 uDims;
uniform float uScale;
out vec4 outColor;

float at(ivec3 c) {
  return texelFetch(uVol, clamp(c, ivec3(0), uDims - 1), 0).r;
}

void main() {
  ivec3 c = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  vec3 g = vec3(0.0);
  // Sobel: central difference along each axis, (1,2,1)-weighted over the other two.
  for (int a = -1; a <= 1; a++) {
    for (int b = -1; b <= 1; b++) {
      float w = float((2 - abs(a)) * (2 - abs(b)));
      g.x += w * (at(c + ivec3(1, a, b)) - at(c + ivec3(-1, a, b)));
      g.y += w * (at(c + ivec3(a, 1, b)) - at(c + ivec3(a, -1, b)));
      g.z += w * (at(c + ivec3(a, b, 1)) - at(c + ivec3(a, b, -1)));
    }
  }
  // Weights sum to 16 and the difference spans 2 voxels.
  g /= 32.0;
  outColor = vec4(clamp(g * uScale * 0.5 + 0.5, 0.0, 1.0), 1.0);
}`;

export class GradientBaker {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uVol: { value: null },
        uLayer: { value: 0 },
        uDims: { value: new THREE.Vector3() },
        uScale: { value: GRADIENT_SCALE },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  createTarget(source: THREE.Data3DTexture): THREE.WebGL3DRenderTarget {
    const { width, height, depth } = source.image;
    const target = new THREE.WebGL3DRenderTarget(width, height, depth, { depthBuffer: false });
    target.texture.minFilter = THREE.LinearFilter;
    target.texture.magFilter = THREE.LinearFilter;
    return target;
  }

  bake(renderer: THREE.WebGLRenderer, source: THREE.Data3DTexture, target: THREE.WebGL3DRenderTarget) {
    const { width, height, depth } = source.image;
    const u = this.material.uniforms;
    u.uVol.value = source;
    // ivec3 uniforms take a Vector3; three uploads it with uniform3i.
    u.uDims.value.set(width, height, depth);

    const previous = renderer.getRenderTarget();
    for (let layer = 0; layer < depth; layer++) {
      u.uLayer.value = layer;
      // For 3D targets the second argument selects the layer.
      renderer.setRenderTarget(target, layer);
      renderer.render(this.scene, this.camera);
    }
    renderer.setRenderTarget(previous);
  }
}
