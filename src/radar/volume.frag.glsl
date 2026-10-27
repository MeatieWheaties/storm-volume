precision highp float;
precision highp sampler3D;

// Two neighbouring radar scans, blended by uMix for smooth playback.
uniform sampler3D uVolA;
uniform sampler3D uVolB;
uniform float uMix;
// 256×1 RGBA lookup indexed by the raw voxel value.
uniform sampler2D uTransfer;

// Terrain depth pre-pass (logarithmic depth buffer).
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uLogDepthFar; // log2(far + 1)
uniform vec3 uCamForward;

uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uVoxelSize; // world km per voxel on each axis
// Pre-baked Sobel gradients for the two scans (see GradientBaker.ts).
uniform sampler3D uGradA;
uniform sampler3D uGradB;
uniform float uGradScale;
uniform float uOpacity;
uniform float uMinValue;
uniform float uMinStep; // km
uniform int uMaxSteps;

// Lighting: direction towards the sun (world space), and 0/1 switch.
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uLighting;
uniform float uShadowStrength;

in vec3 vWorld;
out vec4 outColor;

const float REF_STEP_KM = 0.5; // transfer-function alphas are per 0.5 km of path
const int SHADOW_STEPS = 6;
// Samples below this opacity aren't worth a lighting evaluation.
const float LIGHT_ALPHA_MIN = 0.004;

vec2 intersectBox(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv;
  vec3 t1 = (uBoxMax - ro) * inv;
  vec3 tMin = min(t0, t1);
  vec3 tMax = max(t0, t1);
  return vec2(max(max(tMin.x, tMin.y), tMin.z), min(min(tMax.x, tMax.y), tMax.z));
}

float sampleVolume(vec3 p) {
  vec3 uvw = (p - uBoxMin) / (uBoxMax - uBoxMin);
  // Texture axes: s = east, t = south (rows), r = up (slices).
  vec3 tc = vec3(uvw.x, uvw.z, uvw.y);
  return mix(texture(uVolA, tc).r, texture(uVolB, tc).r, uMix);
}

/** Optical depth for one sample: −ln(1 − α) scaled to the segment length. */
float opticalDepth(float v, float lengthKm) {
  if (v < uMinValue) return 0.0;
  float a = clamp(texture(uTransfer, vec2(v, 0.5)).a * uOpacity, 0.0, 0.999);
  return -log(1.0 - a) * lengthKm / REF_STEP_KM;
}

/** Fraction of sunlight reaching p, from a short ray march towards the sun with growing steps. */
float sunTransmittance(vec3 p, float jitter) {
  float tau = 0.0;
  float stepLen = max(uVoxelSize.y, 0.4);
  // Jittered start turns step banding into noise, like the primary ray.
  float t = (jitter - 1.0) * stepLen;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    t += stepLen;
    vec3 q = p + uSunDir * t;
    if (any(lessThan(q, uBoxMin)) || any(greaterThan(q, uBoxMax))) break;
    tau += opticalDepth(sampleVolume(q), stepLen);
    stepLen *= 1.8;
  }
  return exp(-tau * uShadowStrength);
}

/**
 * World-space gradient from the pre-baked Sobel volumes (see GradientBaker).
 * Trilinear filtering of a stored gradient is continuous across voxels; finite
 * differences of the trilinear field are not, and show a hatch pattern.
 */
vec3 gradient(vec3 p) {
  vec3 uvw = (p - uBoxMin) / (uBoxMax - uBoxMin);
  vec3 tc = vec3(uvw.x, uvw.z, uvw.y);
  vec3 enc = mix(texture(uGradA, tc).rgb, texture(uGradB, tc).rgb, uMix);
  // Per-voxel derivatives along texture axes (s = east, t = south, r = up).
  vec3 g = (enc * 2.0 - 1.0) / uGradScale;
  return vec3(g.x / uVoxelSize.x, g.z / uVoxelSize.y, g.y / uVoxelSize.z);
}

vec3 shade(vec3 albedo, vec3 p, vec3 rd, float jitter) {
  // Ambient sky light, slightly brighter towards the storm top.
  float heightFrac = clamp((p.y - uBoxMin.y) / (uBoxMax.y - uBoxMin.y) * 2.0, 0.0, 1.0);
  vec3 ambient = uAmbient * (0.7 + 0.3 * heightFrac);

  float sun = sunTransmittance(p, jitter);
  vec3 g = gradient(p);
  float gLen = length(g);
  // Echo increases inward, so the outward surface normal is −∇.
  vec3 n = -g / max(gLen, 1e-6);
  float lambert = max(dot(n, uSunDir), 0.0);
  // Inside smooth cores the gradient is noise; fall back to unshaded sunlight there.
  float surface = smoothstep(0.01, 0.05, gLen);
  float diffuse = mix(0.75, lambert, surface);
  // Faint back-scatter keeps the shadowed side from going flat black.
  float rim = pow(1.0 - abs(dot(n, -rd)), 3.0) * surface * 0.25;

  return albedo * (ambient + uSunColor * sun * diffuse) + uSunColor * rim * sun;
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec2 t = intersectBox(ro, rd);
  t.x = max(t.x, 0.0);

  // Stop the ray at the terrain. Log depth stores log2(1 + w) / log2(far + 1).
  float d = texture(uDepth, gl_FragCoord.xy / uResolution).r;
  if (d < 1.0) {
    float viewDepth = exp2(d * uLogDepthFar) - 1.0;
    t.y = min(t.y, viewDepth / dot(rd, uCamForward));
  }
  if (t.x >= t.y) discard;

  float stepLen = max(uMinStep, (t.y - t.x) / float(uMaxSteps));
  // Per-pixel jitter trades banding for fine noise.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float height = uBoxMax.y - uBoxMin.y;

  vec4 acc = vec4(0.0);
  for (int i = 0; i < 2048; i++) {
    if (i >= uMaxSteps) break;
    float tt = t.x + (float(i) + jitter) * stepLen;
    if (tt > t.y) break;
    vec3 p = ro + rd * tt;
    float v = sampleVolume(p);
    if (v < uMinValue) continue;

    vec4 c = texture(uTransfer, vec2(v, 0.5));
    // Opacity correction so the look doesn't change with step size.
    float a = 1.0 - pow(1.0 - clamp(c.a * uOpacity, 0.0, 0.999), stepLen / REF_STEP_KM);

    vec3 rgb;
    if (uLighting > 0.5) {
      // Faint haze isn't worth shadow rays; give it unshadowed light so it blends with lit neighbours.
      rgb = a > LIGHT_ALPHA_MIN ? shade(c.rgb, p, rd, jitter) : c.rgb * (uAmbient + uSunColor * 0.6);
    } else {
      // Unlit: cheap depth cue, tops bright and the base in shadow.
      rgb = c.rgb * (0.55 + 0.45 * clamp((p.y - uBoxMin.y) / height * 2.0, 0.0, 1.0));
    }
    acc.rgb += (1.0 - acc.a) * a * rgb;
    acc.a += (1.0 - acc.a) * a;
    if (acc.a > 0.98) break;
  }
  if (acc.a < 0.002) discard;
  outColor = acc;
}
