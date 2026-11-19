/*
 * BeatVision · 背景着色器（WebGL 1 / GLSL ES 1.0）
 * 每个场景只需实现 vec3 scene(vec2 uv)，uv 以画面中心为原点、短边为 ±1。
 * 可用的律动参数：uBass 低频 · uMid 中频 · uHigh 高频 · uBeat 节拍包络 · uLevel 整体能量
 *                 uFlow 随能量加速的流动时间 · uHue 随旋律偏移的色相 · uA/uB/uC 三色配色
 */
(function (global) {
  'use strict';

  const VERT = 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}';

  const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform vec2 uShake;
uniform float uTime, uFlow, uBass, uMid, uHigh, uBeat, uLevel, uHue, uPunch;
uniform vec3 uA, uB, uC;

vec3 pal(float t){
  t = fract(t) * 3.0;
  float k = smoothstep(0.0, 1.0, fract(t));
  if (t < 1.0) return mix(uA, uB, k);
  if (t < 2.0) return mix(uB, uC, k);
  return mix(uC, uA, k);
}
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return v;
}
`;

  const TAIL = `
void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / min(uRes.x, uRes.y);
  uv += uShake;
  uv *= 1.0 - uBeat * 0.07 * uPunch;
  vec3 col = scene(uv);
  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  float vig = smoothstep(1.05, 0.2, length(q * vec2(1.0, 1.1)) * 1.55);
  col *= mix(0.5, 1.0, vig);
  col = 1.0 - exp(-col * 1.25);
  col = pow(col, vec3(0.92));
  gl_FragColor = vec4(col, 1.0);
}
`;

  const SCENES = {};

  // 霓虹隧道：向前穿梭的光环，底鼓让光环变粗、中心爆亮，高频点亮隧道壁的方块
  SCENES.tunnel = `
vec3 scene(vec2 uv){
  float r = length(uv) + 1e-4;
  float a = atan(uv.y, uv.x);
  float z = 0.5 / r;
  float t = uFlow * 0.9;
  float tw = a / 6.2831853 + 0.08 * sin(z * 0.6 + uTime * 0.25);
  vec2 cell = vec2(z * 2.2 + t, tw * 12.0);
  float ring = abs(fract(cell.x) - 0.5);
  float spoke = abs(fract(cell.y) - 0.5);
  float wr = 0.035 + 0.05 * uBeat + 0.03 * uBass;
  float g = wr / ((0.5 - ring) + wr * 0.7) * 0.55 + 0.022 / ((0.5 - spoke) + 0.03) * 0.4;
  float fade = smoothstep(0.04, 0.5, r);
  vec3 col = pal(z * 0.12 + t * 0.12 + uHue) * g * fade * (0.65 + uLevel * 0.9);
  float h = hash(floor(cell));
  float lit = step(0.86 - uHigh * 0.3, h);
  col += pal(h + uHue) * lit * 0.32 * fade * (0.4 + uLevel);
  col += pal(uHue + 0.33) * 0.05 / (r * r + 0.03) * (0.2 + uBeat * 0.9 + uBass * 0.4);
  return col;
}`;

  // 万花筒：不断折叠的分形光纹，随低频膨胀
  SCENES.kaleido = `
vec3 scene(vec2 uv){
  uv *= 0.85;
  vec2 uv0 = uv;
  vec3 col = vec3(0.0);
  uv *= rot(uTime * 0.06);
  for (int k = 0; k < 4; k++) {
    float i = float(k);
    uv = fract(uv * 1.5) - 0.5;
    float d = length(uv) * exp(-length(uv0));
    vec3 c = pal(length(uv0) * 0.35 + i * 0.22 + uFlow * 0.12 + uHue);
    d = abs(sin(d * 8.0 + uFlow * 1.4) / 8.0);
    d = pow((0.009 + 0.008 * uBass + 0.009 * uBeat) / (d + 1e-4), 1.2);
    col += c * d;
  }
  return col * (0.42 + uLevel * 0.5);
}`;

  // 流体：像墨水一样翻涌的色彩，适合旋律性强的段落
  SCENES.liquid = `
