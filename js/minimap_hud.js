/**
 * minimap_hud.js — Bản Đồ Radar Minimap Tọa Độ GPS, Popup Thông Tin Kiến Trúc & Tour Bay Tự Động Đà Lạt
 * Dự án: DALAT_3D_SIMULATION (Slot 5 — Wave 3: T5_W3_LOD_STREAMER_MINIMAP_TOUR)
 * ============================================================================
 * Chức năng:
 *   1. Radar Minimap HUD (Canvas 2D tương tác góc dưới trái):
 *      - Hiển thị trực quan lưới Tile 2km × 2km (RING_0 6×6km, RING_1 14×14km, RING_2 30×30km).
 *      - Phân biệt màu rõ ràng:
 *          + Ô Tile đã dựng 3D thực tế (Terrain/Veg/Landmarks/Buildings): Xanh ngọc (#10b981)
 *          + Ô Tile đang trong vùng LOD0/LOD1 của Camera: Viền sáng Cyan (#38bdf8)
 *          + Ô Tile đang chờ mở rộng / Fallback: Xám lam (#334155)
 *      - Vẽ hình trăng khuyết Hồ Xuân Hương, 14 trục đường chính, các chấm vàng công trình biểu tượng,
 *        cùng vị trí Camera, hướng nhìn và nón thị trường (FOV Frustum).
 *      - Cho phép click trực tiếp lên ô Tile bất kỳ trên Minimap để bay Camera tới ô đó.
 *   2. Popup Thông Tin Kiến Trúc (Architectural Landmark Inspector):
 *      - Hiển thị thẻ Glassmorphism chi tiết khi người dùng click vào công trình 3D hoặc khi
 *        Tour bay tự động ghé qua từng địa danh.
 *   3. Tour Bay Tự Động Quanh Đà Lạt (Automated Fly-Through Tour):
 *      - Hành trình bay 8 chặng quanh Hồ Xuân Hương & lõi di sản Đà Lạt với chuyển động spline
 *        mượt, thanh tiến độ chặng, nút Tạm dừng / Tiếp tục / Dừng và thuyết minh kiến trúc tự động.
 */

