/**
 * ultra_hd_satellite.js — Bộ Tăng Nét Ảnh Vệ Tinh Thời Gian Thực Chuẩn Web Mercator Z18/Z19/Z20
 * Dự án: DALAT_3D_SIMULATION
 * ============================================================================
 * Phối hợp song song 2 tầng độ nét:
 *   1. Tầng nền tĩnh đã nhúng sẵn trong GLB (Google Satellite 4096px T_E00_N00 & 2048px RING_0/1).
 *   2. Tầng kính hiển vi động GPU (file này): Khi người dùng phóng to / hạ thấp góc nhìn xuống gần
 *      bất kỳ khu vực nào trong phạm vi 60x60km, tự động tải cửa sổ 8x8 ô ảnh vệ tinh Google Satellite
 *      gốc độ phân giải tối đa (Z18 = 0.58m/px, Z19 = 0.29m/px, Z20 = 0.146m/px), ghép lên
 *      CanvasTexture 2048x2048 bật lọc Anisotropic 16x và trộn mượt trực tiếp trong fragment shader
 *      địa hình (onBeforeCompile) mà KHÔNG gây Z-fighting hay tốn thêm VRAM hàng trăm MB.
 *   - Tự động giữ nguyên ảnh nền tĩnh nếu trình duyệt ngoại tuyến hoặc bị chặn mạng.
 */
