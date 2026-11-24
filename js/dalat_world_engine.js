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
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
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

      this.streamer = new window.DalatTileStreamer(this.scene);

      this.target = new THREE.Vector3(0, 8, -40);
      this.camera.position.set(-680, 420, 860);
      this.camera.lookAt(this.target);

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
      this._coreReady = false;

      this._bindEvents();
      this._bindUi();
      this.applyClimate('early_mist');
      this._bootstrap();
      this._animate();
    }

    async _bootstrap() {
      await this._loadCameraPresets();
      await this._refreshWorldIndexAndUi();
      this._coreReady = true;
      this.streamer.updateCameraLod(this.camera.position);
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
      this.scene.fog = new THREE.FogExp2(fogColor.getHex(), preset.fog_density);

      this.sunLight.color.set(preset.sun_hex);
      this.sunLight.intensity = preset.sun_intensity;

      const elevRad = THREE.MathUtils.degToRad(preset.sun_elevation_deg);
      const azimRad = THREE.MathUtils.degToRad(preset.sun_azimuth_deg);
      const dist = 2200;
      this.sunLight.position.set(
        Math.sin(azimRad) * Math.cos(elevRad) * dist,
        Math.sin(elevRad) * dist,
        -Math.cos(azimRad) * Math.cos(elevRad) * dist
      );

      this.hemiLight.color.set(preset.ambient_hex);
      this.hemiLight.intensity = preset.ambient_intensity;

      this.streamer.applyEmissiveScale(preset.emissive_scale != null ? preset.emissive_scale : 0.2);

      document.querySelectorAll('#climate-grid .preset-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.climate === preset.id);
      });
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
          const hoverHit = this._raycastPoint(e.clientX, e.clientY);
          if (hoverHit) this._updateGpsHud(hoverHit);
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

      // Flycam W/A/S/D + Q/E
      window.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
        if (e.code === 'Escape' && this.minimapHud) {
          this.minimapHud.hideLandmarkPopup();
          if (this.minimapHud.tourActive) this.minimapHud.stopTour();
        }
        this.keys.add(e.code);
      });
      window.addEventListener('keyup', (e) => {
        this.keys.delete(e.code);
      });

      window.addEventListener('resize', () => {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
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
      this.streamer.update(dt, elapsed);

      // Cập nhật LOD theo khoảng cách Camera & Minimap Radar mỗi 180ms sau khi lõi sẵn sàng
      if (now - this._lodLastTime >= 180) {
        if (this._coreReady) {
          this.streamer.updateCameraLod(this.camera.position);
        }
        if (this.minimapHud) this.minimapHud.update();
        this._lodLastTime = now;
      }

      this.renderer.render(this.scene, this.camera);

      this._fpsFrames++;
      if (now - this._fpsLastTime >= 600) {
        const fps = Math.round((this._fpsFrames * 1000) / (now - this._fpsLastTime));
        const fpsEl = document.getElementById('fps-badge');
        if (fpsEl) fpsEl.textContent = `${fps} FPS`;
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