vec3 scene(vec2 uv){
  vec2 p = uv * 1.15;
  float t = uFlow * 0.22;
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.7), fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 0.5));
  float f = fbm(p + 3.4 * r * (1.0 + uBass * 0.45));
  vec3 col = pal(f * 0.9 + length(q) * 0.4 + uHue);
  col *= f * f * 2.2 + 0.2;
  col += pal(uHue + 0.5) * pow(length(r), 3.0) * 0.6 * (0.4 + uBeat);
  return col * (0.65 + uLevel * 0.9);
}`;

  // 星际穿越：扑面而来的星群，节拍时星芒炸开
  SCENES.stars = `
vec3 scene(vec2 uv){
  vec3 col = vec3(0.0);
  float t = uFlow * 0.3;
  for (int k = 0; k < 6; k++) {
    float i = float(k) / 6.0;
    float depth = fract(i + t);
    float scale = mix(18.0, 0.5, depth);
    float fade = depth * smoothstep(1.0, 0.9, depth);
    vec2 p = uv * rot(i * 2.4) * scale + i * 453.2;
    vec2 gv = fract(p) - 0.5;
    vec2 id = floor(p);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y));
        float n = hash(id + o);
        float size = fract(n * 345.32);
        vec2 pos = gv - o - vec2(n, fract(n * 34.0)) + 0.5;
        float d = length(pos);
        float m = 0.035 / (d + 0.002);
        float rays = max(0.0, 1.0 - abs(pos.x * pos.y * 900.0)) * (0.25 + uBeat);
        m += rays * 0.5;
        m *= smoothstep(0.9, 0.2, d);
        col += m * size * pal(n + uHue) * fade;
      }
    }
  }
  col += pal(uHue + 0.6) * fbm(uv * 1.5 + t) * 0.14 * (0.4 + uBass);
  return col * (0.7 + uLevel * 0.9);
}`;

  // 合成波：落日 + 无尽网格公路，网格随能量向前飞驰
  SCENES.synth = `
