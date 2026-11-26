/**
 * realtime_renderer.js — Bộ Xử Lý Đồ Họa Realtime, Bầu Trời Khí Quyển, Mặt Nước GPU & Hậu Kỳ Mượt 60 FPS
 * Dự án: DALAT_3D_SIMULATION
 * ============================================================================
 * Thiết kế thuần Three.js r128 (Zero-CDN dependency, 0ms shader recompile):
 *   1. Procedural Highland Sky Dome + Đĩa Mặt Trời / Tán xạ Mie + Sao đêm Đà Lạt (1 draw call, khớp tuyệt đối màu FogExp2)
 *   2. PBR Environment Reflection (PMREMGenerator IBL dùng MeshBasicMaterial vertexColors chuẩn RGBM16 r128, cache theo khí hậu)
 *   3. GPU Animated Water Surface (onBeforeCompile gợn sóng đa hướng + phản xạ Fresnel + lấp lánh nắng, chống NaN tuyệt đối)
 *   4. Stabilized Camera-Following Sun Shadows (bám theo tâm nhìn Camera có khóa lưới texel chống rung bóng,
 *      kết hợp cơ chế cache shadowMap thông minh giảm ~40% draw calls khi đứng yên)
 *   5. Hậu kỳ GPU siêu nhẹ (Quarter-Res Separable Bloom RGBA8 + Quầng nắng khí quyển + Vignette nhẹ, giữ nguyên pipeline sRGB)
 *   6. Bộ điều tốc Adaptive DPR tự động giữ khung hình mượt mà (Siêu mượt / Cân bằng / Realtime Ultra)
 */

