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
uniform float uOpacity;
uniform float uMinValue;
uniform float uMinStep; // km
uniform int uMaxSteps;

in vec3 vWorld;
out vec4 outColor;

const float REF_STEP_KM = 0.5; // transfer-function alphas are per 0.5 km of path

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
    // Cheap depth cue: tops are sunlit, the base sits in the storm's shadow.
    float light = 0.55 + 0.45 * clamp((p.y - uBoxMin.y) / height * 2.0, 0.0, 1.0);
    acc.rgb += (1.0 - acc.a) * a * c.rgb * light;
    acc.a += (1.0 - acc.a) * a;
    if (acc.a > 0.98) break;
  }
  if (acc.a < 0.002) discard;
  outColor = acc;
}