vec3 scene(vec2 uv){
  float hy = -0.25;
  float y = uv.y - hy;
  vec3 col;
  if (y > 0.0) {
    col = mix(uC * 0.28, vec3(0.01, 0.0, 0.04), smoothstep(0.0, 1.6, y));
    vec2 sp = uv * 14.0;
    vec2 id = floor(sp);
    vec2 f = fract(sp) - 0.5;
    float h = hash(id);
    vec2 off = (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6;
    float st = step(0.92, h) * smoothstep(0.1, 0.0, length(f - off));
    col += st * (0.5 + 0.5 * sin(uTime * 2.0 + h * 40.0)) * (0.5 + uHigh);
    vec2 sc = vec2(0.0, hy + 0.62);
    float R = 0.5 + uBeat * 0.035 + uBass * 0.03;
    float d = length(uv - sc);
    float sy = (uv.y - sc.y) / R;
    float bandv = sin((uv.y - sc.y) * 40.0 - uTime * 1.5);
    float thr = mix(-1.3, 0.6, clamp(0.1 - sy, 0.0, 1.0));
    float cut = smoothstep(thr - 0.06, thr + 0.06, bandv);
    float sun = smoothstep(R, R - 0.012, d) * cut;
    vec3 sunCol = mix(uB, uA, clamp(sy * 0.5 + 0.5, 0.0, 1.0)) * 1.35;
    col = mix(col, sunCol, sun);
    col += uB * 0.3 * exp(-max(d - R, 0.0) * 3.0) * (0.5 + uBass);
  } else {
    float z = 1.0 / (-y + 0.015);
    vec2 g = vec2(uv.x * z * 0.7, z * 0.7 + uFlow * 1.5);
    vec2 gf = abs(fract(g) - 0.5);
    float w = 0.03 + z * 0.012;
    float line = smoothstep(0.5 - w, 0.5, max(gf.x, gf.y));
    float fade = exp(-z * 0.09);
    col = uA * line * fade * (0.7 + uBass * 1.6);
    col += uC * 0.1 * fade;
    col += uB * exp(y * 14.0) * (0.5 + uBeat * 0.8);
  }
  return col;
}`;

  // 声波涟漪：从中心扩散的波纹，中频让波纹扭动
  SCENES.ripple = `
vec3 scene(vec2 uv){
  float r = length(uv);
  vec2 dir = uv / (r + 1e-4);
  float wob = (fbm(dir * 1.6 + vec2(uFlow * 0.15, -uFlow * 0.1)) - 0.5) * (0.25 + 0.6 * uMid);
  float d = r + wob;
  float w = sin(d * 12.0 - uFlow * 3.0);
  float line = (0.05 + 0.05 * uBass + 0.06 * uBeat) / (abs(w) + 0.03);
  vec3 col = pal(d * 0.35 - uFlow * 0.05 + uHue) * line * exp(-r * 0.3) * 0.55;
  col += pal(d * 0.35 + uHue + 0.3) * (0.5 + 0.5 * w) * 0.22 * exp(-r * 0.5) * (0.5 + uLevel);
  col += pal(uHue + 0.5) * 0.1 / (r + 0.15) * (0.3 + uBeat);
  return col;
}`;

  // 旋律丝带：纵向流动的光带，摆幅跟随旋律（中频）
  SCENES.ribbon = `
vec3 scene(vec2 uv){
  vec3 col = vec3(0.0);
  float t = uFlow * 0.6;
  for (int k = 0; k < 7; k++) {
    float i = float(k);
    float ph = i * 0.9;
    float amp = (0.22 + 0.5 * uMid + 0.25 * uBass) * (0.6 + 0.4 * sin(i * 1.7 + uTime * 0.3));
    float x = sin(uv.y * (1.2 + i * 0.25) + t * (1.0 + i * 0.13) + ph) * amp
            + sin(uv.y * (3.1 + i * 0.4) - t * 1.7 + ph * 2.0) * 0.12 * (0.3 + uHigh);
    float d = abs(uv.x - x);
    float glow = (0.012 + 0.02 * uBeat) / (d + 0.004);
    glow += 0.25 * exp(-d * 6.0) * (0.3 + uLevel);
    col += pal(i / 7.0 + uv.y * 0.1 + uHue + t * 0.03) * glow * 0.35;
  }
  col += pal(uHue + 0.4) * 0.06 * fbm(uv * 1.3 + t * 0.2);
  return col;
}`;

  // 激光：从顶部扫下来的俱乐部激光束，穿过烟雾，节拍时光束变粗
  SCENES.laser = `
vec3 scene(vec2 uv){
  vec3 col = vec3(0.0);
  vec2 p = uv - vec2(0.0, 1.35);
  float a = atan(p.x, -p.y);
  float r = length(p);
  vec2 p2 = uv + vec2(0.0, 1.6);
  float a2 = atan(p2.x, p2.y);
  float r2 = length(p2);
  float haze = 0.45 + 0.9 * fbm(uv * 1.6 + vec2(uFlow * 0.12, -uFlow * 0.05));
  for (int k = 0; k < 7; k++) {
    float i = float(k);
    float sweep = sin(uFlow * (0.32 + i * 0.06) + i * 1.9) * (0.45 + 0.35 * uMid);
    float d = abs(a - sweep);
    float beam = (0.005 + 0.012 * uBeat) / (d + 0.004) + 0.2 * exp(-d * 10.0);
    col += pal(i / 7.0 + uHue) * beam * haze * 0.42 * (0.5 + uLevel) * smoothstep(0.0, 0.4, r);
    float sweep2 = sin(uFlow * (0.27 + i * 0.05) + i * 2.7 + 1.3) * (0.4 + 0.3 * uMid);
    float d2 = abs(a2 - sweep2);
    float beam2 = (0.004 + 0.01 * uBeat) / (d2 + 0.004) + 0.15 * exp(-d2 * 10.0);
    col += pal(i / 7.0 + 0.5 + uHue) * beam2 * haze * 0.26 * (0.5 + uLevel) * smoothstep(0.0, 0.4, r2);
  }
  col += pal(uHue + 0.5) * haze * 0.16 * (0.3 + uBass);
  col += pal(uHue) * 0.25 * exp(-r * 3.0) * (0.5 + uBeat);
  return col;
}`;

  global.BeatShaders = { VERT, HEAD, TAIL, SCENES };
})(window);