(function (global) {
  'use strict';

  const QUALITY_PRESETS = {
    fast: {
      id: 'fast',
      label_vi: 'Siêu mượt',
      badge_vi: '⚡ Siêu mượt',
      desc_vi: 'Ưu tiên 60 FPS tối đa • Tắt bóng đổ & hậu kỳ nặng',
      minDpr: 0.75,
      maxDpr: 1.1,
      shadows: false,
      shadowMapSize: 512,
      shadowEveryFrame: false,
      shadowFrustumNearM: 1100,
      bloom: false,
      bloomStrength: 0.0,
      envReflection: false,
      waterQuality: 0.45,
      lodScale: 0.78,
      maxConcurrentStreams: 3,
    },
    balanced: {
      id: 'balanced',
      label_vi: 'Cân bằng',
      badge_vi: '✦ Realtime Cân bằng',
      desc_vi: 'PBR Sky IBL • Bóng mềm thông minh • Hậu kỳ Bloom nhẹ GPU',
      minDpr: 0.9,
      maxDpr: 1.75,
      shadows: true,
      shadowMapSize: 1024,
      shadowEveryFrame: false,
      shadowFrustumNearM: 1250,
      bloom: true,
      bloomStrength: 0.24,
      envReflection: true,
      waterQuality: 1.0,
      lodScale: 1.0,
      maxConcurrentStreams: 4,
    },
    ultra: {
      id: 'ultra',
      label_vi: 'Realtime Ultra',
      badge_vi: '💎 Realtime Ultra',
      desc_vi: 'Bóng đổ nét 2K • Phản xạ PBR đầy đủ • Bloom & Tán xạ khí quyển',
      minDpr: 1.15,
      maxDpr: 2.0,
      shadows: true,
      shadowMapSize: 2048,
      shadowEveryFrame: true,
      shadowFrustumNearM: 1050,
      bloom: true,
      bloomStrength: 0.36,
      envReflection: true,
      waterQuality: 1.35,
      lodScale: 1.2,
      maxConcurrentStreams: 6,
    },
  };

  const SKY_BASE_URL = './assets/sky';
  const SKY_TEXTURE_FILES = {
    morning: 'sky_morning.jpg',
    day: 'sky_day.jpg',
    sunset: 'sky_sunset.jpg',
    dusk: 'sky_dusk.jpg',
    night: 'sky_night.jpg',
  };

  // Bảng màu khí quyển cao nguyên chi tiết (đồng bộ ảnh bầu trời 360° Poly Haven CC0 + FogExp2)
  const CLIMATE_SKY_PALETTES = {
    early_mist: {
      skyId: 'morning',
      zenith: '#628FBD',
      horizon: '#DCE7F0',
      ground: '#3D5443',
      sunGlow: '#FFE6BE',
      skyTint: '#FFF6EB',
      skyExposure: 1.07,
      cloudColor: '#FFF4E6',
      cloudOpacity: 0.22,
      horizonHazeFactor: 0.72,
      starIntensity: 0.0,
      exposure: 1.06,
      bloomThreshold: 0.78,
      sunShaftStrength: 0.2,
    },
    highland_noon: {
      skyId: 'day',
      zenith: '#2567AF',
      horizon: '#B9D8F0',
      ground: '#3B5A3A',
      sunGlow: '#FFFDF4',
      skyTint: '#F5FAFF',
      skyExposure: 1.05,
      cloudColor: '#FFFFFF',
      cloudOpacity: 0.16,
      horizonHazeFactor: 0.44,
      starIntensity: 0.0,
      exposure: 1.04,
      bloomThreshold: 0.84,
      sunShaftStrength: 0.12,
    },
    sunset_lake: {
      skyId: 'sunset',
      zenith: '#333B6E',
      horizon: '#E39B7E',
      ground: '#3E2E37',
      sunGlow: '#FFA057',
      skyTint: '#FFE3CC',
      skyExposure: 1.04,
      cloudColor: '#FFC694',
      cloudOpacity: 0.24,
      horizonHazeFactor: 0.58,
      starIntensity: 0.14,
      exposure: 1.08,
      bloomThreshold: 0.7,
      sunShaftStrength: 0.3,
    },
    mountain_night: {
      skyId: 'night',
      zenith: '#050B18',
      horizon: '#101E38',
      ground: '#091220',
      sunGlow: '#8FB2E4',
      skyTint: '#9AB8E6',
      skyExposure: 0.68,
      cloudColor: '#374D75',
      cloudOpacity: 0.08,
      horizonHazeFactor: 0.68,
      starIntensity: 0.95,
      exposure: 1.12,
      bloomThreshold: 0.54,
      sunShaftStrength: 0.08,
    },
  };

  const SKY_OVERRIDE_TUNING = {
    morning: { skyTint: '#FFF6EB', skyExposure: 1.07, cloudColor: '#FFF4E6', cloudOpacity: 0.22, starIntensity: 0.0 },
    day: { skyTint: '#F5FAFF', skyExposure: 1.05, cloudColor: '#FFFFFF', cloudOpacity: 0.16, starIntensity: 0.0 },
    sunset: { skyTint: '#FFE3CC', skyExposure: 1.04, cloudColor: '#FFC694', cloudOpacity: 0.24, starIntensity: 0.12 },
    dusk: { skyTint: '#F0D8EE', skyExposure: 1.04, cloudColor: '#E5B2D4', cloudOpacity: 0.22, starIntensity: 0.26 },
    night: { skyTint: '#9AB8E6', skyExposure: 0.68, cloudColor: '#374D75', cloudOpacity: 0.08, starIntensity: 0.95 },
  };

  const SKY_VERTEX_SHADER = [
    'varying vec3 vWorldDir;',
    'void main() {',
    '  vWorldDir = position;',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '}',
  ].join('\n');

  // Shader bầu trời 360° kết hợp ảnh Pure Sky Poly Haven CC0 + mây trôi cao nguyên + sương mù chân trời
  // Xuất trực tiếp không gian sRGB đồng bộ 100% với FogExp2 của Three.js r128, chống NaN tuyệt đối
  const SKY_FRAGMENT_SHADER = [
    'uniform sampler2D uSkyTexA;',
    'uniform sampler2D uSkyTexB;',
    'uniform float uSkyReadyA;',
    'uniform float uSkyReadyB;',
    'uniform float uSkyBlend;',
    'uniform float uSunAzimuth;',
    'uniform float uSkyDrift;',
    'uniform vec3 uSkyTint;',
    'uniform float uSkyExposure;',
    'uniform vec3 uZenithColor;',
    'uniform vec3 uHorizonColor;',
    'uniform vec3 uGroundColor;',
    'uniform vec3 uFogColor;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunGlowColor;',
    'uniform vec3 uCloudColor;',
    'uniform float uCloudOpacity;',
    'uniform float uFogBlend;',
    'uniform float uHorizonHazeFactor;',
    'uniform float uStarIntensity;',
    'uniform float uTime;',
    'varying vec3 vWorldDir;',
    '',
    'const float PI = 3.14159265359;',
    'const float TWO_PI = 6.28318530718;',
    '',
    'float hash31(vec3 p) {',
    '  p = fract(p * 0.1031);',
    '  p += dot(p, p.yzx + 33.33);',
    '  return fract((p.x + p.y) * p.z);',
    '}',
    '',
    'float hash21(vec2 p) {',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    '',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash21(i);',
    '  float b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0));',
    '  float d = hash21(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    '',
    'float cloudFbm(vec2 p) {',
    '  float v = 0.0;',
    '  float a = 0.52;',
    '  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);',
    '  for (int i = 0; i < 3; i++) {',
    '    v += a * vnoise(p);',
    '    p = rot * p * 2.07 + vec2(13.1, 7.7);',
    '    a *= 0.48;',
    '  }',
    '  return v;',
    '}',
    '',
    'void main() {',
    '  vec3 dir = normalize(vWorldDir);',
    '  float y = dir.y;',
    '',
    '  // 1. Nền bầu trời khí quyển dự phòng (hiển thị tức thì trước khi ảnh 360° tải xong)',
    '  float upperT = pow(max(y, 0.0001), 0.55);',
    '  vec3 procSky = mix(uHorizonColor, uZenithColor, clamp(upperT, 0.0, 1.0));',
    '  if (y < 0.0) {',
    '    float downT = pow(clamp(-y * 3.0, 0.0001, 1.0), 0.65);',
    '    procSky = mix(uHorizonColor, uGroundColor, downT);',
    '  }',
    '',
    '  // 2. Lấy mẫu bầu trời ảnh thực tế 360° (căn chỉnh góc phương vị mặt trời khớp hướng nắng 3D)',
    '  float az = atan(dir.x, -dir.z);',
    '  float relAz = az - uSunAzimuth + uSkyDrift;',
    '  float eqU = fract(relAz / TWO_PI + 0.5);',
    '  float elev = asin(clamp(y, -1.0, 1.0));',
    '  float eqV = clamp(elev / PI + 0.504, 0.002, 0.998);',
    '  vec2 eqUv = vec2(eqU, eqV);',
    '',
    '  vec3 texColA = mix(procSky, texture2D(uSkyTexA, eqUv).rgb * uSkyTint * uSkyExposure, clamp(uSkyReadyA, 0.0, 1.0));',
    '  vec3 texColB = mix(procSky, texture2D(uSkyTexB, eqUv).rgb * uSkyTint * uSkyExposure, clamp(uSkyReadyB, 0.0, 1.0));',
    '  float hasPhoto = max(uSkyReadyA * (1.0 - uSkyBlend), uSkyReadyB * uSkyBlend);',
    '  vec3 skyCol = mix(texColA, texColB, clamp(uSkyBlend, 0.0, 1.0));',
    '',
    '  if (y < 0.0) {',
    '    float downBlend = smoothstep(0.0, -0.14, y);',
    '    skyCol = mix(skyCol, mix(uFogColor, uGroundColor, 0.45), downBlend);',
    '  }',
    '',
    '  // 3. Lớp mây cao nguyên trôi nhẹ theo thời gian thực để đại cảnh luôn sống động',
    '  vec3 sunDir = normalize(uSunDir);',
    '  float cosTheta = max(dot(dir, sunDir), 0.0001);',
    '  if (uCloudOpacity > 0.01 && y > 0.012) {',
    '    vec2 cloudPlane = dir.xz / (y + 0.24);',
    '    vec2 drift1 = vec2(uTime * 0.0075, uTime * 0.0032);',
    '    vec2 drift2 = vec2(-uTime * 0.0042, uTime * 0.0055);',
    '    float n1 = cloudFbm(cloudPlane * 0.48 + drift1);',
    '    float n2 = cloudFbm(cloudPlane * 0.92 + drift2);',
    '    float wispy = smoothstep(0.50, 0.82, n1 * 0.68 + n2 * 0.32);',
    '    float elevMask = smoothstep(0.012, 0.16, y) * (1.0 - smoothstep(0.75, 0.98, y) * 0.35);',
    '    float sunRim = 0.78 + 0.36 * pow(cosTheta, 3.5);',
    '    vec3 litCloud = min(vec3(1.0), uCloudColor * sunRim);',
    '    skyCol = mix(skyCol, litCloud, clamp(wispy * elevMask * uCloudOpacity, 0.0, 0.42));',
    '  }',
    '',
    '  // 4. Tán xạ khí quyển Mie & đĩa Mặt trời / Mặt trăng (hài hòa với ảnh bầu trời 360°)',
    '  float haloScale = mix(1.0, 0.46, clamp(hasPhoto, 0.0, 1.0));',
    '  float mieHalo = (pow(cosTheta, 6.0) * 0.18 + pow(cosTheta, 42.0) * 0.30) * haloScale;',
    '  float sunDisc = smoothstep(0.99935, 0.99985, cosTheta) * mix(0.95, 0.65, clamp(hasPhoto, 0.0, 1.0));',
    '  float aboveHorizon = smoothstep(-0.04, 0.05, y);',
    '  skyCol = min(vec3(1.0), skyCol + uSunGlowColor * (mieHalo + sunDisc) * aboveHorizon);',
    '',
    '  // 5. Sao đêm lấp lánh dạng điểm tròn sắc nét trên bầu trời phố núi Đà Lạt',
    '  if (uStarIntensity > 0.01 && y > 0.04) {',
    '    vec3 starGrid = dir * 210.0;',
    '    vec3 starCell = floor(starGrid);',
    '    vec3 starLocal = fract(starGrid) - 0.5;',
    '    float rnd = hash31(starCell);',
    '    if (rnd > 0.991) {',
    '      float core = smoothstep(0.22, 0.03, length(starLocal));',
    '      float twinkle = 0.60 + 0.40 * sin(uTime * 2.4 + rnd * 95.0);',
    '      float starFade = smoothstep(0.04, 0.30, y) * (1.0 - clamp(uFogBlend * 0.65, 0.0, 0.8));',
    '      skyCol = min(vec3(1.0), skyCol + vec3(0.88, 0.94, 1.0) * core * ((rnd - 0.991) * 95.0) * twinkle * uStarIntensity * starFade);',
    '    }',
    '  }',
    '',
    '  // 6. Dải sương mù chân trời tinh tế — liền mạch tuyệt đối với FogExp2 nhưng không che khuất mây trời',
    '  float fb = clamp(uFogBlend, 0.0, 1.0);',
    '  float horizonMist = exp(-max(y, 0.0) * mix(30.0, 13.5, fb)) * fb * uHorizonHazeFactor;',
    '  if (y < 0.0) {',
    '    horizonMist = max(horizonMist, smoothstep(0.0, -0.05, y) * 0.92);',
    '  }',
    '  skyCol = mix(skyCol, uFogColor, clamp(horizonMist, 0.0, 0.95));',
    '',
    '  gl_FragColor = vec4(clamp(skyCol, 0.0, 1.0), 1.0);',
    '}',
  ].join('\n');

  const POST_QUAD_VERTEX = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}',
  ].join('\n');

  const BLOOM_PREFILTER_FRAGMENT = [
    'uniform sampler2D tDiffuse;',
    'uniform float uThreshold;',
    'uniform vec2 uTexelSize;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 c0 = texture2D(tDiffuse, vUv + vec2(-0.5, -0.5) * uTexelSize).rgb;',
    '  vec3 c1 = texture2D(tDiffuse, vUv + vec2( 0.5, -0.5) * uTexelSize).rgb;',
    '  vec3 c2 = texture2D(tDiffuse, vUv + vec2(-0.5,  0.5) * uTexelSize).rgb;',
    '  vec3 c3 = texture2D(tDiffuse, vUv + vec2( 0.5,  0.5) * uTexelSize).rgb;',
    '  vec3 col = 0.25 * (c0 + c1 + c2 + c3);',
    '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  float knee = uThreshold * 0.35 + 0.001;',
    '  float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);',
    '  soft = (soft * soft) / (4.0 * knee);',
    '  float contrib = max(soft, lum - uThreshold) / max(lum, 0.001);',
    '  gl_FragColor = vec4(clamp(col * clamp(contrib, 0.0, 1.5), 0.0, 1.0), 1.0);',
    '}',
  ].join('\n');

  const BLOOM_BLUR_FRAGMENT = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uDirection;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;',
    '  vec2 off1 = uDirection * 1.384615;',
    '  vec2 off2 = uDirection * 3.230769;',
    '  sum += texture2D(tDiffuse, vUv + off1).rgb * 0.316216;',
    '  sum += texture2D(tDiffuse, vUv - off1).rgb * 0.316216;',
    '  sum += texture2D(tDiffuse, vUv + off2).rgb * 0.070270;',
    '  sum += texture2D(tDiffuse, vUv - off2).rgb * 0.070270;',
    '  gl_FragColor = vec4(sum, 1.0);',
    '}',
  ].join('\n');

  const COMPOSITE_FRAGMENT = [
    'uniform sampler2D tScene;',
    'uniform sampler2D tBloom;',
    'uniform float uBloomStrength;',
    'uniform vec2 uSunScreenPos;',
    'uniform float uSunVisible;',
    'uniform vec3 uSunGlowColor;',
    'uniform float uAspect;',
    'varying vec2 vUv;',
    '',
    'void main() {',
    '  vec3 col = texture2D(tScene, vUv).rgb;',
    '  if (uBloomStrength > 0.001) {',
    '    vec3 bloom = texture2D(tBloom, vUv).rgb;',
    '    // Soft screen-like additive blend chống cháy sáng trắng',
    '    col += bloom * uBloomStrength * (vec3(1.0) - col * 0.35);',
    '  }',
    '',
    '  if (uSunVisible > 0.001) {',
    '    vec2 delta = vUv - uSunScreenPos;',
    '    delta.x *= uAspect;',
    '    float dist = length(delta);',
    '    float radialGlow = exp(-dist * 3.4) * 0.14 + exp(-dist * 9.5) * 0.09;',
    '    col += uSunGlowColor * radialGlow * uSunVisible * (vec3(1.0) - col * 0.3);',
    '  }',
    '',
    '  vec2 centered = vUv - 0.5;',
    '  float vig = 1.0 - dot(centered, centered) * 0.14;',
    '  col *= clamp(vig, 0.88, 1.0);',
    '',
    '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}',
  ].join('\n');

  class DalatRealtimeRenderer {
    constructor(engine) {
      this.engine = engine;
      this.renderer = engine.renderer;
      this.scene = engine.scene;
      this.camera = engine.camera;

      // Khóa cố định cấu hình toneMapping & sRGBEncoding để không bao giờ biên dịch lại shader khi đổi chế độ
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.06;

      this.qualityId = 'balanced';
      this.autoFps = true;
      this.bloomEnabled = true;
      this.shadowsEnabled = true;

      const nativeDpr = Math.min(window.devicePixelRatio || 1, 2.0);
      this.currentDpr = Math.min(nativeDpr, QUALITY_PRESETS.balanced.maxDpr);
      this.currentFps = 60;
      this._highFpsStreakSec = 0;
      this._lowFpsCooldownSec = 0;

      // Shared uniforms cho toàn bộ mặt nước GLB & Fallback (cập nhật 1 lần/frame trên GPU)
      this.waterSharedUniforms = {
        uWaterTime: { value: 0.0 },
        uWaterSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.5).normalize() },
        uWaterSunColor: { value: new THREE.Color(0xffe2b0) },
        uWaterSkyColor: { value: new THREE.Color(0xdce6ee) },
        uWaterQuality: { value: 1.0 },
      };

      this._lastShadowFocus = new THREE.Vector3(999999, 999999, 999999);
      this._shadowDirty = true;
      this._shadowFrameCounter = 0;

      this._pmremGenerator = null;
      this._envCache = new Map();
      this._activeClimateId = 'early_mist';
      this._activeClimatePreset = null;
      this._skyOverride = 'auto';
      this._currentSkyId = 'morning';
      this._prevSkyId = 'morning';
      this._skyBlend = 1.0;
      this._lastFrameTime = 0;
      this._currentSunShaftStrength = 0.2;

      this._skyTexLoader = new THREE.TextureLoader();
      this._skyTextures = new Map();
      this._skyLoaded = new Set();
      this._skyPlaceholderTex = new THREE.DataTexture(
        new Uint8Array([136, 174, 212, 255]),
        1,
        1,
        THREE.RGBAFormat
      );
      this._skyPlaceholderTex.needsUpdate = true;

      this._sceneRT = null;
      this._bloomRTA = null;
      this._bloomRTB = null;
      this._postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._postQuadGeo = new THREE.PlaneGeometry(2, 2);
      this._sunProjVec = new THREE.Vector3();

      this._initSkyDome();
      this._initPostMaterials();
      this._initPmrem();
      this._allocateRenderTargets();
      this._preloadSkyTextures();
      this.applyQualityPreset('balanced');
    }

    _initSkyDome() {
      this.skyUniforms = {
        uSkyTexA: { value: this._skyPlaceholderTex },
        uSkyTexB: { value: this._skyPlaceholderTex },
        uSkyReadyA: { value: 0.0 },
        uSkyReadyB: { value: 0.0 },
        uSkyBlend: { value: 1.0 },
        uSunAzimuth: { value: 1.43 },
        uSkyDrift: { value: 0.0 },
        uSkyTint: { value: new THREE.Color('#FFF6EB') },
        uSkyExposure: { value: 1.07 },
        uZenithColor: { value: new THREE.Color('#628FBD') },
        uHorizonColor: { value: new THREE.Color('#DCE7F0') },
        uGroundColor: { value: new THREE.Color('#3D5443') },
        uFogColor: { value: new THREE.Color('#DCE6EE') },
        uSunDir: { value: new THREE.Vector3(0.5, 0.35, -0.4).normalize() },
        uSunGlowColor: { value: new THREE.Color('#FFE6BE') },
        uCloudColor: { value: new THREE.Color('#FFF4E6') },
        uCloudOpacity: { value: 0.22 },
        uFogBlend: { value: 0.65 },
        uHorizonHazeFactor: { value: 0.72 },
        uStarIntensity: { value: 0.0 },
        uTime: { value: 0.0 },
      };

      const skyGeo = new THREE.SphereGeometry(36000, 40, 24);
      const skyMat = new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      });

      this.skyDome = new THREE.Mesh(skyGeo, skyMat);
      this.skyDome.name = 'dalat_realtime_skydome';
      this.skyDome.frustumCulled = false;
      this.skyDome.renderOrder = -1000;
      this.scene.add(this.skyDome);
    }

    _preloadSkyTextures() {
      const order = ['morning', 'day', 'sunset', 'dusk', 'night'];
      order.forEach((skyId) => this._ensureSkyTexture(skyId));
    }

    _ensureSkyTexture(skyId) {
      const id = SKY_TEXTURE_FILES[skyId] ? skyId : 'morning';
      if (this._skyTextures.has(id)) return this._skyTextures.get(id);

      const url = `${SKY_BASE_URL}/${SKY_TEXTURE_FILES[id]}`;
      const tex = this._skyTexLoader.load(
        url,
        (loadedTex) => {
          this._skyLoaded.add(id);
          loadedTex.needsUpdate = true;
          this._syncSkyTextureBindings();
          if (this._currentSkyId === id) {
            this._refreshEnvironmentBinding();
          }
        },
        undefined,
        (err) => {
          console.warn(`[RealtimeRenderer] Không nạp được ảnh bầu trời ${url}:`, err);
        }
      );
      // Tắt mipmap để tránh đường ghép dọc tại kinh độ atan2(0 <-> 2PI), luôn mượt 360°
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.encoding = THREE.sRGBEncoding;

      this._skyTextures.set(id, tex);
      return tex;
    }

    _syncSkyTextureBindings() {
      const texA = this._skyTextures.get(this._prevSkyId) || this._skyPlaceholderTex;
      const texB = this._skyTextures.get(this._currentSkyId) || this._skyPlaceholderTex;
      const readyA = this._skyLoaded.has(this._prevSkyId) ? 1.0 : 0.0;
      const readyB = this._skyLoaded.has(this._currentSkyId) ? 1.0 : 0.0;

      this.skyUniforms.uSkyTexA.value = readyA ? texA : this._skyPlaceholderTex;
      this.skyUniforms.uSkyTexB.value = readyB ? texB : this._skyPlaceholderTex;
      this.skyUniforms.uSkyReadyA.value = readyA;
      this.skyUniforms.uSkyReadyB.value = readyB;
    }

    _activateSkyId(targetSkyId, immediate) {
      const nextId = SKY_TEXTURE_FILES[targetSkyId] ? targetSkyId : 'morning';
      this._ensureSkyTexture(nextId);

      if (immediate || nextId === this._currentSkyId) {
        this._prevSkyId = nextId;
        this._currentSkyId = nextId;
        this._skyBlend = 1.0;
      } else {
        this._prevSkyId = this._currentSkyId;
        this._currentSkyId = nextId;
        this._skyBlend = 0.0;
      }
      this.skyUniforms.uSkyBlend.value = this._skyBlend;
      this._syncSkyTextureBindings();
    }

    setSkyOverride(skyMode) {
      const mode = skyMode && (skyMode === 'auto' || SKY_TEXTURE_FILES[skyMode]) ? skyMode : 'auto';
      this._skyOverride = mode;
      const pal = CLIMATE_SKY_PALETTES[this._activeClimateId] || CLIMATE_SKY_PALETTES.early_mist;
      const targetSkyId = mode === 'auto' ? pal.skyId || 'morning' : mode;
      this._activateSkyId(targetSkyId, false);

      const tune = mode === 'auto' ? pal : SKY_OVERRIDE_TUNING[mode] || pal;
      this.skyUniforms.uSkyTint.value.set(tune.skyTint || '#FFFFFF');
      this.skyUniforms.uSkyExposure.value = tune.skyExposure != null ? tune.skyExposure : 1.05;
      this.skyUniforms.uCloudColor.value.set(tune.cloudColor || '#FFFFFF');
      this.skyUniforms.uCloudOpacity.value = tune.cloudOpacity != null ? tune.cloudOpacity : 0.18;
      this.skyUniforms.uStarIntensity.value =
        tune.starIntensity != null ? tune.starIntensity : pal.starIntensity;

      this._refreshEnvironmentBinding();
    }

    _initPmrem() {
      if (typeof THREE.PMREMGenerator !== 'function') return;
      try {
        this._pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        if (typeof this._pmremGenerator.compileCubemapShader === 'function') {
          this._pmremGenerator.compileCubemapShader();
        }
      } catch (err) {
        console.warn('[RealtimeRenderer] PMREMGenerator không khả dụng:', err);
        this._pmremGenerator = null;
      }
    }

    _initPostMaterials() {
      this._prefilterScene = new THREE.Scene();
      this._prefilterMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uThreshold: { value: 0.76 },
          uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        },
        vertexShader: POST_QUAD_VERTEX,
        fragmentShader: BLOOM_PREFILTER_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      });
      this._prefilterScene.add(new THREE.Mesh(this._postQuadGeo, this._prefilterMat));

      this._blurScene = new THREE.Scene();
      this._blurMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uDirection: { value: new THREE.Vector2(1 / 256, 0) },
        },
        vertexShader: POST_QUAD_VERTEX,
        fragmentShader: BLOOM_BLUR_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      });
      this._blurScene.add(new THREE.Mesh(this._postQuadGeo, this._blurMat));

      this._compositeScene = new THREE.Scene();
      this._compositeMat = new THREE.ShaderMaterial({
        uniforms: {
          tScene: { value: null },
          tBloom: { value: null },
          uBloomStrength: { value: 0.28 },
          uSunScreenPos: { value: new THREE.Vector2(0.5, 0.5) },
          uSunVisible: { value: 0.0 },
          uSunGlowColor: { value: new THREE.Color('#FFE6BE') },
          uAspect: { value: window.innerWidth / Math.max(1, window.innerHeight) },
        },
        vertexShader: POST_QUAD_VERTEX,
        fragmentShader: COMPOSITE_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      });
      this._compositeScene.add(new THREE.Mesh(this._postQuadGeo, this._compositeMat));
    }

    _allocateRenderTargets() {
      const w = Math.max(2, Math.floor(window.innerWidth * this.currentDpr));
      const h = Math.max(2, Math.floor(window.innerHeight * this.currentDpr));
      const bw = Math.max(2, Math.floor(w * 0.28));
      const bh = Math.max(2, Math.floor(h * 0.28));

      // Dùng RGBA8 chuẩn phần cứng đảm bảo 100% alpha blending mượt cho mặt nước/nhãn/kính & giảm 50% băng thông VRAM
      const sceneParams = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        encoding: THREE.sRGBEncoding,
        depthBuffer: true,
        stencilBuffer: false,
      };
      const bloomParams = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      };

      if (this._sceneRT) this._sceneRT.dispose();
      if (this._bloomRTA) this._bloomRTA.dispose();
      if (this._bloomRTB) this._bloomRTB.dispose();

      this._sceneRT = new THREE.WebGLRenderTarget(w, h, sceneParams);
      this._bloomRTA = new THREE.WebGLRenderTarget(bw, bh, bloomParams);
      this._bloomRTB = new THREE.WebGLRenderTarget(bw, bh, bloomParams);

      this._prefilterMat.uniforms.uTexelSize.value.set(1.0 / w, 1.0 / h);
      this._compositeMat.uniforms.uAspect.value = window.innerWidth / Math.max(1, window.innerHeight);
    }

    /**
     * Nâng cấp vật liệu mặt nước (cả GLB thực tế lẫn Fallback) sang sóng GPU + Fresnel + lấp lánh nắng
     */
    enhanceWaterMaterial(mat) {
      if (!mat || (mat.userData && mat.userData.dalatRealtimeWater)) return;
      mat.userData = mat.userData || {};
      mat.userData.dalatRealtimeWater = true;
      mat.roughness = 0.14;
      mat.metalness = 0.32;
      mat.envMapIntensity = 1.25;

      const shared = this.waterSharedUniforms;
      mat.customProgramCacheKey = function () {
        return 'dalat_realtime_water_v3';
      };

      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uWaterTime = shared.uWaterTime;
        shader.uniforms.uWaterSunDir = shared.uWaterSunDir;
        shader.uniforms.uWaterSunColor = shared.uWaterSunColor;
        shader.uniforms.uWaterSkyColor = shared.uWaterSkyColor;
        shader.uniforms.uWaterQuality = shared.uWaterQuality;

        shader.vertexShader =
          [
            'uniform float uWaterTime;',
            'uniform float uWaterQuality;',
            'varying vec3 vDalatWaterWorldPos;',
          ].join('\n') +
          '\n' +
          shader.vertexShader.replace(
            '#include <project_vertex>',
            [
              'vec4 dalatWp0 = modelMatrix * vec4(transformed, 1.0);',
              'float dalatWave = sin(dalatWp0.x * 0.035 + uWaterTime * 1.35) * 0.06 + cos(dalatWp0.z * 0.042 - uWaterTime * 1.05) * 0.05;',
              'transformed.y += dalatWave * step(0.5, uWaterQuality);',
              '#include <project_vertex>',
              'vDalatWaterWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
            ].join('\n')
          );

        shader.fragmentShader =
          [
            'uniform float uWaterTime;',
            'uniform vec3 uWaterSunDir;',
            'uniform vec3 uWaterSunColor;',
            'uniform vec3 uWaterSkyColor;',
            'uniform float uWaterQuality;',
            'varying vec3 vDalatWaterWorldPos;',
          ].join('\n') +
          '\n' +
          shader.fragmentShader.replace(
            '#include <tonemapping_fragment>',
            [
              'vec3 wViewDir = normalize(cameraPosition - vDalatWaterWorldPos);',
              'vec2 wCoord = vDalatWaterWorldPos.xz;',
              'float w1 = sin(wCoord.x * 0.19 + wCoord.y * 0.11 + uWaterTime * 1.85);',
              'float w2 = cos(wCoord.x * 0.13 - wCoord.y * 0.23 - uWaterTime * 1.45);',
              'float w3 = sin((wCoord.x - wCoord.y) * 0.41 + uWaterTime * 2.55) * clamp(uWaterQuality - 0.3, 0.0, 1.0);',
              'vec3 wNormal = normalize(vec3((w1 + w3 * 0.55) * 0.055, 1.0, (w2 - w3 * 0.55) * 0.055));',
              'float fresnelBase = clamp(1.0 - max(dot(wNormal, wViewDir), 0.0), 0.0001, 1.0);',
              'float fresnel = fresnelBase * fresnelBase * fresnelBase;',
              'gl_FragColor.rgb = mix(gl_FragColor.rgb, uWaterSkyColor * 0.85, clamp(fresnel * 0.52, 0.0, 0.55));',
              'vec3 halfVec = normalize(normalize(uWaterSunDir) + wViewDir);',
              'float specDot = max(dot(wNormal, halfVec), 0.0001);',
              'float specGlint = pow(specDot, 96.0) * 1.25 * clamp(uWaterQuality, 0.4, 1.35);',
              'gl_FragColor.rgb += uWaterSunColor * specGlint;',
              '#include <tonemapping_fragment>',
            ].join('\n')
          );
      };
      mat.needsUpdate = true;
    }

    /**
     * Dựng PBR IBL Cubemap chuẩn RGBM16 của Three.js r128 từ bầu trời ảnh thực tế 360° (hoặc dự phòng vertexColors)
     */
    _getOrBuildClimateEnvMap(climateId, skyId, zenithHex, horizonHex, groundHex, sunDir, sunHex, tintHex) {
      if (!this._pmremGenerator) return null;
      const hasPhoto = Boolean(skyId && this._skyLoaded.has(skyId) && this._skyTextures.has(skyId));
      const cacheKey = hasPhoto ? `photo:${climateId}:${skyId}` : `proc:${climateId}`;
      if (this._envCache.has(cacheKey)) {
        return this._envCache.get(cacheKey).texture;
      }

      const envScene = new THREE.Scene();
      const sDir = sunDir.clone().normalize();
      let sphereGeo;
      let envMat;
      let sunMesh = null;

      if (hasPhoto) {
        const skyTex = this._skyTextures.get(skyId);
        sphereGeo = new THREE.SphereGeometry(40, 32, 20);
        const tintColor = new THREE.Color(tintHex || '#FFFFFF').convertSRGBToLinear();
        envMat = new THREE.MeshBasicMaterial({
          map: skyTex,
          color: tintColor,
          side: THREE.BackSide,
          depthWrite: false,
        });
        const envMesh = new THREE.Mesh(sphereGeo, envMat);
        const sunAz = Math.atan2(sDir.x, -sDir.z);
        envMesh.rotation.y = -sunAz + Math.PI * 0.5;
        envScene.add(envMesh);

        // Điểm nắng phản chiếu nhẹ giúp mặt hồ Xuân Hương và mái kính lấp lánh đồng bộ hướng nắng
        const sunGeo = new THREE.SphereGeometry(2.4, 10, 8);
        const sunMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(sunHex || '#FFE6BE').convertSRGBToLinear().multiplyScalar(1.6),
        });
        sunMesh = new THREE.Mesh(sunGeo, sunMat);
        sunMesh.position.copy(sDir).multiplyScalar(32);
        envScene.add(sunMesh);
      } else {
        sphereGeo = new THREE.SphereGeometry(40, 24, 16);
        const posAttr = sphereGeo.attributes.position;
        const colors = new Float32Array(posAttr.count * 3);

        const cZenith = new THREE.Color(zenithHex).convertSRGBToLinear();
        const cHorizon = new THREE.Color(horizonHex).convertSRGBToLinear();
        const cGround = new THREE.Color(groundHex).convertSRGBToLinear();
        const cSun = new THREE.Color(sunHex).convertSRGBToLinear();
        const tmpDir = new THREE.Vector3();
        const tmpCol = new THREE.Color();

        for (let i = 0; i < posAttr.count; i++) {
          tmpDir.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize();
          const y = tmpDir.y;
          if (y >= 0) {
            tmpCol.copy(cHorizon).lerp(cZenith, Math.pow(y, 0.58));
          } else {
            tmpCol.copy(cHorizon).lerp(cGround, Math.min(1.0, Math.pow(-y * 2.2, 0.7)));
          }
          const sunDot = Math.max(0, tmpDir.dot(sDir));
          if (sunDot > 0.2 && y > -0.1) {
            const halo = Math.pow(sunDot, 8.0) * 0.45;
            tmpCol.r += cSun.r * halo;
            tmpCol.g += cSun.g * halo;
            tmpCol.b += cSun.b * halo;
          }
          colors[i * 3] = tmpCol.r;
          colors[i * 3 + 1] = tmpCol.g;
          colors[i * 3 + 2] = tmpCol.b;
        }

        sphereGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        envMat = new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.BackSide,
          depthWrite: false,
        });
        envScene.add(new THREE.Mesh(sphereGeo, envMat));
      }

      const pmremRT = this._pmremGenerator.fromScene(envScene, 0.04, 0.1, 100);
      sphereGeo.dispose();
      envMat.dispose();
      if (sunMesh) {
        sunMesh.geometry.dispose();
        sunMesh.material.dispose();
      }

      this._envCache.set(cacheKey, pmremRT);
      return pmremRT.texture;
    }

    syncClimate(preset, sunLightPos) {
      if (!preset) return;
      const isInitial = !this._activeClimatePreset;
      this._activeClimateId = preset.id || 'early_mist';
      this._activeClimatePreset = preset;
      const pal = CLIMATE_SKY_PALETTES[this._activeClimateId] || CLIMATE_SKY_PALETTES.early_mist;

      const sunDir = sunLightPos.clone().normalize();
      const sunAz = Math.atan2(sunDir.x, -sunDir.z);

      const targetSkyId = this._skyOverride === 'auto' ? pal.skyId || 'morning' : this._skyOverride;
      const tune =
        this._skyOverride === 'auto' ? pal : SKY_OVERRIDE_TUNING[this._skyOverride] || pal;

      this._activateSkyId(targetSkyId, isInitial);

      this.skyUniforms.uSunAzimuth.value = sunAz;
      this.skyUniforms.uZenithColor.value.set(pal.zenith);
      this.skyUniforms.uHorizonColor.value.set(pal.horizon);
      this.skyUniforms.uGroundColor.value.set(pal.ground);
      this.skyUniforms.uFogColor.value.set(preset.fog_hex || pal.horizon);
      this.skyUniforms.uSunDir.value.copy(sunDir);
      this.skyUniforms.uSunGlowColor.value.set(pal.sunGlow);
      this.skyUniforms.uSkyTint.value.set(tune.skyTint || '#FFFFFF');
      this.skyUniforms.uSkyExposure.value = tune.skyExposure != null ? tune.skyExposure : 1.05;
      this.skyUniforms.uCloudColor.value.set(tune.cloudColor || '#FFFFFF');
      this.skyUniforms.uCloudOpacity.value = tune.cloudOpacity != null ? tune.cloudOpacity : 0.18;
      this.skyUniforms.uHorizonHazeFactor.value =
        pal.horizonHazeFactor != null ? pal.horizonHazeFactor : 0.62;
      this.skyUniforms.uStarIntensity.value =
        tune.starIntensity != null ? tune.starIntensity : pal.starIntensity;

      this.waterSharedUniforms.uWaterSunDir.value.copy(sunDir);
      this.waterSharedUniforms.uWaterSunColor.value.set(preset.sun_hex || pal.sunGlow);
      this.waterSharedUniforms.uWaterSkyColor.value.set(pal.horizon);

      this.renderer.toneMappingExposure = pal.exposure;
      this._prefilterMat.uniforms.uThreshold.value = pal.bloomThreshold;
      this._compositeMat.uniforms.uSunGlowColor.value.set(pal.sunGlow);
      this._currentSunShaftStrength = pal.sunShaftStrength;

      this._refreshEnvironmentBinding(pal, sunDir, preset.sun_hex || pal.sunGlow);
      this.markShadowDirty();
    }

    _refreshEnvironmentBinding(palOverride, sunDirOverride, sunHexOverride) {
      const presetCfg = QUALITY_PRESETS[this.qualityId] || QUALITY_PRESETS.balanced;
      if (!presetCfg.envReflection || !this._pmremGenerator) {
        this.scene.environment = null;
        return;
      }
      const pal = palOverride || CLIMATE_SKY_PALETTES[this._activeClimateId] || CLIMATE_SKY_PALETTES.early_mist;
      const sunDir = sunDirOverride || this.skyUniforms.uSunDir.value;
      const sunHex = sunHexOverride || pal.sunGlow;
      const activeSkyId = this._currentSkyId || pal.skyId || 'morning';
      const tune =
        this._skyOverride === 'auto' ? pal : SKY_OVERRIDE_TUNING[this._skyOverride] || pal;
      this.scene.environment = this._getOrBuildClimateEnvMap(
        this._activeClimateId,
        activeSkyId,
        pal.zenith,
        pal.horizon,
        pal.ground,
        sunDir,
        sunHex,
        tune.skyTint || '#FFFFFF'
      );
    }

    syncFogVisuals(effectiveDensity, baseDensity, fogHex) {
      if (fogHex) {
        this.skyUniforms.uFogColor.value.set(fogHex);
      }
      if (effectiveDensity <= 0.000002) {
        this.skyUniforms.uFogBlend.value = 0.0;
      } else {
        const ratio = baseDensity > 0 ? effectiveDensity / baseDensity : 1.0;
        const norm = Math.min(1.0, Math.pow(effectiveDensity / 0.00065, 0.55) * Math.min(1.35, 0.65 + 0.35 * ratio));
        this.skyUniforms.uFogBlend.value = Math.max(0.08, Math.min(0.96, norm));
      }
    }

    applyQualityPreset(qualityId) {
      const cfg = QUALITY_PRESETS[qualityId] || QUALITY_PRESETS.balanced;
      this.qualityId = cfg.id;
      this.bloomEnabled = cfg.bloom;
      this.shadowsEnabled = cfg.shadows;

      const nativeDpr = Math.min(window.devicePixelRatio || 1, 2.0);
      this.currentDpr = Math.max(cfg.minDpr, Math.min(nativeDpr, cfg.maxDpr));
      this._applyPixelRatio(this.currentDpr);

      this.waterSharedUniforms.uWaterQuality.value = cfg.waterQuality;
      this._compositeMat.uniforms.uBloomStrength.value = this.bloomEnabled ? cfg.bloomStrength : 0.0;

      this._configureShadows(cfg);
      this._refreshEnvironmentBinding();

      if (this.engine.streamer && typeof this.engine.streamer.setQualityProfile === 'function') {
        this.engine.streamer.setQualityProfile(cfg);
      }
      this.markShadowDirty();
    }

    setAutoFps(enabled) {
      this.autoFps = Boolean(enabled);
      if (!this.autoFps) {
        const cfg = QUALITY_PRESETS[this.qualityId] || QUALITY_PRESETS.balanced;
        const nativeDpr = Math.min(window.devicePixelRatio || 1, 2.0);
        this.currentDpr = Math.max(cfg.minDpr, Math.min(nativeDpr, cfg.maxDpr));
        this._applyPixelRatio(this.currentDpr);
      }
    }

    setBloomEnabled(enabled) {
      this.bloomEnabled = Boolean(enabled);
      const cfg = QUALITY_PRESETS[this.qualityId] || QUALITY_PRESETS.balanced;
      const strength = this.bloomEnabled ? (cfg.bloomStrength > 0 ? cfg.bloomStrength : 0.28) : 0.0;
      this._compositeMat.uniforms.uBloomStrength.value = strength;
    }

    setShadowsEnabled(enabled) {
      this.shadowsEnabled = Boolean(enabled);
      const cfg = QUALITY_PRESETS[this.qualityId] || QUALITY_PRESETS.balanced;
      this._configureShadows(cfg);
      this.markShadowDirty();
    }

    _configureShadows(cfg) {
      const sun = this.engine.sunLight;
      const enable = Boolean(this.shadowsEnabled);
      this.renderer.shadowMap.enabled = enable;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.shadowMap.autoUpdate = Boolean(enable && cfg.shadowEveryFrame);

      if (sun) {
        sun.castShadow = enable;
        const desiredSize = cfg.shadowMapSize || 1024;
        if (
          enable &&
          (sun.shadow.mapSize.width !== desiredSize || sun.shadow.mapSize.height !== desiredSize)
        ) {
          sun.shadow.mapSize.width = desiredSize;
          sun.shadow.mapSize.height = desiredSize;
          if (sun.shadow.map) {
            sun.shadow.map.dispose();
            sun.shadow.map = null;
          }
        }
      }
      this.renderer.shadowMap.needsUpdate = enable;
    }

    markShadowDirty() {
      this._shadowDirty = true;
      if (this.renderer.shadowMap.enabled) {
        this.renderer.shadowMap.needsUpdate = true;
      }
    }

    _applyPixelRatio(dpr) {
      const clamped = Math.round(dpr * 20) / 20;
      this.currentDpr = clamped;
      this.renderer.setPixelRatio(clamped);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this._allocateRenderTargets();
      this.markShadowDirty();
    }

    onResize() {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this._allocateRenderTargets();
      this.markShadowDirty();
    }

    reportFpsSample(fps, windowSec) {
      this.currentFps = fps;
      if (!this.autoFps) return;

      const cfg = QUALITY_PRESETS[this.qualityId] || QUALITY_PRESETS.balanced;
      const nativeMax = Math.max(cfg.minDpr, Math.min(window.devicePixelRatio || 1, cfg.maxDpr));

      if (this._lowFpsCooldownSec > 0) {
        this._lowFpsCooldownSec = Math.max(0, this._lowFpsCooldownSec - windowSec);
      }

      if (fps < 42 && this.currentDpr > cfg.minDpr + 0.04 && this._lowFpsCooldownSec <= 0) {
        const step = fps < 28 ? 0.2 : 0.12;
        const nextDpr = Math.max(cfg.minDpr, this.currentDpr - step);
        if (Math.abs(nextDpr - this.currentDpr) >= 0.05) {
          this._applyPixelRatio(nextDpr);
          this._lowFpsCooldownSec = 1.2;
          this._highFpsStreakSec = 0;
        }
      } else if (fps >= 55 && this.currentDpr < nativeMax - 0.04) {
        this._highFpsStreakSec += windowSec;
        if (this._highFpsStreakSec >= 2.4) {
          const nextDpr = Math.min(nativeMax, this.currentDpr + 0.1);
          if (Math.abs(nextDpr - this.currentDpr) >= 0.05) {
            this._applyPixelRatio(nextDpr);
          }
          this._highFpsStreakSec = 0;
        }
      } else {
        this._highFpsStreakSec = Math.max(0, this._highFpsStreakSec - windowSec * 0.5);
      }
    }

    _updateStabilizedSunShadows(sunOffsetVec) {
      const sun = this.engine.sunLight;
      if (!sun || !this.renderer.shadowMap.enabled) return;

      const cfg = QUALITY_PRESETS[this.qualityId] || QUALITY_PRESETS.balanced;
      const camPos = this.camera.position;
      const camDist = camPos.distanceTo(this.engine.target);
      const halfSpan = THREE.MathUtils.clamp(camDist * 1.15, cfg.shadowFrustumNearM * 0.65, 1750);

      if (!sun.target.parent) {
        this.scene.add(sun.target);
      }

      const focusX = THREE.MathUtils.lerp(camPos.x, this.engine.target.x, 0.65);
      const focusZ = THREE.MathUtils.lerp(camPos.z, this.engine.target.z, 0.65);
      const focusY = this.engine.target.y;
      const mapSize = sun.shadow.mapSize.width || 1024;
      const texelStep = Math.max(4.0, ((halfSpan * 2.0) / mapSize) * 4.0);

      const snappedX = Math.round(focusX / texelStep) * texelStep;
      const snappedZ = Math.round(focusZ / texelStep) * texelStep;
      const snappedY = Math.round(focusY / 8.0) * 8.0;

      const movedSq =
        (snappedX - this._lastShadowFocus.x) * (snappedX - this._lastShadowFocus.x) +
        (snappedZ - this._lastShadowFocus.z) * (snappedZ - this._lastShadowFocus.z) +
        (snappedY - this._lastShadowFocus.y) * (snappedY - this._lastShadowFocus.y);

      const frustumChanged = Math.abs(sun.shadow.camera.right - halfSpan) > 45.0;

      if (movedSq > 1.0 || frustumChanged || this._shadowDirty) {
        this._lastShadowFocus.set(snappedX, snappedY, snappedZ);
        sun.target.position.set(snappedX, snappedY, snappedZ);
        sun.target.updateMatrixWorld();
        sun.position.set(
          snappedX + sunOffsetVec.x,
          snappedY + sunOffsetVec.y,
          snappedZ + sunOffsetVec.z
        );

        if (frustumChanged) {
          sun.shadow.camera.left = -halfSpan;
          sun.shadow.camera.right = halfSpan;
          sun.shadow.camera.top = halfSpan;
          sun.shadow.camera.bottom = -halfSpan;
          sun.shadow.camera.updateProjectionMatrix();
        }

        this.renderer.shadowMap.needsUpdate = true;
        this._shadowDirty = false;
      } else if (!cfg.shadowEveryFrame) {
        this._shadowFrameCounter++;
        if (this._shadowFrameCounter >= 45) {
          this.renderer.shadowMap.needsUpdate = true;
          this._shadowFrameCounter = 0;
        }
      }
    }

    renderFrame(elapsed, sunOffsetVec) {
      const dt = Math.min(0.1, Math.max(0.0, elapsed - (this._lastFrameTime || 0)));
      this._lastFrameTime = elapsed;

      if (this._skyBlend < 1.0) {
        this._skyBlend = Math.min(1.0, this._skyBlend + dt * 1.85);
        this.skyUniforms.uSkyBlend.value = this._skyBlend;
      }

      this.skyDome.position.copy(this.camera.position);
      this.skyUniforms.uTime.value = elapsed;
      this.skyUniforms.uSkyDrift.value = elapsed * 0.0012;
      this.waterSharedUniforms.uWaterTime.value = elapsed;

      if (sunOffsetVec) {
        this._updateStabilizedSunShadows(sunOffsetVec);
      }

      const usePost = Boolean(this.bloomEnabled && this._sceneRT);
      if (!usePost) {
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.camera);
        return;
      }

      // 1. Vẽ cảnh 3D vào _sceneRT (sRGB + ACESFilmic giữ nguyên 100%, không bao giờ recompile shader)
      this.renderer.setRenderTarget(this._sceneRT);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);

      // 2. Trích xuất vùng sáng (Bloom Prefilter) ở độ phân giải 1/4
      this._prefilterMat.uniforms.tDiffuse.value = this._sceneRT.texture;
      this.renderer.setRenderTarget(this._bloomRTA);
      this.renderer.render(this._prefilterScene, this._postCamera);

      // 3. Làm mờ Gaussian tách trục ngang + dọc
      const bw = this._bloomRTA.width;
      const bh = this._bloomRTA.height;

      this._blurMat.uniforms.tDiffuse.value = this._bloomRTA.texture;
      this._blurMat.uniforms.uDirection.value.set(1.0 / bw, 0.0);
      this.renderer.setRenderTarget(this._bloomRTB);
      this.renderer.render(this._blurScene, this._postCamera);

      this._blurMat.uniforms.tDiffuse.value = this._bloomRTB.texture;
      this._blurMat.uniforms.uDirection.value.set(0.0, 1.0 / bh);
      this.renderer.setRenderTarget(this._bloomRTA);
      this.renderer.render(this._blurScene, this._postCamera);

      if (this.qualityId === 'ultra') {
        this._blurMat.uniforms.tDiffuse.value = this._bloomRTA.texture;
        this._blurMat.uniforms.uDirection.value.set(1.85 / bw, 0.0);
        this.renderer.setRenderTarget(this._bloomRTB);
        this.renderer.render(this._blurScene, this._postCamera);

        this._blurMat.uniforms.tDiffuse.value = this._bloomRTB.texture;
        this._blurMat.uniforms.uDirection.value.set(0.0, 1.85 / bh);
        this.renderer.setRenderTarget(this._bloomRTA);
        this.renderer.render(this._blurScene, this._postCamera);
      }

      // 4. Tính vị trí Mặt trời trên màn hình cho quầng nắng khí quyển nhẹ
      const sunDir = this.skyUniforms.uSunDir.value;
      this._sunProjVec.copy(this.camera.position).addScaledVector(sunDir, 10000.0);
      const camForward = this._sunCheckDir || (this._sunCheckDir = new THREE.Vector3());
      this.camera.getWorldDirection(camForward);
      const facingSun = Math.max(0.0, camForward.dot(sunDir));
      this._sunProjVec.project(this.camera);

      const sunUvX = this._sunProjVec.x * 0.5 + 0.5;
      const sunUvY = this._sunProjVec.y * 0.5 + 0.5;
      this._compositeMat.uniforms.uSunScreenPos.value.set(sunUvX, sunUvY);
      this._compositeMat.uniforms.uSunVisible.value =
        facingSun > 0.15 ? Math.pow(facingSun, 2.2) * this._currentSunShaftStrength : 0.0;

      // 5. Ghép ảnh cuối ra màn hình
      this._compositeMat.uniforms.tScene.value = this._sceneRT.texture;
      this._compositeMat.uniforms.tBloom.value = this._bloomRTA.texture;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this._compositeScene, this._postCamera);
    }

    getStatusSummary() {
      const cfg = QUALITY_PRESETS[this.qualityId] || QUALITY_PRESETS.balanced;
      return {
        qualityId: this.qualityId,
        label_vi: cfg.label_vi,
        badge_vi: cfg.badge_vi,
        desc_vi: cfg.desc_vi,
        dpr: this.currentDpr,
        fps: this.currentFps,
        autoFps: this.autoFps,
        bloomEnabled: Boolean(this.bloomEnabled && this._sceneRT),
        shadowsEnabled: this.shadowsEnabled,
      };
    }
  }

  global.QUALITY_PRESETS = QUALITY_PRESETS;
  global.DalatRealtimeRenderer = DalatRealtimeRenderer;
})(window);