(function (global) {
  'use strict';

  const TOUR_WAYPOINTS = [
    {
      step: 1,
      id: 'tour_overview_hxh',
      title_vi: 'Chặng 1/15: Toàn cảnh Hồ Xuân Hương & Đồi Cù',
      landmark_id: null,
      tile_id: 'T_E00_N00',
      position_gltf: [-620.0, 340.0, 780.0],
      target_gltf: [40.0, 6.0, -120.0],
      fov: 48,
      flight_ms: 4200,
      hold_ms: 2800,
      caption_vi:
        'Khởi hành từ góc nhìn toàn cảnh thung lũng Hồ Xuân Hương (cao độ chuẩn 1478.0m MSL) bao quanh bởi rừng thông 3 lá và Đồi Cù.',
    },
    {
      step: 2,
      id: 'tour_quang_truong_lam_vien',
      title_vi: 'Chặng 2/15: Quảng trường Lâm Viên (Hoa Dã Quỳ & Nụ Atiso)',
      landmark_id: 'lm_01_quang_truong_lam_vien',
      tile_id: 'T_E00_N00',
      position_gltf: [-225.0, 72.0, 325.0],
      target_gltf: [-79.6, 12.0, 185.8],
      fov: 45,
      flight_ms: 4000,
      hold_ms: 3400,
      caption_vi:
        'Hạ độ cao xuống bờ Nam Hồ Xuân Hương ngắm khối Hoa Dã Quỳ vàng nghiêng và Nụ Atiso kính xanh xoắn ốc.',
    },
    {
      step: 3,
      id: 'tour_thuy_ta_cau_ong_dao',
      title_vi: 'Chặng 3/15: Nhà hàng Thủy Tạ & Đập tràn Cầu Ông Đạo',
      landmark_id: 'lm_06_thuy_ta_cau_ong_dao',
      tile_id: 'T_E00_N00',
      position_gltf: [-435.0, 56.0, 55.0],
      target_gltf: [-600.0, 5.0, -95.8],
      fov: 45,
      flight_ms: 3800,
      hold_ms: 3200,
      caption_vi:
        'Lướt dọc đường Trần Quốc Toản tới bán đảo Thủy Tạ trắng dáng du thuyền nổi trên mặt nước và nút giao Cầu Ông Đạo.',
    },
    {
      step: 4,
      id: 'tour_cho_da_lat_hoa_binh',
      title_vi: 'Chặng 4/15: Chợ Đà Lạt & Cầu thang chữ Y Khu Hòa Bình',
      landmark_id: 'lm_05_cho_da_lat_hoa_binh',
      tile_id: 'T_E00_N00',
      position_gltf: [-690.0, 96.0, 45.0],
      target_gltf: [-876.2, 16.0, -125.9],
      fov: 46,
      flight_ms: 3600,
      hold_ms: 3200,
      caption_vi:
        'Tiến vào trục thương mại Nguyễn Thị Minh Khai – Chợ Đà Lạt nối lên đồi Khu Hòa Bình.',
    },
    {
      step: 5,
      id: 'tour_nha_tho_con_ga',
      title_vi: 'Chặng 5/15: Nhà thờ Chính tòa Đà Lạt (Nhà thờ Con Gà)',
      landmark_id: 'lm_03_nha_tho_con_ga',
      tile_id: 'T_E00_N00',
      position_gltf: [-650.0, 115.0, 585.0],
      target_gltf: [-841.8, 45.0, 405.1],
      fov: 45,
      flight_ms: 3900,
      hold_ms: 3400,
      caption_vi:
        'Bay lên đồi Trần Phú (1510m MSL) chiêm ngưỡng tháp chuông Nhà thờ Chính tòa Đà Lạt cao 47m.',
    },
    {
      step: 6,
      id: 'tour_dinh_bao_dai_2',
      title_vi: 'Chặng 6/15: Đồi Thông Dinh Bảo Đại II (Trần Hưng Đạo)',
      landmark_id: 'lm_08_dinh_2',
      tile_id: 'T_E00_N00',
      position_gltf: [440.0, 155.0, 780.0],
      target_gltf: [723.3, 52.0, 547.6],
      fov: 46,
      flight_ms: 4400,
      hold_ms: 3000,
      caption_vi:
        'Băng qua rừng thông phía Đông Nam lên đồi Dinh II (1528m MSL) trên trục di sản Trần Hưng Đạo.',
    },
    {
      step: 7,
      id: 'tour_ga_da_lat',
      title_vi: 'Chặng 7/15: Nhà Ga Đà Lạt (Art Deco 3 Mái Langbiang)',
      landmark_id: 'lm_02_ga_da_lat',
      tile_id: 'T_E01_N00',
      position_gltf: [865.0, 98.0, 45.0],
      target_gltf: [1060.9, 28.0, -176.0],
      fov: 45,
      flight_ms: 4100,
      hold_ms: 3400,
      caption_vi:
        'Bay sang ô Tile phía Đông (T_E01_N00) ngắm kiến trúc Art Deco 3 mái chóp biểu tượng của Nhà Ga Đà Lạt (1938).',
    },
    {
      step: 8,
      id: 'tour_truong_cdsp',
      title_vi: 'Chặng 8/15: Trường Cao đẳng Sư phạm Đà Lạt (Lycée Yersin)',
      landmark_id: 'lm_04_truong_cdsp_dalat',
      tile_id: 'T_E00_N00',
      position_gltf: [620.0, 112.0, -430.0],
      target_gltf: [835.6, 36.0, -659.0],
      fov: 45,
      flight_ms: 4000,
      hold_ms: 3600,
      caption_vi:
        'Chiêm ngưỡng dãy giảng đường gạch đỏ hình vòng cung và tháp chuông cổ Trường CĐSP Đà Lạt (1935).',
    },
    {
      step: 9,
      id: 'tour_thai_phien_ring1',
      title_vi: 'Chặng 9/15: [RING_1] Làng Hoa Thái Phiên & Hồ Than Thở (T_E02_N01)',
      landmark_id: null,
      tile_id: 'T_E02_N01',
      position_gltf: [3650.0, 295.0, -2450.0],
      target_gltf: [4050.0, 42.0, -2050.0],
      fov: 48,
      flight_ms: 4400,
      hold_ms: 3200,
      caption_vi:
        'Bay ra vành đai RING_1 phía Đông Bắc ngắm thung lũng 670 nhà kính trồng hoa Thái Phiên rực sáng bên Hồ Than Thở.',
    },
    {
      step: 10,
      id: 'tour_lac_duong_langbiang_ring2',
      title_vi: 'Chặng 10/15: [RING_2] Thị trấn Lạc Dương – Chân Núi Langbiang (T_E00_N03)',
      landmark_id: null,
      tile_id: 'T_E00_N03',
      position_gltf: [-380.0, 410.0, -5450.0],
      target_gltf: [120.0, 58.0, -6100.0],
      fov: 48,
      flight_ms: 4600,
      hold_ms: 3400,
      caption_vi:
        'Tiến lên cửa ngõ Bắc RING_2 ngắm đô thị vệ tinh Thị trấn Lạc Dương, Thung lũng Trăm Năm và chân đỉnh Radar Langbiang.',
    },
    {
      step: 11,
      id: 'tour_xuan_tho_cau_dat_ring2',
      title_vi: 'Chặng 11/15: [RING_2] Xã Xuân Thọ – Đồi Chè Cầu Đất (T_E04_N00 / T_E05_S01)',
      landmark_id: null,
      tile_id: 'T_E05_S01',
      position_gltf: [9350.0, 385.0, 1650.0],
      target_gltf: [10000.0, 82.0, 2000.0],
      fov: 48,
      flight_ms: 4800,
      hold_ms: 3400,
      caption_vi:
        'Dọc hành lang Quốc lộ 20 Đông qua Trại Mát – Xuân Thọ tới cao nguyên Đồi Chè & Điện Gió Cầu Đất (1650m MSL).',
    },
    {
      step: 12,
      id: 'tour_ta_nung_tuyen_lam_ring2',
      title_vi: 'Chặng 12/15: [RING_2] Thung lũng Cà phê Tà Nung – Mê Linh & Hồ Tuyền Lâm',
      landmark_id: null,
      tile_id: 'T_W03_S02',
      position_gltf: [-5450.0, 320.0, 3450.0],
      target_gltf: [-6000.0, -95.0, 4000.0],
      fov: 48,
      flight_ms: 4800,
      hold_ms: 3600,
      caption_vi:
        'Bay qua cung đèo Tà Nung (ĐT725) và thung lũng cà phê Arabica Mê Linh hướng về cửa ngõ Thị trấn Nam Ban.',
    },
    {
      step: 13,
      id: 'tour_langbiang_peak_ring2',
      title_vi: 'Chặng 13/15: [RING_2] Đỉnh Núi Bà Langbiang (2167m) & Đỉnh Radar (1929m) (T_E00_N05)',
      landmark_id: null,
      tile_id: 'T_E00_N05',
      position_gltf: [-650.0, 760.0, -8850.0],
      target_gltf: [150.0, 620.0, -9850.0],
      fov: 52,
      flight_ms: 4900,
      hold_ms: 3500,
      caption_vi:
        'Bay lên nóc nhà Đà Lạt tại cụm đỉnh đôi Núi Bà (2.167m) – Núi Ông (2.124m) và Đỉnh Radar (1.929m) nhìn xuống toàn cảnh Lạc Dương.',
    },
    {
      step: 14,
      id: 'tour_dankia_lonely_pine_ring2',
      title_vi: 'Chặng 14/15: [RING_2] Cây Thông Cô Đơn & Đồi Cỏ Hồng Bờ Tây Hồ Dankia (T_W04_N04)',
      landmark_id: null,
      tile_id: 'T_W04_N04',
      position_gltf: [-8350.0, 165.0, -7350.0],
      target_gltf: [-7650.0, 45.0, -7680.0],
      fov: 46,
      flight_ms: 4800,
      hold_ms: 3500,
      caption_vi:
        'Lướt qua mặt hồ Dankia – Suối Vàng tới thảo nguyên Đồi Cỏ Hồng và đồi Cây Thông Cô Đơn phía Tây Bắc cao nguyên.',
    },
    {
      step: 15,
      id: 'tour_caudat_1927_wind_turbines_ring2',
      title_vi: 'Chặng 15/15: [RING_2] Nhà Máy Chè Cổ 1927 & 15 Tuabin Điện Gió Cầu Đất (T_E06_S03 / T_E07_S04)',
      landmark_id: null,
      tile_id: 'T_E07_S04',
      position_gltf: [13350.0, 290.0, 7750.0],
      target_gltf: [14120.0, 175.0, 8250.0],
      fov: 50,
      flight_ms: 5000,
      hold_ms: 3800,
      caption_vi:
        'Khép lại đại hành trình 69 ô Tile tại Sở Trà Cầu Đất 1927 và sống núi 15 Tuabin Điện Gió Cầu Đất trong biển mây 1.650m MSL.',
    },
  ];

  // Đường viền Hồ Xuân Hương rút gọn trong hệ tọa độ phẳng cục bộ (x_m, y_m) cho Minimap Radar
  const LAKE_CONTOUR_XY = [
    [-755, 55], [-660, 18], [-460, -15], [-210, -75],
    [15, -110], [245, -125], [470, -105], [515, -45],
    [410, 15], [480, 95], [610, 160], [510, 240],
    [545, 380], [490, 575], [440, 770], [375, 730],
    [355, 535], [395, 360], [310, 210], [180, 115],
    [15, 145], [-195, 195], [-435, 185], [-565, 120],
    [-640, 145], [-725, 115], [-755, 55],
  ];

  class DalatMinimapHud {
    constructor(engine) {
      this.engine = engine;
      this.streamer = engine.streamer;

      this.canvas = document.getElementById('minimap-canvas');
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.rangeRadiusM = 3400.0; // Mặc định hiển thị RING_0 + viền RING_1 (6.8km x 6.8km)
      this.activeRingMode = 0; // 0 -> RING_0 (6.8km), 1 -> RING_1 (14.5km), 2 -> RING_2 (30km)

      // Trạng thái Tour bay tự động
      this.tourActive = false;
      this.tourPaused = false;
      this.tourIndex = 0;
      this.tourHoldTimer = null;

      // Công trình đang chọn
      this.selectedLandmarkId = null;

      this._bindMinimapEvents();
      this._bindPopupEvents();
      this._bindTourEvents();
    }

    _bindMinimapEvents() {
      // Nút đổi tầm bao quát Radar (RING_0 / RING_1 / RING_2)
      document.querySelectorAll('[data-minimap-ring]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const r = parseInt(btn.dataset.minimapRing, 10) || 0;
          this.setMinimapRingRange(r);
          document.querySelectorAll('[data-minimap-ring]').forEach((b) => {
            b.classList.toggle('active', b === btn);
          });
        });
      });

      // Click trực tiếp trên bản đồ Radar Minimap để bay Camera tới vị trí hoặc ô Tile đó
      if (this.canvas) {
        this.canvas.addEventListener('click', (e) => {
          const rect = this.canvas.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
          const py = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
          const cx = this.canvas.width * 0.5;
          const cy = this.canvas.height * 0.5;
          const scale = (this.canvas.width * 0.44) / this.rangeRadiusM;

          const xLocal = (px - cx) / scale;
          const yNorth = (cy - py) / scale;
          const { ix, iy } = window.DALAT_COORDS.tileIndicesForXY(xLocal, yNorth);
          const tileId = window.DALAT_COORDS.formatTileId(ix, iy);
          const elevLocal = window.DALAT_COORDS.syntheticLocalY(xLocal, yNorth);

          this.stopTour();
          this.engine.flyToPreset({
            id: `minimap_${tileId}`,
            name_vi: `Ô Tile ${tileId}`,
            tile_id: tileId,
            position_gltf: [xLocal - 360, Math.max(140, elevLocal + 240), -yNorth + 460],
            target_gltf: [xLocal, elevLocal + 6, -yNorth],
            fov: 48,
            duration_ms: 1250,
          });
        });
      }
    }

    setMinimapRingRange(ringIdx) {
      this.activeRingMode = ringIdx;
      if (ringIdx === 0) this.rangeRadiusM = 3400.0;
      else if (ringIdx === 1) this.rangeRadiusM = 7400.0;
      else this.rangeRadiusM = 15200.0;
    }

    _bindPopupEvents() {
      const closeBtn = document.getElementById('landmark-popup-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hideLandmarkPopup());
      }
      const focusBtn = document.getElementById('landmark-popup-focus');
      if (focusBtn) {
        focusBtn.addEventListener('click', () => {
          if (!this.selectedLandmarkId) return;
          const meta = this.streamer.landmarkCatalog[this.selectedLandmarkId];
          if (!meta) return;
          const pos = meta.gltf_position || [meta.x_m || 0, meta.z_local_m || 10, -(meta.y_m || 0)];
          this.engine.flyToPreset({
            id: meta.id,
            name_vi: meta.name_vi,
            tile_id: meta.tile_id,
            position_gltf: [pos[0] - 140, pos[1] + 68, pos[2] + 155],
            target_gltf: [pos[0], pos[1] + 10, pos[2]],
            fov: 44,
            duration_ms: 1200,
          });
        });
      }
    }

    showLandmarkPopup(meta) {
      if (!meta) return;
      this.selectedLandmarkId = meta.id;
      const popup = document.getElementById('landmark-info-popup');
      if (!popup) return;

      const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };

      setTxt('popup-lm-title', meta.name_vi || meta.id);
      setTxt('popup-lm-en', meta.name_en || 'Da Lat Architectural Heritage');
      setTxt('popup-lm-tile', meta.tile_id || 'T_E00_N00');
      setTxt('popup-lm-elev', `${Number(meta.elev_msl_m || 1480).toFixed(1)} m MSL`);
      setTxt('popup-lm-style', meta.architectural_style || 'Kiến trúc Di sản Đà Lạt');
      setTxt('popup-lm-arch', meta.architect || 'Kiến trúc sư Pháp – Việt');
      setTxt('popup-lm-year', meta.year_completed || 'Thế kỷ 20');
      setTxt(
        'popup-lm-coords',
        `${Number(meta.lat || 11.9404).toFixed(5)}°N, ${Number(meta.lon || 108.4452).toFixed(5)}°E`
      );
      setTxt(
        'popup-lm-desc',
        meta.description_vi ||
          'Công trình biểu tượng thuộc vùng lõi quy hoạch di sản đô thị cao nguyên Đà Lạt.'
      );

      const badge = document.getElementById('popup-lm-status');
      if (badge) {
        const isBuilt = Boolean(meta.built || meta.isRealGlb);
        badge.textContent = isBuilt ? 'LOD3/4 GLB Thực Tế' : 'Procedural 3D Marker';
        badge.className = isBuilt ? 'chip chip-emerald' : 'chip chip-amber';
      }

      if (window.innerWidth <= 900) {
        const panel = document.getElementById('control-panel');
        if (panel) panel.classList.add('collapsed');
        document.body.classList.remove('mobile-drawer-open');
      }
      popup.classList.remove('hidden');
    }

    hideLandmarkPopup() {
      this.selectedLandmarkId = null;
      const popup = document.getElementById('landmark-info-popup');
      if (popup) popup.classList.add('hidden');
    }

    /* ========================================================================
     * TOUR BAY TỰ ĐỘNG QUANH ĐÀ LẠT (8 CHẶNG LIÊN HOÀN)
     * ======================================================================== */

    _bindTourEvents() {
      const startBtn = document.getElementById('start-tour-btn');
      const stopBtn = document.getElementById('stop-tour-btn');
      const nextBtn = document.getElementById('next-tour-step-btn');

      if (startBtn) {
        startBtn.addEventListener('click', () => {
          if (!this.tourActive) {
            this.startTour(0);
          } else {
            this.togglePauseTour();
          }
        });
      }
      if (stopBtn) {
        stopBtn.addEventListener('click', () => this.stopTour());
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          if (this.tourActive) {
            this._advanceTourStep((this.tourIndex + 1) % TOUR_WAYPOINTS.length);
          } else {
            this.startTour(0);
          }
        });
      }
    }

    startTour(startIndex) {
      if (this.tourHoldTimer) {
        clearTimeout(this.tourHoldTimer);
        this.tourHoldTimer = null;
      }
      if (window.innerWidth <= 900) {
        const panel = document.getElementById('control-panel');
        if (panel) panel.classList.add('collapsed');
        document.body.classList.remove('mobile-drawer-open');
      }
      this.tourActive = true;
      this.tourPaused = false;
      this._updateTourUiState();
      this._advanceTourStep(startIndex || 0);
    }

    togglePauseTour() {
      if (!this.tourActive) return;
      this.tourPaused = !this.tourPaused;
      if (this.tourPaused) {
        if (this.tourHoldTimer) {
          clearTimeout(this.tourHoldTimer);
          this.tourHoldTimer = null;
        }
        this.engine.flightAnim = null;
      } else {
        this._advanceTourStep(this.tourIndex);
      }
      this._updateTourUiState();
    }

    stopTour() {
      if (this.tourHoldTimer) {
        clearTimeout(this.tourHoldTimer);
        this.tourHoldTimer = null;
      }
      this.tourActive = false;
      this.tourPaused = false;
      this.engine.flightAnim = null;
      this._updateTourUiState();
    }

    _advanceTourStep(idx) {
      if (!this.tourActive || this.tourPaused) return;
      this.tourIndex = idx % TOUR_WAYPOINTS.length;
      const wp = TOUR_WAYPOINTS[this.tourIndex];

      this._updateTourBanner(wp);

      if (wp.landmark_id && this.streamer.landmarkCatalog[wp.landmark_id]) {
        this.showLandmarkPopup(this.streamer.landmarkCatalog[wp.landmark_id]);
      }

      this.engine.flyToPreset({
        id: wp.id,
        name_vi: wp.title_vi,
        tile_id: wp.tile_id,
        position_gltf: wp.position_gltf,
        target_gltf: wp.target_gltf,
        fov: wp.fov,
        duration_ms: wp.flight_ms,
        onComplete: () => {
          if (!this.tourActive || this.tourPaused) return;
          this.tourHoldTimer = setTimeout(() => {
            this._advanceTourStep((this.tourIndex + 1) % TOUR_WAYPOINTS.length);
          }, wp.hold_ms);
        },
      });
    }

    _updateTourUiState() {
      const startBtn = document.getElementById('start-tour-btn');
      const stopBtn = document.getElementById('stop-tour-btn');
      const banner = document.getElementById('tour-status-banner');

      if (startBtn) {
        if (!this.tourActive) {
          startBtn.textContent = '▶ Tour Bay Tự Động Quanh Đà Lạt';
          startBtn.classList.remove('is-running');
        } else if (this.tourPaused) {
          startBtn.textContent = '▶ Tiếp tục Tour Bay';
          startBtn.classList.add('is-running');
        } else {
          startBtn.textContent = '⏸ Tạm dừng Tour Bay';
          startBtn.classList.add('is-running');
        }
      }
      if (stopBtn) {
        stopBtn.classList.toggle('hidden', !this.tourActive);
      }
      if (banner) {
        banner.classList.toggle('hidden', !this.tourActive);
      }
    }

    _updateTourBanner(wp) {
      const titleEl = document.getElementById('tour-step-title');
      const descEl = document.getElementById('tour-step-caption');
      const barEl = document.getElementById('tour-progress-fill');
      if (titleEl) titleEl.textContent = wp.title_vi;
      if (descEl) descEl.textContent = wp.caption_vi;
      if (barEl) {
        const pct = Math.round((wp.step / TOUR_WAYPOINTS.length) * 100);
        barEl.style.width = `${pct}%`;
      }
    }

    /* ========================================================================
     * VẼ BẢN ĐỒ RADAR MINIMAP 2D THỜI GIAN THỰC
     * ======================================================================== */

    update() {
      if (!this.ctx || !this.canvas) return;
      const ctx = this.ctx;
      const W = this.canvas.width;
      const H = this.canvas.height;
      const cx = W * 0.5;
      const cy = H * 0.5;
      const scale = (W * 0.44) / this.rangeRadiusM;

      ctx.clearRect(0, 0, W, H);

      // Nền radar tối
      ctx.fillStyle = 'rgba(8, 17, 30, 0.92)';
      ctx.fillRect(0, 0, W, H);

      // Vòng tròn radar đồng tâm
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
      ctx.lineWidth = 1;
      [0.33, 0.66, 0.95].forEach((rRatio) => {
        ctx.beginPath();
        ctx.arc(cx, cy, W * 0.46 * rRatio, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Vẽ các ô Tile 2000m x 2000m từ tileRegistry
      const tiles = this.streamer.getTileStatusSnapshot();
      const tilePxSize = window.DALAT_COORDS.TILE_SIZE_M * scale;

      let loadedLodCount = 0;
      let builtTileCount = 0;

      for (const rec of tiles) {
        if (rec.has_any_real_data || rec.is_fallback_active) builtTileCount++;
        if (rec.current_lod === 'LOD0' || rec.current_lod === 'LOD1') loadedLodCount++;

        const left = cx + (rec.center_x - 1000) * scale;
        const top = cy - (rec.center_y + 1000) * scale;
        if (left + tilePxSize < 0 || left > W || top + tilePxSize < 0 || top > H) continue;

        if (rec.has_any_real_data) {
          ctx.fillStyle =
            rec.current_lod === 'LOD0'
              ? 'rgba(16, 185, 129, 0.34)'
              : 'rgba(16, 185, 129, 0.18)';
        } else if (rec.is_fallback_active) {
          ctx.fillStyle = 'rgba(251, 191, 36, 0.22)';
        } else {
          ctx.fillStyle = 'rgba(30, 41, 59, 0.35)';
        }
        ctx.fillRect(left, top, tilePxSize, tilePxSize);

        ctx.strokeStyle =
          rec.current_lod === 'LOD0'
            ? 'rgba(56, 189, 248, 0.85)'
            : rec.ring === 0
              ? 'rgba(52, 211, 153, 0.55)'
              : 'rgba(148, 163, 184, 0.25)';
        ctx.lineWidth = rec.current_lod === 'LOD0' ? 1.6 : 1.0;
        ctx.strokeRect(left, top, tilePxSize, tilePxSize);

        // Nhãn mã Tile
        if (tilePxSize >= 36) {
          ctx.fillStyle = rec.has_any_real_data ? '#a7f3d0' : '#94a3b8';
          ctx.font = 'bold 9px "Cascadia Code", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(rec.tile_id.replace('T_', ''), left + 4, top + 11);
        }
      }

      // Vẽ hình trăng khuyết Hồ Xuân Hương ở tâm
      ctx.beginPath();
      LAKE_CONTOUR_XY.forEach(([x, y], i) => {
        const px = cx + x * scale;
        const py = cy - y * scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(43, 143, 160, 0.85)';
      ctx.fill();
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Vẽ các chấm địa danh kiến trúc
      const lms = this.streamer.getLandmarkList();
      for (const lm of lms) {
        const lx = Number(lm.x_m ?? (lm.gltf_position ? lm.gltf_position[0] : 0));
        const ly = Number(lm.y_m ?? (lm.gltf_position ? -lm.gltf_position[2] : 0));
        const px = cx + lx * scale;
        const py = cy - ly * scale;
        if (px < 4 || px > W - 4 || py < 4 || py > H - 4) continue;

        const isSel = lm.id === this.selectedLandmarkId;
        ctx.beginPath();
        ctx.arc(px, py, isSel ? 4.5 : 2.8, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? '#38bdf8' : '#fbbf24';
        ctx.fill();
      }

      // Vẽ vị trí Camera & nón thị trường (FOV Frustum)
      const camPos = this.engine.camera.position;
      const camX = camPos.x;
      const camYNorth = -camPos.z;
      const cpx = Math.max(8, Math.min(W - 8, cx + camX * scale));
      const cpy = Math.max(8, Math.min(H - 8, cy - camYNorth * scale));

      const forward = new THREE.Vector3();
      this.engine.camera.getWorldDirection(forward);
      // Trong mặt phẳng radar (X=East sang phải, Y_north=-Z_gltf lên trên):
      const headingRad = Math.atan2(forward.z, forward.x);
      const fovHalf = THREE.MathUtils.degToRad((this.engine.camera.fov || 48) * 0.5);
      const coneLen = 36;

      ctx.beginPath();
      ctx.moveTo(cpx, cpy);
      ctx.lineTo(
        cpx + Math.cos(headingRad - fovHalf) * coneLen,
        cpy + Math.sin(headingRad - fovHalf) * coneLen
      );
      ctx.lineTo(
        cpx + Math.cos(headingRad + fovHalf) * coneLen,
        cpy + Math.sin(headingRad + fovHalf) * coneLen
      );
      ctx.closePath();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.28)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Tâm Camera
      ctx.beginPath();
      ctx.arc(cpx, cpy, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = '#f43f5e';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Cập nhật nhãn thống kê LOD trên khung Minimap
      const statEl = document.getElementById('minimap-lod-stat');
      if (statEl) {
        const curTile = window.DALAT_COORDS.tileIndicesForXY(camX, camYNorth);
        const curTid = window.DALAT_COORDS.formatTileId(curTile.ix, curTile.iy);
        statEl.textContent = `${curTid} • Active LOD: ${loadedLodCount} ô • Đã dựng: ${builtTileCount} ô`;
      }
    }
  }

  global.TOUR_WAYPOINTS = TOUR_WAYPOINTS;
  global.DalatMinimapHud = DalatMinimapHud;
})(window);
