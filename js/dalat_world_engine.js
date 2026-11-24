/**
 * dalat_world_engine.js — Realtime Three.js r128 Engine cho DALAT_3D_SIMULATION
 * Dự án: DALAT_3D_SIMULATION (Slot 5 — Wave 3: T5_W3_LOD_STREAMER_MINIMAP_TOUR)
 * ============================================================================
 * - Điều khiển chuột chuẩn SketchUp (thân thiện cho Kiến trúc sư):
 *     + Chuột trái hoặc chuột giữa: Orbit xoay quanh tâm raycast
 *     + Shift + chuột giữa hoặc chuột phải: Pan trượt ngang mặt bằng
 *     + Con lăn chuột: Zoom-to-Cursor Raycast phóng đúng vị trí con trỏ trên 3D
 *     + Click đơn vào công trình nổi bật: Mở Popup Thông Tin Kiến Trúc Đà Lạt
 *     + Phím W/A/S/D + Q/E (+ Shift tăng tốc): bay Flycam quanh thung lũng Đà Lạt
 * - Nâng cấp Wave 3:
 *     + Tích hợp LOD Tile Streamer tự động nạp/gỡ theo khoảng cách camera (RING_0..3)
 *     + Tích hợp Minimap Radar HUD (`DalatMinimapHud`) hiển thị vị trí camera & trạng thái ô Tile
 *     + Hỗ trợ Tour Bay Tự Động 8 chặng quanh Hồ Xuân Hương & lõi di sản Đà Lạt
 */