(function (global) {
  'use strict';

  const LAT0 = 11.940419;
  const LON0 = 108.445259;
  const MLAT = 111319.49;
  const MLON = 108911.0;

  const GRID_TILES = 8; // 8 x 8 = 64 ô x 256px = 2048 x 2048 px (Power-of-Two chuẩn WebGL + Mipmap)
  const TILE_PX = 256;
  const CANVAS_PX = GRID_TILES * TILE_PX;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function worldXZToLatLon(worldX, worldZ) {
    return {
      lat: LAT0 - worldZ / MLAT,
      lon: LON0 + worldX / MLON,
    };
  }

  function latLonToTileFloat(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    const xt = ((lon + 180.0) / 360.0) * n;
    const lr = (clamp(lat, -85.05, 85.05) * Math.PI) / 180.0;
    const yt = (1.0 - Math.log(Math.tan(lr) + 1.0 / Math.cos(lr)) / Math.PI) * 0.5 * n;
    return { xt, yt, n };
  }

  function tileYToLat(ty, n) {
    const k = Math.PI * (1.0 - (2.0 * ty) / n);
    return (Math.atan(0.5 * (Math.exp(k) - Math.exp(-k))) * 180.0) / Math.PI;
  }

  function tileBoundsWorldXZ(txMin, tyMin, zoom) {
    const n = Math.pow(2, zoom);
    const westLon = (txMin / n) * 360.0 - 180.0;
    const eastLon = ((txMin + GRID_TILES) / n) * 360.0 - 180.0;
    const northLat = tileYToLat(tyMin, n);
    const southLat = tileYToLat(tyMin + GRID_TILES, n);

    const westX = (westLon - LON0) * MLON;
    const eastX = (eastLon - LON0) * MLON;
    const northZ = -(northLat - LAT0) * MLAT;
    const southZ = -(southLat - LAT0) * MLAT;

    return {
      centerX: 0.5 * (westX + eastX),
      centerZ: 0.5 * (northZ + southZ),
      invSpanX: 1.0 / Math.max(1e-3, eastX - westX),
      invSpanZ: 1.0 / Math.max(1e-3, southZ - northZ),
    };
  }

  class DalatUltraHdSatellite {
    constructor(engine) {
      this.engine = engine;
      this.renderer = engine.renderer;
      this.enabled = true;

      this.maxAnisotropy = Math.min(
        (this.renderer &&
          this.renderer.capabilities &&
          this.renderer.capabilities.getMaxAnisotropy()) ||
          4,
        16
      );

      this.canvas = document.createElement('canvas');
      this.canvas.width = CANVAS_PX;
      this.canvas.height = CANVAS_PX;
      this.ctx = this.canvas.getContext('2d');

      this.detailTex = new THREE.CanvasTexture(this.canvas);
      this.detailTex.encoding = THREE.sRGBEncoding;
      this.detailTex.wrapS = THREE.ClampToEdgeWrapping;
      this.detailTex.wrapT = THREE.ClampToEdgeWrapping;
      this.detailTex.generateMipmaps = true;
      this.detailTex.minFilter = THREE.LinearMipmapLinearFilter;
      this.detailTex.magFilter = THREE.LinearFilter;
      this.detailTex.anisotropy = this.maxAnisotropy;

      this.sharedUniforms = {
        uDetailSatTex: { value: this.detailTex },
        uDetailReady: { value: 0.0 },
        uDetailCenterXZ: { value: new THREE.Vector2(0, 0) },
        uDetailInvSpanXZ: { value: new THREE.Vector2(1 / 600, 1 / 600) },
      };

      this._tileCache = new Map();
      this._maxCacheTiles = 384;
      this._activeWindow = null; // { zoom, txMin, tyMin }
      this._pendingKey = null;
      this._requestSeq = 0;
      this._targetReady = 0.0;
      this._currentReady = 0.0;
      this._lastCheckMs = 0;
      this._pendingTimer = null;
    }

    /**
     * Nâng cấp vật liệu địa hình (GLB nền vệ tinh) với Anisotropic 16x + Shader trộn chi tiết Z19/Z20
     */
    enhanceTerrainMaterial(mat) {
      if (!mat) return;
      if (mat.map) {
        mat.map.anisotropy = this.maxAnisotropy;
        mat.map.minFilter = THREE.LinearMipmapLinearFilter;
        mat.map.magFilter = THREE.LinearFilter;
        mat.map.needsUpdate = true;
      }
      if (typeof mat.roughness === 'number') mat.roughness = 0.96;
      if (typeof mat.metalness === 'number') mat.metalness = 0.0;
      mat.envMapIntensity = 0.18;

      if (!mat.map || (mat.userData && mat.userData.dalatUltraHdTerrain)) {
        mat.needsUpdate = true;
        return;
      }
      mat.userData = mat.userData || {};
      mat.userData.dalatUltraHdTerrain = true;

      const shared = this.sharedUniforms;
      mat.customProgramCacheKey = function () {
        return 'dalat_terrain_ultrahd_v1';
      };

      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uDetailSatTex = shared.uDetailSatTex;
        shader.uniforms.uDetailReady = shared.uDetailReady;
        shader.uniforms.uDetailCenterXZ = shared.uDetailCenterXZ;
        shader.uniforms.uDetailInvSpanXZ = shared.uDetailInvSpanXZ;

        shader.vertexShader =
          'varying vec2 vSatWorldXZ;\n' +
          shader.vertexShader.replace(
            '#include <project_vertex>',
            [
              'vec4 dSatWp = modelMatrix * vec4(transformed, 1.0);',
              'vSatWorldXZ = dSatWp.xz;',
              '#include <project_vertex>',
            ].join('\n')
          );

        shader.fragmentShader =
          [
            'uniform sampler2D uDetailSatTex;',
            'uniform float uDetailReady;',
            'uniform vec2 uDetailCenterXZ;',
            'uniform vec2 uDetailInvSpanXZ;',
            'varying vec2 vSatWorldXZ;',
          ].join('\n') +
          '\n' +
          shader.fragmentShader.replace(
            '#include <map_fragment>',
            [
              '#ifdef USE_MAP',
              '  vec4 texelColor = texture2D( map, vUv, -0.35 );',
              '  texelColor = mapTexelToLinear( texelColor );',
              '  if (uDetailReady > 0.001) {',
              '    vec2 dUv = vec2(0.5) + vec2(vSatWorldXZ.x - uDetailCenterXZ.x, -(vSatWorldXZ.y - uDetailCenterXZ.y)) * uDetailInvSpanXZ;',
              '    if (dUv.x > 0.002 && dUv.x < 0.998 && dUv.y > 0.002 && dUv.y < 0.998) {',
              '      float dEdge = min(min(dUv.x, 1.0 - dUv.x), min(dUv.y, 1.0 - dUv.y));',
              '      float dMask = smoothstep(0.002, 0.14, dEdge) * uDetailReady;',
              '      vec4 dSample = texture2D( uDetailSatTex, dUv, -0.35 );',
              '      dSample = mapTexelToLinear( dSample );',
              '      texelColor.rgb = mix(texelColor.rgb, dSample.rgb, dMask);',
              '    }',
              '  }',
              '  diffuseColor *= texelColor;',
              '#endif',
            ].join('\n')
          );
      };
      mat.needsUpdate = true;
    }

    _fetchGoogleTile(zoom, tx, ty) {
      const key = `${zoom}_${tx}_${ty}`;
      if (this._tileCache.has(key)) {
        const cached = this._tileCache.get(key);
        this._tileCache.delete(key);
        this._tileCache.set(key, cached);
        return Promise.resolve(cached);
      }
      const shard = Math.abs(tx + ty) % 4;
      const url = `https://mt${shard}.google.com/vt/lyrs=s&x=${tx}&y=${ty}&z=${zoom}`;
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        }, 7000);
        img.onload = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this._tileCache.size >= this._maxCacheTiles) {
            const firstKey = this._tileCache.keys().next().value;
            this._tileCache.delete(firstKey);
          }
          this._tileCache.set(key, img);
          resolve(img);
        };
        img.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        };
        img.src = url;
      });
    }

    _desiredWindow(camera, target) {
      if (!this.enabled || !camera || !target) return null;
      const dist = camera.position.distanceTo(target);
      const alt = Math.max(15, camera.position.y);

      let zoom = 0;
      if (dist < 230 && alt < 165) {
        zoom = 20;
      } else if (dist < 1350 && alt < 1100) {
        zoom = 19;
      } else if (dist < 2800 && alt < 2100) {
        zoom = 18;
      } else {
        return null;
      }

      // Điểm lấy nét nằm hơi về phía trước hướng nhìn khi bay sát đất
      const focusX = 0.72 * target.x + 0.28 * camera.position.x;
      const focusZ = 0.72 * target.z + 0.28 * camera.position.z;
      const { lat, lon } = worldXZToLatLon(focusX, focusZ);
      const { xt, yt } = latLonToTileFloat(lat, lon, zoom);
      const cx = Math.floor(xt);
      const cy = Math.floor(yt);

      return {
        zoom,
        cx,
        cy,
        txMin: cx - Math.floor(GRID_TILES / 2),
        tyMin: cy - Math.floor(GRID_TILES / 2),
      };
    }

    async _loadAndCommitWindow(win) {
      const winKey = `${win.zoom}_${win.txMin}_${win.tyMin}`;
      if (this._pendingKey === winKey) return;
      this._pendingKey = winKey;
      const seq = ++this._requestSeq;

      const jobs = [];
      for (let dy = 0; dy < GRID_TILES; dy++) {
        for (let dx = 0; dx < GRID_TILES; dx++) {
          const tx = win.txMin + dx;
          const ty = win.tyMin + dy;
          jobs.push(
            this._fetchGoogleTile(win.zoom, tx, ty).then((img) => ({ dx, dy, img }))
          );
        }
      }

      const results = await Promise.all(jobs);
      if (seq !== this._requestSeq) return; // Đã có cửa sổ mới hơn

      const validCount = results.reduce((acc, r) => acc + (r.img ? 1 : 0), 0);
      if (validCount < results.length) {
        // Nếu offline / chặn mạng -> giữ nguyên ảnh nền GLB 4K/2K mượt mà không chắp vá
        this._pendingKey = null;
        if (!this._activeWindow) this._targetReady = 0.0;
        return;
      }

      for (const r of results) {
        this.ctx.drawImage(r.img, r.dx * TILE_PX, r.dy * TILE_PX, TILE_PX, TILE_PX);
      }

      const bounds = tileBoundsWorldXZ(win.txMin, win.tyMin, win.zoom);
      this.sharedUniforms.uDetailCenterXZ.value.set(bounds.centerX, bounds.centerZ);
      this.sharedUniforms.uDetailInvSpanXZ.value.set(bounds.invSpanX, bounds.invSpanZ);
      this.detailTex.needsUpdate = true;

      this._activeWindow = win;
      this._pendingKey = null;
      this._targetReady = 1.0;
    }

    update(camera, target, dt) {
      if (!this.enabled) return;

      // Làm mượt độ mờ biên kính hiển vi vệ tinh
      if (Math.abs(this._currentReady - this._targetReady) > 0.001) {
        const rate = Math.min(1.0, (dt || 0.016) * 4.5);
        this._currentReady += (this._targetReady - this._currentReady) * rate;
        this.sharedUniforms.uDetailReady.value = this._currentReady;
      }

      const now = performance.now();
      if (now - this._lastCheckMs < 240) return;
      this._lastCheckMs = now;

      const desired = this._desiredWindow(camera, target);
      if (!desired) {
        this._targetReady = 0.0;
        return;
      }

      if (this._activeWindow && this._activeWindow.zoom === desired.zoom) {
        const dx = Math.abs(desired.cx - this._activeWindow.cx);
        const dy = Math.abs(desired.cy - this._activeWindow.cy);
        if (dx <= 1 && dy <= 1) {
          this._targetReady = 1.0;
          return; // Vẫn nằm trong vùng trung tâm an toàn -> không tải lại!
        }
      }

      this._loadAndCommitWindow(desired);
    }
  }

  global.DalatUltraHdSatellite = DalatUltraHdSatellite;
})(window);