(function () {
  'use strict';

  const DEFAULT_CLIMATES = [
    {
      id: 'early_mist',
      name_vi: 'Sương sớm (06:15)',
      sky_hex: '#C8D9E6',
      fog_hex: '#DCE6EE',
      fog_density: 0.00055,
      sun_hex: '#FFE2B0',
      sun_intensity: 1.35,
      sun_elevation_deg: 14,
      sun_azimuth_deg: 82,
      ambient_hex: '#92A9BD',
      ambient_intensity: 0.65,
      emissive_scale: 0.2,
    },
    {
      id: 'highland_noon',
      name_vi: 'Trưa cao nguyên (11:30)',
      sky_hex: '#7BB5E8',
      fog_hex: '#BFD9EE',
      fog_density: 0.00016,
      sun_hex: '#FFF9EB',
      sun_intensity: 2.1,
      sun_elevation_deg: 66,
      sun_azimuth_deg: 155,
      ambient_hex: '#B4D0E8',
      ambient_intensity: 0.75,
      emissive_scale: 0.0,
    },
    {
      id: 'sunset_lake',
      name_vi: 'Hoàng hôn (17:30)',
      sky_hex: '#D97F62',
      fog_hex: '#E39B7E',
      fog_density: 0.00038,
      sun_hex: '#FF8C42',
      sun_intensity: 1.8,
      sun_elevation_deg: 10,
      sun_azimuth_deg: 265,
      ambient_hex: '#8C6378',
      ambient_intensity: 0.55,
      emissive_scale: 0.55,
    },
    {
      id: 'mountain_night',
      name_vi: 'Đêm phố núi (20:00)',
      sky_hex: '#0B162C',
      fog_hex: '#101E38',
      fog_density: 0.00042,
      sun_hex: '#6E8FBF',
      sun_intensity: 0.35,
      sun_elevation_deg: 38,
      sun_azimuth_deg: 220,
      ambient_hex: '#1B2E4F',
      ambient_intensity: 0.35,
      emissive_scale: 1.35,
    },
  ];

  const DEFAULT_CAMERA_PRESETS = [
    {
      id: 'overview_xuan_huong',
      name_vi: 'Toàn cảnh Hồ Xuân Hương',
      tile_id: 'T_E00_N00',
      position_gltf: [-680, 420, 860],
      target_gltf: [0, 8, -40],
      fov: 48,
      duration_ms: 1400,
    },
    {
      id: 'quang_truong_lam_vien',
      name_vi: 'Quảng trường Lâm Viên',
      landmark_id: 'lm_01_quang_truong_lam_vien',
      tile_id: 'T_E00_N00',
      position_gltf: [-260, 95, 390],
      target_gltf: [-79.6, 12, 185.8],
      fov: 45,
      duration_ms: 1300,
    },
  ];

  class DalatWorldEngine {
    constructor(container) {
      this.container = container;
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2(0xdce6ee, 0.00055);

      this.camera = new THREE.PerspectiveCamera(
        48,
        window.innerWidth / window.innerHeight,
        1.0,
        45000.0
      );

      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.container.appendChild(this.renderer.domElement);

      this.hemiLight = new THREE.HemisphereLight(0xb4d0e8, 0x3b4d3b, 0.65);
      this.scene.add(this.hemiLight);

      this.sunLight = new THREE.DirectionalLight(0xffe2b0, 1.35);
      this.sunLight.castShadow = true;
      this.sunLight.shadow.mapSize.width = 1024;
      this.sunLight.shadow.mapSize.height = 1024;
      this.sunLight.shadow.camera.near = 50;
      this.sunLight.shadow.camera.far = 4500;
      const d = 1400;
      this.sunLight.shadow.camera.left = -d;
      this.sunLight.shadow.camera.right = d;
      this.sunLight.shadow.camera.top = d;
      this.sunLight.shadow.camera.bottom = -d;
      this.sunLight.shadow.bias = -0.0004;
      this.scene.add(this.sunLight);
      this.scene.add(this.sunLight.target);
      this.sunOffsetVec = new THREE.Vector3(1800, 520, -280);

      // Trạng thái Sương mù độc lập (chuyển mượt 0ms không biên dịch lại shader)
      this.fogEnabled = true;
      this.fogDensityPct = 100;
      this._lastNonZeroFogPct = 100;
      this._baseClimateFogDensity = 0.00055;
      this._baseClimateFogHex = '#DCE6EE';
      this._currentFogDensity = 0.00055;
      this._targetFogDensity = 0.00055;

      this.pbrLibrary =
        typeof window.DalatPbrMaterialLibrary === 'function'
          ? new window.DalatPbrMaterialLibrary(this.renderer, this.scene)
          : null;

      this.streamer = new window.DalatTileStreamer(this.scene, this.pbrLibrary);

      this.target = new THREE.Vector3(0, 8, -40);
      this.camera.position.set(-680, 420, 860);
      this.camera.lookAt(this.target);

      // Khởi tạo bộ xử lý đồ họa Realtime & kết nối mặt nước GPU / cache bóng đổ
      this.realtime =
        typeof window.DalatRealtimeRenderer === 'function'
          ? new window.DalatRealtimeRenderer(this)
          : null;
      if (this.realtime) {
        this.streamer.setWaterEnhancer((mat) => this.realtime.enhanceWaterMaterial(mat));
        this.streamer.onStreamBatchSettled = () => this.realtime.markShadowDirty();
      }

      this.dragMode = null;
      this.pointerDownPos = { x: 0, y: 0 };
      this.lastPointer = { x: 0, y: 0 };
      this.keys = new Set();
      this.raycaster = new THREE.Raycaster();
      this.pointerNdc = new THREE.Vector2();
      this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

      this.flightAnim = null;

      this.cameraPresets = DEFAULT_CAMERA_PRESETS;
      this.climatePresets = DEFAULT_CLIMATES;

      this.minimapHud =
        typeof window.DalatMinimapHud === 'function'
          ? new window.DalatMinimapHud(this)
          : null;

      this.clock = new THREE.Clock();
      this._fpsFrames = 0;
      this._fpsLastTime = performance.now();
      this._lodLastTime = 0;
      this._lastHoverRaycastTime = 0;
      this._coreReady = false;

      this._bindEvents();
      this._bindUi();
      this.applyClimate('early_mist');
      this._syncFogUi();
      this._syncRealtimeUi();
      this._bootstrap();
      this._animate();
    }

    async _bootstrap() {
      await this._loadCameraPresets();
      await this._refreshWorldIndexAndUi();
      this._coreReady = true;
      this.streamer.updateCameraLod(this.camera.position);
      if (this.realtime) this.realtime.markShadowDirty();
      if (this.minimapHud) this.minimapHud.update();
    }

    async _loadCameraPresets() {
      try {
        const resp = await fetch('./data/world_ui_specs/camera_presets_dalat.json', {
          cache: 'no-cache',
        });
        if (resp.ok) {
          const cfg = await resp.json();
          if (Array.isArray(cfg.camera_presets) && cfg.camera_presets.length > 0) {
            this.cameraPresets = cfg.camera_presets;
          }
          if (Array.isArray(cfg.climate_presets) && cfg.climate_presets.length > 0) {
            this.climatePresets = cfg.climate_presets;
          }
        }
      } catch (err) {
        console.warn('[DalatWorldEngine] Dùng camera presets mặc định:', err);
      }
      this._renderCameraPresetButtons();
    }

    async _refreshWorldIndexAndUi() {
      const badge = document.getElementById('mode-badge');
      if (badge) badge.textContent = 'Đang nạp thế giới 3D Đà Lạt...';

      const index = await this.streamer.refreshWorldIndex();
      const counts = (index && index.counts) || {};
      const hasReal = Boolean(index && index.has_real_assets);

      if (badge) {
        badge.textContent = hasReal
          ? `GLB thực tế (${index.total_glb_count} tệp)`
          : 'Procedural Fallback Đà Lạt';
        badge.className = hasReal ? 'chip chip-emerald' : 'chip chip-amber';
      }

      const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setTxt('count-terrain', counts.terrain_tiles > 0 ? `${counts.terrain_tiles} GLB` : 'Fallback');
      setTxt('count-water', counts.water_bodies > 0 ? `${counts.water_bodies} GLB` : 'Fallback');
      setTxt(
        'count-vegetation',
        counts.vegetation_instances > 0 ? `${counts.vegetation_instances} JSON` : 'Instanced'
      );
      setTxt('count-landmarks', counts.landmarks > 0 ? `${counts.landmarks} GLB` : '6 lõi');
      setTxt('count-roads', counts.roads_infrastructure > 0 ? `${counts.roads_infrastructure} GLB` : 'Ven hồ');
      setTxt('count-buildings', `${counts.building_tiles || 0} Tile`);

      const tileBadge = document.getElementById('tile-count-badge');
      if (
        tileBadge &&
        index &&
        Array.isArray(index.discovered_tile_ids) &&
        index.discovered_tile_ids.length > 0
      ) {
        tileBadge.textContent = `${index.discovered_tile_ids.length} Tile 3D`;
      }
    }

    _renderCameraPresetButtons() {
      const list = document.getElementById('camera-preset-list');
      if (!list) return;
      list.innerHTML = '';
      this.cameraPresets.forEach((preset, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = idx === 0 ? 'camera-btn active' : 'camera-btn';
        btn.title = preset.description || preset.name_vi;
        btn.innerHTML = `<span>${preset.name_vi}</span><span class="camera-tile-tag">${preset.tile_id || 'T_E00_N00'}</span>`;
        btn.addEventListener('click', () => {
          if (this.minimapHud && this.minimapHud.tourActive) {
            this.minimapHud.stopTour();
          }
          list.querySelectorAll('.camera-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          this.flyToPreset(preset);
          if (
            preset.landmark_id &&
            this.minimapHud &&
            this.streamer.landmarkCatalog[preset.landmark_id]
          ) {
            this.minimapHud.showLandmarkPopup(this.streamer.landmarkCatalog[preset.landmark_id]);
          }
        });
        list.appendChild(btn);
      });
    }

    applyClimate(climateId) {
      const preset =
        this.climatePresets.find((c) => c.id === climateId) || this.climatePresets[0];
      if (!preset) return;

      const skyColor = new THREE.Color(preset.sky_hex);
      const fogColor = new THREE.Color(preset.fog_hex);
      this.scene.background = skyColor;

      this._baseClimateFogHex = preset.fog_hex;
      this._baseClimateFogDensity = Number(preset.fog_density || 0.0004);

      if (!this.scene.fog) {
        this.scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.0);
      } else {
        this.scene.fog.color.copy(fogColor);
      }
      this._recomputeTargetFogDensity(false);

      this.sunLight.color.set(preset.sun_hex);
      this.sunLight.intensity = preset.sun_intensity;

      const elevRad = THREE.MathUtils.degToRad(preset.sun_elevation_deg);
      const azimRad = THREE.MathUtils.degToRad(preset.sun_azimuth_deg);
      const dist = 2200;
      this.sunOffsetVec.set(
        Math.sin(azimRad) * Math.cos(elevRad) * dist,
        Math.sin(elevRad) * dist,
        -Math.cos(azimRad) * Math.cos(elevRad) * dist
      );
      this.sunLight.position.copy(this.target).add(this.sunOffsetVec);

      this.hemiLight.color.set(preset.ambient_hex);
      this.hemiLight.intensity = preset.ambient_intensity;

      this.streamer.applyEmissiveScale(preset.emissive_scale != null ? preset.emissive_scale : 0.2);

      if (this.realtime) {
        this.realtime.syncClimate(preset, this.sunOffsetVec);
        this.realtime.syncFogVisuals(
          this._targetFogDensity,
          this._baseClimateFogDensity,
          this._baseClimateFogHex
        );
      } else if (this.pbrLibrary) {
        this.pbrLibrary.applyClimateEnvironment(preset);
      }

      document.querySelectorAll('#climate-grid .preset-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.climate === preset.id);
      });
    }

    /* ========================================================================
     * ĐIỀU KHIỂN CHẾ ĐỘ BẬT / TẮT & MẬT ĐỘ SƯƠNG MÙ ĐÀ LẠT
     * ======================================================================== */

    _recomputeTargetFogDensity(snapImmediate) {
      const scale = this.fogEnabled ? Math.max(0, this.fogDensityPct) / 100.0 : 0.0;
      this._targetFogDensity = this._baseClimateFogDensity * scale;
      if (snapImmediate) {
        this._currentFogDensity = this._targetFogDensity;
        if (this.scene.fog) this.scene.fog.density = this._currentFogDensity;
        if (this.realtime) {
          this.realtime.syncFogVisuals(
            this._currentFogDensity,
            this._baseClimateFogDensity,
            this._baseClimateFogHex
          );
        }
      }
    }

    setFogEnabled(enabled) {
      const next = Boolean(enabled);
      if (next && this.fogDensityPct <= 0) {
        this.fogDensityPct = this._lastNonZeroFogPct > 0 ? this._lastNonZeroFogPct : 100;
      }
      this.fogEnabled = next;
      this._recomputeTargetFogDensity(false);
      this._syncFogUi();
    }

    toggleFog() {
      this.setFogEnabled(!this.fogEnabled);
    }

    setFogDensityPercent(pct) {
      const clamped = Math.max(0, Math.min(250, Math.round(Number(pct) || 0)));
      this.fogDensityPct = clamped;
      if (clamped > 0) {
        this._lastNonZeroFogPct = clamped;
        this.fogEnabled = true;
      } else {
        this.fogEnabled = false;
      }
      this._recomputeTargetFogDensity(false);
      this._syncFogUi();
    }

    _updateFogTransition(dt) {
      if (!this.scene.fog) return;
      const diff = this._targetFogDensity - this._currentFogDensity;
      if (Math.abs(diff) <= 1e-7) {
        if (this._currentFogDensity !== this._targetFogDensity) {
          this._currentFogDensity = this._targetFogDensity;
          this.scene.fog.density = this._currentFogDensity;
          if (this.realtime) {
            this.realtime.syncFogVisuals(
              this._currentFogDensity,
              this._baseClimateFogDensity,
              null
            );
          }
        }
        return;
      }
      const alpha = Math.min(1.0, dt * 8.5);
      this._currentFogDensity += diff * alpha;
      if (this._currentFogDensity < 1e-6 && this._targetFogDensity === 0) {
        this._currentFogDensity = 0.0;
      }
      this.scene.fog.density = this._currentFogDensity;
      if (this.realtime) {
        this.realtime.syncFogVisuals(this._currentFogDensity, this._baseClimateFogDensity, null);
      }
    }

    _syncFogUi() {
      const isOn = Boolean(this.fogEnabled && this.fogDensityPct > 0);
      const effectivePct = isOn ? this.fogDensityPct : 0;

      const quickBtn = document.getElementById('quick-fog-btn');
      const quickLbl = document.getElementById('quick-fog-label');
      if (quickBtn) {
        quickBtn.classList.toggle('is-active', isOn);
        quickBtn.classList.toggle('is-off', !isOn);
        quickBtn.setAttribute('aria-pressed', String(isOn));
      }
      if (quickLbl) {
        quickLbl.textContent = isOn ? `Sương mù: BẬT (${effectivePct}%)` : 'Sương mù: TẮT';
      }

      const card = document.getElementById('fog-control-card');
      if (card) card.classList.toggle('is-fog-off', !isOn);

      const switchBtn = document.getElementById('fog-toggle-btn');
      if (switchBtn) {
        switchBtn.textContent = isOn ? 'Đang BẬT' : 'Đã TẮT';
        switchBtn.classList.toggle('is-on', isOn);
        switchBtn.classList.toggle('is-off', !isOn);
        switchBtn.setAttribute('aria-pressed', String(isOn));
      }

      const slider = document.getElementById('fog-density-slider');
      if (slider && Number(slider.value) !== effectivePct) {
        slider.value = String(effectivePct);
      }

      const valEl = document.getElementById('fog-density-val');
      if (valEl) {
        valEl.textContent = isOn ? `${effectivePct}%` : 'TẮT (0%)';
      }

      document.querySelectorAll('.fog-chip[data-fog-pct]').forEach((chip) => {
        const chipPct = Number(chip.dataset.fogPct);
        chip.classList.toggle('active', effectivePct === chipPct);
      });
    }

    /* ========================================================================
     * ĐIỀU KHIỂN CHẤT LƯỢNG RENDER REALTIME & ADAPTIVE FPS
     * ======================================================================== */

    setQualityPreset(qualityId) {
      if (!this.realtime) return;
      this.realtime.applyQualityPreset(qualityId);
      this._syncRealtimeUi();
    }

    cycleQualityPreset() {
      if (!this.realtime) return;
      const order = ['fast', 'balanced', 'ultra'];
      const idx = order.indexOf(this.realtime.qualityId);
      const nextId = order[(idx + 1) % order.length];
      this.setQualityPreset(nextId);
    }

    _syncRealtimeUi() {
      if (!this.realtime) return;
      const st = this.realtime.getStatusSummary();

      document.querySelectorAll('#quality-grid .quality-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.quality === st.qualityId);
      });

      const descEl = document.getElementById('quality-desc');
      if (descEl) descEl.textContent = st.desc_vi;

      const quickQualLbl = document.getElementById('quick-quality-label');
      if (quickQualLbl) quickQualLbl.textContent = `Đồ họa: ${st.label_vi}`;

      const renderBadge = document.getElementById('render-badge');
      if (renderBadge) {
        renderBadge.textContent = `${st.badge_vi} • ${st.dpr.toFixed(2)}x`;
      }

      const dprTag = document.getElementById('dpr-readout');
      if (dprTag) {
        dprTag.textContent = `${st.dpr.toFixed(2)}x`;
      }

      const autoChk = document.getElementById('auto-fps-toggle');
      if (autoChk) autoChk.checked = st.autoFps;

      const bloomChk = document.getElementById('bloom-toggle');
      if (bloomChk) bloomChk.checked = st.bloomEnabled;

      const shadowChk = document.getElementById('shadows-toggle');
      if (shadowChk) shadowChk.checked = st.shadowsEnabled;
    }

    flyToPreset(preset) {
      if (!preset) return;
      const posArr = preset.position_gltf || preset.camera_pos_gltf;
      const tgtArr = preset.target_gltf || preset.look_at_gltf;
      if (!posArr || !tgtArr) return;
      this.flightAnim = {
        startTime: performance.now(),
        duration: preset.duration_ms || 1300,
        fromPos: this.camera.position.clone(),
        toPos: new THREE.Vector3().fromArray(posArr),
        fromTarget: this.target.clone(),
        toTarget: new THREE.Vector3().fromArray(tgtArr),
        fromFov: this.camera.fov,
        toFov: preset.fov || preset.fov_deg || 48,
        onComplete: typeof preset.onComplete === 'function' ? preset.onComplete : null,
      };
    }

    _setRaycasterFromClient(clientX, clientY) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    }

    _raycastPoint(clientX, clientY) {
      this._setRaycasterFromClient(clientX, clientY);
      if (this.streamer.pickableMeshes.length > 0) {
        const hits = this.raycaster.intersectObjects(this.streamer.pickableMeshes, false);
        if (hits.length > 0) return hits[0].point.clone();
      }
      const fallbackPt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, fallbackPt)) {
        return fallbackPt;
      }
      return null;
    }

    _raycastHoverTerrain(clientX, clientY) {
      this._setRaycasterFromClient(clientX, clientY);
      const terrainList = this.streamer.terrainPickMeshes;
      if (terrainList && terrainList.length > 0) {
        const hits = this.raycaster.intersectObjects(terrainList, false);
        if (hits.length > 0) return hits[0].point.clone();
      }
      const fallbackPt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, fallbackPt)) {
        return fallbackPt;
      }
      return null;
    }

    _updateGpsHud(worldPt) {
      if (!worldPt) return;
      const local = window.DALAT_COORDS.gltfToLocal(worldPt);
      const ll = window.DALAT_COORDS.localToLatLon(local.x, local.y);
      const { ix, iy } = window.DALAT_COORDS.tileIndicesForXY(local.x, local.y);
      const tileId = window.DALAT_COORDS.formatTileId(ix, iy);
      const ring = window.DALAT_COORDS.ringForTile(ix, iy);

      const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setTxt('gps-lat', `${ll.lat.toFixed(6)}°`);
      setTxt('gps-lon', `${ll.lon.toFixed(6)}°`);
      setTxt('gps-elev', `${local.elevMsl.toFixed(1)} m`);
      setTxt('gps-local', `${local.x.toFixed(1)}, ${local.y.toFixed(1)} m`);
      setTxt('gps-tile', `${tileId} (RING_${ring})`);
    }

    _bindEvents() {
      const dom = this.renderer.domElement;

      dom.addEventListener('contextmenu', (e) => e.preventDefault());

      dom.addEventListener('pointerdown', (e) => {
        if (this.minimapHud && this.minimapHud.tourActive) {
          this.minimapHud.stopTour();
        }
        this.flightAnim = null;
        this.pointerDownPos = { x: e.clientX, y: e.clientY };
        this.lastPointer = { x: e.clientX, y: e.clientY };

        if (e.button === 2 || (e.button === 1 && e.shiftKey)) {
          this.dragMode = 'pan';
        } else if (e.button === 0 || e.button === 1) {
          this.dragMode = 'orbit';
          const hit = this._raycastPoint(e.clientX, e.clientY);
          if (hit) {
            this.target.copy(hit);
          }
        }
        if (this.dragMode) {
          this.container.classList.add('is-dragging');
          dom.setPointerCapture(e.pointerId);
        }
      });

      dom.addEventListener('pointermove', (e) => {
        if (!this.dragMode) {
          const nowHover = performance.now();
          if (nowHover - this._lastHoverRaycastTime >= 75) {
            this._lastHoverRaycastTime = nowHover;
            const hoverHit = this._raycastHoverTerrain(e.clientX, e.clientY);
            if (hoverHit) this._updateGpsHud(hoverHit);
          }
          return;
        }

        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };

        if (this.dragMode === 'orbit') {
          this._orbit(dx, dy);
        } else if (this.dragMode === 'pan') {
          this._pan(dx, dy);
        }
      });

      const endDrag = (e) => {
        const movedDist = Math.hypot(
          e.clientX - this.pointerDownPos.x,
          e.clientY - this.pointerDownPos.y
        );

        if (this.dragMode) {
          this.dragMode = null;
          this.container.classList.remove('is-dragging');
          try {
            dom.releasePointerCapture(e.pointerId);
          } catch (_) {
            /* ignore */
          }
        }

        // Click đơn (< 6px) vào công trình nổi bật -> mở Popup Thông Tin Kiến Trúc
        if (e.type === 'pointerup' && e.button === 0 && movedDist < 6.0) {
          this._setRaycasterFromClient(e.clientX, e.clientY);
          const picked = this.streamer.pickLandmark(this.raycaster);
          if (picked && this.minimapHud) {
            this.minimapHud.showLandmarkPopup(picked.meta);
            this._updateGpsHud(picked.point);
          }
        }
      };
      dom.addEventListener('pointerup', endDrag);
      dom.addEventListener('pointercancel', endDrag);

      // Zoom-to-Cursor Raycast chuẩn SketchUp
      dom.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          if (this.minimapHud && this.minimapHud.tourActive) {
            this.minimapHud.stopTour();
          }
          this.flightAnim = null;
          const hit = this._raycastPoint(e.clientX, e.clientY) || this.target;
          const zoomFactor = e.deltaY < 0 ? 0.16 : -0.19;
          const vec = new THREE.Vector3().subVectors(hit, this.camera.position);
          const dist = vec.length();
          if (dist < 18 && zoomFactor > 0) return;
          if (dist > 18000 && zoomFactor < 0) return;

          const move = vec.multiplyScalar(zoomFactor);
          this.camera.position.add(move);
          if (zoomFactor > 0) {
            this.target.lerp(hit, 0.25);
          }
          if (this.camera.position.y < 3.5) this.camera.position.y = 3.5;
          this.camera.lookAt(this.target);
          this._updateGpsHud(hit);
        },
        { passive: false }
      );

      // Flycam W/A/S/D + Q/E + Phím tắt F (Sương mù) / G (Đồ họa)
      window.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
        if (e.code === 'Escape' && this.minimapHud) {
          this.minimapHud.hideLandmarkPopup();
          if (this.minimapHud.tourActive) this.minimapHud.stopTour();
        }
        if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
          if (e.code === 'KeyF') {
            this.toggleFog();
            return;
          }
          if (e.code === 'KeyG') {
            this.cycleQualityPreset();
            return;
          }
        }
        this.keys.add(e.code);
      });
      window.addEventListener('keyup', (e) => {
        this.keys.delete(e.code);
      });

      window.addEventListener('resize', () => {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        if (this.realtime) {
          this.realtime.onResize();
        } else {
          this.renderer.setSize(window.innerWidth, window.innerHeight);
        }
      });
    }

    _orbit(dx, dy) {
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * 0.0055;
      spherical.phi -= dy * 0.0055;
      spherical.phi = Math.max(0.08, Math.min(Math.PI * 0.485, spherical.phi));
      offset.setFromSpherical(spherical);
      this.camera.position.copy(this.target).add(offset);
      if (this.camera.position.y < 2.5) this.camera.position.y = 2.5;
      this.camera.lookAt(this.target);
    }

    _pan(dx, dy) {
      const dist = this.camera.position.distanceTo(this.target);
      const speed = Math.max(0.15, dist * 0.0014);

      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();

      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const move = new THREE.Vector3()
        .addScaledVector(right, -dx * speed)
        .addScaledVector(forward, dy * speed);

      this.camera.position.add(move);
      this.target.add(move);
      this.camera.lookAt(this.target);
      this._updateGpsHud(this.target);
    }

    _updateFlycam(dt) {
      if (this.keys.size === 0) return;
      const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 2.8 : 1.0;
      const speed = 220.0 * boost * dt;

      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const move = new THREE.Vector3();

      if (this.keys.has('KeyW')) move.addScaledVector(forward, speed);
      if (this.keys.has('KeyS')) move.addScaledVector(forward, -speed);
      if (this.keys.has('KeyD')) move.addScaledVector(right, speed);
      if (this.keys.has('KeyA')) move.addScaledVector(right, -speed);
      if (this.keys.has('KeyE')) move.y += speed * 0.75;
      if (this.keys.has('KeyQ')) move.y -= speed * 0.75;

      if (move.lengthSq() > 0) {
        if (this.minimapHud && this.minimapHud.tourActive) {
          this.minimapHud.stopTour();
        }
        this.flightAnim = null;
        this.camera.position.add(move);
        this.target.add(move);
        if (this.camera.position.y < 3.0) this.camera.position.y = 3.0;
        this.camera.lookAt(this.target);
        this._updateGpsHud(this.target);
      }
    }

    _updateFlightAnimation() {
      if (!this.flightAnim) return;
      const anim = this.flightAnim;
      const elapsed = performance.now() - anim.startTime;
      const rawT = Math.min(1.0, elapsed / anim.duration);
      const t = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

      this.camera.position.lerpVectors(anim.fromPos, anim.toPos, t);
      this.target.lerpVectors(anim.fromTarget, anim.toTarget, t);
      this.camera.fov = THREE.MathUtils.lerp(anim.fromFov, anim.toFov, t);
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.target);

      if (rawT >= 1.0) {
        const doneCb = anim.onComplete;
        this.flightAnim = null;
        this._updateGpsHud(this.target);
        if (doneCb) doneCb();
      }
    }

    _bindUi() {
      const toggleBtn = document.getElementById('toggle-panel-btn');
      const panel = document.getElementById('control-panel');
      if (toggleBtn && panel) {
        toggleBtn.addEventListener('click', () => {
          panel.classList.toggle('collapsed');
        });
      }

      // Nút Bật / Tắt Sương mù nhanh trên thanh trên & trong bảng điều khiển
      const quickFogBtn = document.getElementById('quick-fog-btn');
      if (quickFogBtn) {
        quickFogBtn.addEventListener('click', () => this.toggleFog());
      }
      const fogSwitchBtn = document.getElementById('fog-toggle-btn');
      if (fogSwitchBtn) {
        fogSwitchBtn.addEventListener('click', () => this.toggleFog());
      }
      const fogSlider = document.getElementById('fog-density-slider');
      if (fogSlider) {
        fogSlider.addEventListener('input', () => {
          this.setFogDensityPercent(Number(fogSlider.value));
        });
      }
      document.querySelectorAll('.fog-chip[data-fog-pct]').forEach((chip) => {
        chip.addEventListener('click', () => {
          this.setFogDensityPercent(Number(chip.dataset.fogPct));
        });
      });

      // Chế độ chất lượng Đồ họa Realtime & Adaptive FPS
      const quickQualityBtn = document.getElementById('quick-quality-btn');
      if (quickQualityBtn) {
        quickQualityBtn.addEventListener('click', () => this.cycleQualityPreset());
      }
      document.querySelectorAll('#quality-grid .quality-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.setQualityPreset(btn.dataset.quality);
        });
      });

      const autoFpsToggle = document.getElementById('auto-fps-toggle');
      if (autoFpsToggle) {
        autoFpsToggle.addEventListener('change', () => {
          if (this.realtime) {
            this.realtime.setAutoFps(autoFpsToggle.checked);
            this._syncRealtimeUi();
          }
        });
      }

      const bloomToggle = document.getElementById('bloom-toggle');
      if (bloomToggle) {
        bloomToggle.addEventListener('change', () => {
          if (this.realtime) {
            this.realtime.setBloomEnabled(bloomToggle.checked);
            this._syncRealtimeUi();
          }
        });
      }

      const shadowsToggle = document.getElementById('shadows-toggle');
      if (shadowsToggle) {
        shadowsToggle.addEventListener('change', () => {
          if (this.realtime) {
            this.realtime.setShadowsEnabled(shadowsToggle.checked);
            this._syncRealtimeUi();
          }
        });
      }

      document.querySelectorAll('#climate-grid .preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.applyClimate(btn.dataset.climate);
        });
      });

      document.querySelectorAll('input[data-layer]').forEach((chk) => {
        chk.addEventListener('change', () => {
          this.streamer.setLayerVisible(chk.dataset.layer, chk.checked);
        });
      });

      const refreshBtn = document.getElementById('refresh-index-btn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
          this._refreshWorldIndexAndUi();
        });
      }

      const resetBtn = document.getElementById('reset-view-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          if (this.minimapHud && this.minimapHud.tourActive) {
            this.minimapHud.stopTour();
          }
          if (this.cameraPresets.length > 0) {
            this.flyToPreset(this.cameraPresets[0]);
          }
        });
      }
    }

    _animate() {
      requestAnimationFrame(() => this._animate());
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const elapsed = this.clock.elapsedTime;
      const now = performance.now();

      this._updateFlycam(dt);
      this._updateFlightAnimation();
      this._updateFogTransition(dt);
      this.streamer.update(dt, elapsed);
      if (this.pbrLibrary) this.pbrLibrary.update(dt);

      // Cập nhật LOD theo khoảng cách Camera & Minimap Radar mỗi 180ms sau khi lõi sẵn sàng
      if (now - this._lodLastTime >= 180) {
        if (this._coreReady) {
          this.streamer.updateCameraLod(this.camera.position);
        }
        if (this.minimapHud) this.minimapHud.update();
        this._lodLastTime = now;
      }

      if (this.realtime) {
        this.realtime.renderFrame(elapsed, this.sunOffsetVec);
      } else {
        this.renderer.render(this.scene, this.camera);
      }

      this._fpsFrames++;
      const fpsWindowMs = now - this._fpsLastTime;
      if (fpsWindowMs >= 650) {
        const fps = Math.max(1, Math.round((this._fpsFrames * 1000) / fpsWindowMs));
        if (this.realtime) {
          this.realtime.reportFpsSample(fps, fpsWindowMs / 1000.0);
          this._syncRealtimeUi();
        }
        const fpsEl = document.getElementById('fps-badge');
        if (fpsEl) {
          fpsEl.textContent = `${fps} FPS`;
          fpsEl.className = fps >= 45 ? 'chip chip-emerald' : 'chip chip-amber';
        }
        this._fpsFrames = 0;
        this._fpsLastTime = now;
      }
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const errOverlay = document.getElementById('error-overlay');
    if (typeof window.THREE === 'undefined') {
      if (errOverlay) {
        errOverlay.classList.remove('hidden');
        errOverlay.textContent =
          'Không thể nạp Three.js r128 từ CDN. Vui lòng kiểm tra kết nối mạng hoặc cung cấp three.min.js nội bộ.';
      }
      return;
    }
    const container = document.getElementById('viewport-container');
    window.dalatEngine = new DalatWorldEngine(container);
  });
})();
