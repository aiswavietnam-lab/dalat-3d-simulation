/**
 * tile_streamer.js — Quản Lý Hệ Tọa Độ Đà Lạt, LOD Tile Streamer (RING_0..3) & Fallback Procedural
 * Dự án: DALAT_3D_SIMULATION (Slot 5 — Wave 3: T5_W3_LOD_STREAMER_MINIMAP_TOUR)
 * ============================================================================
 * - Đồng bộ khóa cứng 100% với 03_SOURCE_CODE/shared/dalat_coords.py:
 *     Gốc (0, 0, 0): Tâm Hồ Xuân Hương (11.940419, 108.445259, 1478.0m MSL)
 *     Three.js Y-Up: X_gltf = x_m, Y_gltf = z_local, Z_gltf = -y_m
 * - Nâng cấp Wave 3:
 *     + Nạp/gỡ Tile động theo khoảng cách camera (LOD0 / LOD1 / LOD2 / CULLED) có trễ
 *       hysteresis chống giật, hỗ trợ mở rộng lên hàng trăm ô Tile RING_0..3.
 *     + Hỗ trợ đọc instances_<TILE_ID>.json từ Slot 3 ở cả định dạng mảng 6 phần tử
 *       [x_m, y_m, z_local, scale, rot_rad, species_idx] lẫn định dạng object.
 *     + Tích hợp danh mục kiến trúc 18 công trình biểu tượng Đà Lạt (đồng bộ với
 *       landmarks_manifest.json từ Slot 4) phục vụ click raycast xem thông tin kiến trúc.
 *     + Cung cấp snapshot trạng thái lưới Tile thời gian thực cho Minimap Radar HUD.
 */

(function (global) {
  'use strict';

  const DALAT_COORDS = {
    LAT0: 11.940419,
    LON0: 108.445259,
    Z0_MSL: 1478.0,
    TILE_SIZE_M: 2000.0,
    HALF_TILE_M: 1000.0,
    METERS_PER_DEG_LAT: 111319.49,
    METERS_PER_DEG_LON: 108911.0,

    latLonToLocal(lat, lon, elevMsl) {
      const x = (lon - this.LON0) * this.METERS_PER_DEG_LON;
      const y = (lat - this.LAT0) * this.METERS_PER_DEG_LAT;
      const z = elevMsl == null ? 0.0 : elevMsl - this.Z0_MSL;
      return { x, y, z };
    },

    localToLatLon(x, y) {
      return {
        lat: this.LAT0 + y / this.METERS_PER_DEG_LAT,
        lon: this.LON0 + x / this.METERS_PER_DEG_LON,
      };
    },

    localToGltf(x, y, zLocal) {
      return new THREE.Vector3(x, zLocal, -y);
    },

    gltfToLocal(vec3) {
      return {
        x: vec3.x,
        y: -vec3.z,
        zLocal: vec3.y,
        elevMsl: vec3.y + this.Z0_MSL,
      };
    },

    tileIndicesForXY(x, y) {
      const ix = Math.floor((x + this.HALF_TILE_M) / this.TILE_SIZE_M);
      const iy = Math.floor((y + this.HALF_TILE_M) / this.TILE_SIZE_M);
      return { ix, iy };
    },

    formatTileId(ix, iy) {
      const ew = ix < 0 ? 'W' : 'E';
      const ns = iy < 0 ? 'S' : 'N';
      const xx = String(Math.abs(ix)).padStart(2, '0');
      const yy = String(Math.abs(iy)).padStart(2, '0');
      return `T_${ew}${xx}_${ns}${yy}`;
    },

    parseTileId(tileId) {
      const m = /^T_([EW])(\d{2})_([NS])(\d{2})$/.exec(String(tileId || '').trim());
      if (!m) return { ix: 0, iy: 0 };
      const ix = m[1] === 'W' ? -parseInt(m[2], 10) : parseInt(m[2], 10);
      const iy = m[3] === 'S' ? -parseInt(m[4], 10) : parseInt(m[4], 10);
      return { ix, iy };
    },

    tileCenterLocal(tileId) {
      const { ix, iy } = this.parseTileId(tileId);
      return {
        ix,
        iy,
        x_m: ix * this.TILE_SIZE_M,
        y_m: iy * this.TILE_SIZE_M,
      };
    },

    ringForTile(ix, iy) {
      const d = Math.max(Math.abs(ix), Math.abs(iy));
      if (d <= 1) return 0;
      if (d <= 3) return 1;
      if (d <= 7) return 2;
      return 3;
    },

    _gauss(x, y, cx, cy, sx, sy, amp) {
      const dx = (x - cx) / sx;
      const dy = (y - cy) / sy;
      return amp * Math.exp(-0.5 * (dx * dx + dy * dy));
    },

    _distToSegment(px, py, ax, ay, bx, by) {
      const vx = bx - ax;
      const vy = by - ay;
      const wx = px - ax;
      const wy = py - ay;
      const c1 = vx * wx + vy * wy;
      if (c1 <= 0.0) return Math.hypot(px - ax, py - ay);
      const c2 = vx * vx + vy * vy;
      if (c2 <= c1) return Math.hypot(px - bx, py - by);
      const t = c1 / c2;
      return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    },

    lakeMinRatio(x, y) {
      const hxPts = [
        [-720.0, 60.0, 95.0],
        [-450.0, 100.0, 145.0],
        [-150.0, 40.0, 175.0],
        [140.0, -40.0, 155.0],
        [360.0, 110.0, 140.0],
        [510.0, 370.0, 130.0],
        [420.0, 690.0, 125.0],
      ];
      let minRatio = 999.0;
      for (let i = 0; i < hxPts.length - 1; i++) {
        const [ax, ay, ar] = hxPts[i];
        const [bx, by, br] = hxPts[i + 1];
        const d = this._distToSegment(x, y, ax, ay, bx, by);
        const r = 0.5 * (ar + br);
        const ratio = d / Math.max(r, 1.0);
        if (ratio < minRatio) minRatio = ratio;
      }
      return minRatio;
    },

    syntheticElevationMsl(x, y) {
      const base =
        1490.0 +
        12.0 * Math.sin(x * 0.00055) * Math.cos(y * 0.0005) +
        8.0 * Math.sin((x + y) * 0.00095) +
        4.0 * Math.cos((x - 1.3 * y) * 0.0018);

      const hills =
        this._gauss(x, y, 120.0, 680.0, 480.0, 340.0, 28.0) +
        this._gauss(x, y, -840.0, -405.0, 320.0, 280.0, 26.0) +
        this._gauss(x, y, 725.0, -545.0, 420.0, 340.0, 36.0) +
        this._gauss(x, y, 2310.0, -880.0, 650.0, 520.0, 60.0) +
        this._gauss(x, y, -1690.0, -1115.0, 520.0, 460.0, 48.0) +
        this._gauss(x, y, -1580.0, 940.0, 480.0, 420.0, 32.0) +
        this._gauss(x, y, 1100.0, 480.0, 450.0, 380.0, 14.0) +
        this._gauss(x, y, 300.0, -2400.0, 700.0, 550.0, 64.0) +
        this._gauss(x, y, -750.0, 11800.0, 2400.0, 2000.0, 660.0);

      const valleys =
        -this._gauss(x, y, -1550.0, -4100.0, 1400.0, 1100.0, 118.0) -
        this._gauss(x, y, -2100.0, 40.0, 600.0, 350.0, 42.0) -
        this._gauss(x, y, -880.0, 130.0, 240.0, 220.0, 4.0) -
        this._gauss(x, y, -80.0, -185.0, 160.0, 130.0, 10.0);

      const elev = base + hills + valleys;
      const minRatio = this.lakeMinRatio(x, y);
      if (minRatio <= 0.85) return this.Z0_MSL;
      if (minRatio < 1.35) {
        const t = (minRatio - 0.85) / 0.5;
        const s = t * t * (3.0 - 2.0 * t);
        return this.Z0_MSL * (1.0 - s) + elev * s;
      }
      return elev;
    },

    syntheticLocalY(x, y) {
      return this.syntheticElevationMsl(x, y) - this.Z0_MSL;
    },
  };

  /**
   * Danh mục thông tin kiến trúc các công trình biểu tượng Đà Lạt (phục vụ click popup & Tour bay)
   */
  const DEFAULT_LANDMARK_CATALOG = {
    lm_01_quang_truong_lam_vien: {
      id: 'lm_01_quang_truong_lam_vien',
      name_vi: 'Quảng trường Lâm Viên (Hoa Dã Quỳ & Nụ Atiso)',
      name_en: 'Lam Vien Square (Wild Sunflower & Artichoke Bud)',
      tile_id: 'T_E00_N00',
      lat: 11.93875,
      lon: 108.444528,
      elev_msl_m: 1480.0,
      x_m: -79.614,
      y_m: -185.792,
      z_local_m: 2.0,
      gltf_position: [-79.614, 2.0, 185.792],
      rotation_y_rad: -5.846853,
      architectural_style: 'Contemporary Parametric Glass & Steel Diagrid',
      architect: 'KTS Trần Văn Dũng',
      year_completed: '2015',
      description_vi:
        'Trái tim đương đại bên bờ Nam Hồ Xuân Hương (khánh thành 2015), nổi bật với khối Hoa Dã Quỳ nghiêng cao hơn 18m ôm khán phòng nghệ thuật và khối Nụ Atiso xoắn cao 15m bằng hệ gân thép và kính màu phát sáng rực rỡ trong sương đêm phố núi.',
    },
    lm_06_thuy_ta_cau_ong_dao: {
      id: 'lm_06_thuy_ta_cau_ong_dao',
      name_vi: 'Nhà hàng Thủy Tạ & Cầu Ông Đạo',
      name_en: 'Thuy Ta Lakeside Pavilion & Ong Dao Bridge',
      tile_id: 'T_E00_N00',
      lat: 11.94128,
      lon: 108.43975,
      elev_msl_m: 1478.2,
      x_m: -599.99,
      y_m: 95.846,
      z_local_m: 0.2,
      gltf_position: [-599.99, 0.2, -95.846],
      rotation_y_rad: -1.919862,
      architectural_style: 'Streamline Moderne / French Colonial Nautical',
      architect: 'Quy hoạch Ernest Hébrard – Pineau',
      year_completed: '1930s (tôn tạo hiện đại)',
      description_vi:
        'Công trình kiến trúc trắng dáng du thuyền nổi trên bán đảo phía Tây Hồ Xuân Hương (xây dựng từ thập niên 1930, tiền thân là câu lạc bộ thể thao dưới nước Grenouille), kết nối trực tiếp với đập tràn và nút giao Cầu Ông Đạo.',
    },
    lm_02_ga_da_lat: {
      id: 'lm_02_ga_da_lat',
      name_vi: 'Nhà Ga Đà Lạt (Art Deco 3 Mái Langbiang)',
      name_en: 'Da Lat Historic Railway Station',
      tile_id: 'T_E01_N00',
      lat: 11.942,
      lon: 108.455,
      elev_msl_m: 1500.0,
      x_m: 1060.901,
      y_m: 175.996,
      z_local_m: 22.0,
      gltf_position: [1060.901, 22.0, -175.996],
      rotation_y_rad: 0.0,
      architectural_style: 'Normandy Art Deco & Central Highlands Vernacular',
      architect: 'Paul Moncet & Révéron',
      year_completed: '1938',
      description_vi:
        'Nhà ga cổ kính nhất Đông Dương (1932–1938) do KTS Moncet và Révéron thiết kế, kết hợp phong cách Art Deco miền Normandy (Pháp) với 3 đỉnh mái chóp tượng trưng cho 3 đỉnh núi Langbiang cùng mặt đồng hồ lớn và tuyến đường sắt răng cưa Tháp Chàm – Đà Lạt.',
    },
    lm_04_truong_cdsp_dalat: {
      id: 'lm_04_truong_cdsp_dalat',
      name_vi: 'Trường Cao đẳng Sư phạm Đà Lạt (Lycée Yersin)',
      name_en: 'Grand Lycée Yersin / Da Lat Pedagogical College',
      tile_id: 'T_E00_N00',
      lat: 11.946339,
      lon: 108.452931,
      elev_msl_m: 1505.0,
      x_m: 835.564,
      y_m: 659.011,
      z_local_m: 27.0,
      gltf_position: [835.564, 27.0, -659.011],
      rotation_y_rad: 0.0,
      architectural_style: 'French Neo-Romanesque Curved Brick & Bell Tower',
      architect: 'KTS Paul Moncet',
      year_completed: '1935',
      description_vi:
        'Di tích kiến trúc quốc gia được Hiệp hội Kiến trúc sư Quốc tế (UIA) công nhận là 1 trong 1.000 công trình tiêu biểu thế kỷ 20, nổi tiếng với dãy giảng đường gạch trần đỏ châu Âu uốn vòng cung mềm mại và tháp chuông cao 54m.',
    },
    lm_03_nha_tho_con_ga: {
      id: 'lm_03_nha_tho_con_ga',
      name_vi: 'Nhà thờ Chính tòa Đà Lạt (Nhà thờ Con Gà)',
      name_en: 'St. Nicholas Cathedral of Da Lat',
      tile_id: 'T_E00_N00',
      lat: 11.936779,
      lon: 108.43753,
      elev_msl_m: 1510.0,
      x_m: -841.772,
      y_m: -405.092,
      z_local_m: 32.0,
      gltf_position: [-841.772, 32.0, 405.092],
      rotation_y_rad: 0.0,
      architectural_style: 'European Romanesque Revival',
      architect: 'Cha Célestin Quách (khởi xướng)',
      year_completed: '1942',
      description_vi:
        'Nhà thờ Chính tòa giáo phận Đà Lạt xây dựng từ 1931–1942 trên trục đường Trần Phú theo bố cục chữ thập Roman cổ điển dài 65m, tháp chuông vươn cao 47m gắn biểu tượng gà trống thu lôi và 70 tấm kính màu từ xưởng Lorin (Chartres, Pháp).',
    },
    lm_05_cho_da_lat_hoa_binh: {
      id: 'lm_05_cho_da_lat_hoa_binh',
      name_vi: 'Chợ Đà Lạt & Cầu Thang Chữ Y Khu Hòa Bình',
      name_en: 'Da Lat Central Market & Hoa Binh Center',
      tile_id: 'T_E00_N00',
      lat: 11.94155,
      lon: 108.437214,
      elev_msl_m: 1484.0,
      x_m: -876.188,
      y_m: 125.902,
      z_local_m: 6.0,
      gltf_position: [-876.188, 6.0, -125.902],
      rotation_y_rad: 0.0,
      architectural_style: 'Vietnamese Tropical Modernism & Terraced Urbanism',
      architect: 'KTS Nguyễn Duy Đức & KTS Ngô Viết Thụ (chỉnh trang)',
      year_completed: '1960',
      description_vi:
        'Quần thể thương mại trung tâm nằm trong thung lũng Nguyễn Thị Minh Khai, kết nối trực tiếp lên đồi Khu Hòa Bình bằng cầu nối bê tông và hệ cầu thang bộ chữ Y nổi tiếng bậc nhất Đà Lạt.',
    },
    lm_08_dinh_2: {
      id: 'lm_08_dinh_2',
      name_vi: 'Dinh Bảo Đại II (Dinh Toàn Quyền Decoux)',
      name_en: 'Governor General Mansion (Palace II)',
      tile_id: 'T_E00_N00',
      lat: 11.9355,
      lon: 108.4519,
      elev_msl_m: 1528.0,
      x_m: 723.277,
      y_m: -547.581,
      z_local_m: 50.0,
      gltf_position: [723.277, 50.0, 547.581],
      rotation_y_rad: 0.0,
      architectural_style: 'French Colonial Art Deco Villa',
      architect: 'KTS Nguyễn Lương & Huỳnh Tấn Phát, A. Léonard',
      year_completed: '1937',
      description_vi:
        'Dinh thự mùa hè của Toàn quyền Đông Dương Jean Decoux tọa lạc trên đồi thông cao 1528m đường Trần Hưng Đạo, sử dụng đá rửa bản địa màu vàng kem với tầm nhìn bao quát toàn bộ Hồ Xuân Hương.',
    },
    lm_12_dalat_palace: {
      id: 'lm_12_dalat_palace',
      name_vi: 'Khách sạn Dalat Palace Heritage',
      name_en: 'Langbian Palace / Dalat Palace Heritage Hotel',
      tile_id: 'T_E00_N00',
      lat: 11.93955,
      lon: 108.4414,
      elev_msl_m: 1492.0,
      x_m: -420.287,
      y_m: -96.737,
      z_local_m: 14.0,
      gltf_position: [-420.287, 14.0, 96.737],
      rotation_y_rad: 0.0,
      architectural_style: 'French Belle Époque & Neoclassical Luxury Hotel',
      architect: 'Quy hoạch Ernest Hébrard',
      year_completed: '1922',
      description_vi:
        'Khách sạn di sản lâu đời nhất Đà Lạt (khánh thành năm 1922 với tên gọi Langbian Palace), nằm giữa đồi cỏ xanh rộng 5ha nhìn thẳng xuống mặt nước Hồ Xuân Hương.',
    },
  };

  /**
   * Cấu hình khoảng cách LOD theo bán kính từ camera tới tâm ô Tile 2000m x 2000m
   * Có khoảng trễ hysteresis (+650m) để không nạp/gỡ liên tục khi camera dừng ở ranh giới
   */
  const LOD_CONFIG = {
    LOD0_MAX_M: 2800.0, // Chi tiết tối đa: Địa hình + Hồ + Rừng thông/Mai Anh Đào + Công trình + Đường OSM thật + Nhà dân
    LOD1_MAX_M: 4800.0, // Trung bình: Địa hình + Hồ + Công trình + Đường + Nhà dân + Thông chính
    LOD2_MAX_M: 10500.0, // Xa: Địa hình + Hồ lớn + Công trình chính (xa hơn nối liền bằng nền đại cảnh Copernicus 60km)
    UNLOAD_HYSTERESIS_M: 600.0,
  };

  function createRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class DalatTileStreamer {
    constructor(scene, pbrLibrary) {
      this.scene = scene;
      this.pbrLibrary = pbrLibrary || null;
      this.loader = typeof THREE.GLTFLoader === 'function' ? new THREE.GLTFLoader() : null;

      this.layers = {
        terrain: new THREE.Group(),
        water: new THREE.Group(),
        vegetation: new THREE.Group(),
        landmarks: new THREE.Group(),
        roads: new THREE.Group(),
        buildings: new THREE.Group(),
        grid: new THREE.Group(),
      };

      Object.keys(this.layers).forEach((key) => {
        this.layers[key].name = `layer_${key}`;
        this.scene.add(this.layers[key]);
      });

      this.loadedUrls = new Set();
      this.queuedUrls = new Set();
      this._streamQueue = [];
      this._activeStreams = 0;
      this._maxConcurrentStreams = 4;
      this._completedStreamCount = 0;
      this._lastRebuildCount = 0;
      this.emissiveMaterials = [];
      this.terrainMaterials = [];
      this.waterMaterials = [];
      this.waterMeshes = [];
      this.terrainPickMeshes = [];
      this.pickableMeshes = [];
      this.landmarkMeshes = [];
      this.vegShadowMeshes = [];
      this.lodScale = 1.0;
      this.terrainEnhancer = null;
      this.waterEnhancer = null;
      this.onStreamBatchSettled = null;
      this.landmarkCatalog = Object.assign({}, DEFAULT_LANDMARK_CATALOG);
      this.worldIndex = null;

      // Quản lý trạng thái từng ô Tile cho LOD Streamer & Minimap Radar HUD
      this.tileRegistry = new Map();
      this.tileGroups = new Map(); // tile_id -> { terrain: Object3D[], vegetation: Object3D[], buildings: Object3D[] }

      this.usingFallback = {
        terrain: false,
        water: false,
        vegetation: false,
        landmarks: false,
        roads: false,
      };

      this._initRingTileRegistry();
      this._buildExpansionGrid();
    }

    /**
     * Khởi tạo danh sách ô Tile cho RING_0 (3x3), RING_1 (7x7) và các ô trọng điểm RING_2
     */
    _initRingTileRegistry() {
      for (let ix = -3; ix <= 3; ix++) {
        for (let iy = -3; iy <= 3; iy++) {
          const tileId = DALAT_COORDS.formatTileId(ix, iy);
          this._ensureTileRecord(tileId);
        }
      }
      // Một số ô trọng điểm RING_2 (Langbiang, Suối Vàng, Cầu Đất)
      [
        'T_E00_N00', 'T_E00_N01', 'T_E00_N02', 'T_E00_N03', 'T_E00_N04', 'T_E00_N05', 'T_E00_N06', 'T_E00_N07', 'T_E00_S01', 'T_E00_S02', 'T_E00_S03', 'T_E00_S04', 'T_E00_S05', 'T_E00_S06', 'T_E00_S07', 'T_E01_N00', 'T_E01_N01', 'T_E01_N02', 'T_E01_N03', 'T_E01_N04', 'T_E01_N05', 'T_E01_N06', 'T_E01_S01', 'T_E01_S02', 'T_E01_S03', 'T_E01_S04', 'T_E01_S05', 'T_E01_S06', 'T_E01_S07', 'T_E02_N00', 'T_E02_N01', 'T_E02_N02', 'T_E02_N03', 'T_E02_N04', 'T_E02_N05', 'T_E02_N06', 'T_E02_S01', 'T_E02_S02', 'T_E02_S03', 'T_E02_S05', 'T_E02_S06', 'T_E02_S07', 'T_E03_N00', 'T_E03_N01', 'T_E03_N02', 'T_E03_N03', 'T_E03_N04', 'T_E03_N05', 'T_E03_S01', 'T_E03_S02', 'T_E03_S03', 'T_E03_S06', 'T_E03_S07', 'T_E04_N00', 'T_E04_N01', 'T_E04_N04', 'T_E04_N05', 'T_E04_S01', 'T_E04_S02', 'T_E04_S03', 'T_E04_S07', 'T_E05_N04', 'T_E05_N05', 'T_E05_S01', 'T_E05_S02', 'T_E05_S03', 'T_E05_S04', 'T_E05_S07', 'T_E06_N04', 'T_E06_N05', 'T_E06_S02', 'T_E06_S03', 'T_E06_S04', 'T_E06_S07', 'T_E07_N05', 'T_E07_S03', 'T_E07_S04', 'T_E07_S05', 'T_E08_N05', 'T_E08_S02', 'T_E08_S03', 'T_E08_S04', 'T_E08_S05', 'T_E09_S01', 'T_E09_S02', 'T_E09_S03', 'T_E09_S04', 'T_E09_S05', 'T_E10_S01', 'T_E10_S02', 'T_E10_S03', 'T_E10_S04', 'T_E10_S05', 'T_E11_S05', 'T_W01_N00', 'T_W01_N01', 'T_W01_N02', 'T_W01_N03', 'T_W01_N04', 'T_W01_N05', 'T_W01_N06', 'T_W01_S01', 'T_W01_S02', 'T_W01_S03', 'T_W01_S04', 'T_W01_S05', 'T_W01_S06', 'T_W01_S07', 'T_W02_N00', 'T_W02_N01', 'T_W02_N02', 'T_W02_N03', 'T_W02_N04', 'T_W02_N05', 'T_W02_N06', 'T_W02_S01', 'T_W02_S02', 'T_W02_S03', 'T_W02_S05', 'T_W02_S06', 'T_W02_S07', 'T_W03_N00', 'T_W03_N01', 'T_W03_N02', 'T_W03_N03', 'T_W03_N04', 'T_W03_N05', 'T_W03_N06', 'T_W03_N07', 'T_W03_S01', 'T_W03_S02', 'T_W03_S03', 'T_W03_S07', 'T_W04_N03', 'T_W04_N04', 'T_W04_N05', 'T_W04_N06', 'T_W04_N07', 'T_W04_S01', 'T_W04_S07', 'T_W05_N04', 'T_W05_N05', 'T_W05_N06', 'T_W05_N07', 'T_W05_S01', 'T_W05_S02', 'T_W06_N04', 'T_W06_N05', 'T_W06_N06', 'T_W06_N07', 'T_W06_S02', 'T_W06_S03', 'T_W07_N00', 'T_W07_N04', 'T_W07_N05', 'T_W07_N06', 'T_W07_N07', 'T_W07_S02', 'T_W07_S03', 'T_W08_N00', 'T_W08_N01', 'T_W08_N06', 'T_W08_S01', 'T_W08_S02', 'T_W08_S03', 'T_W08_S04'
      ].forEach((tid) => this._ensureTileRecord(tid));
    }

    _ensureTileRecord(tileId) {
      if (!tileId) return null;
      if (this.tileRegistry.has(tileId)) return this.tileRegistry.get(tileId);
      const { ix, iy, x_m, y_m } = DALAT_COORDS.tileCenterLocal(tileId);
      const ring = DALAT_COORDS.ringForTile(ix, iy);
      const rec = {
        tile_id: tileId,
        ix,
        iy,
        ring,
        center_x: x_m,
        center_y: y_m,
        has_terrain: false,
        has_water: false,
        has_vegetation: false,
        has_landmarks: false,
        has_buildings: false,
        has_any_real_data: false,
        is_fallback_active: tileId === 'T_E00_N00',
        current_lod: ring === 0 ? 'LOD0' : 'LOD2',
        distance_m: Math.hypot(x_m, y_m),
        terrain_item: null,
        vegetation_item: null,
        building_item: null,
      };
      this.tileRegistry.set(tileId, rec);
      return rec;
    }

    _ensureTileGroupBucket(tileId) {
      if (!this.tileGroups.has(tileId)) {
        this.tileGroups.set(tileId, {
          terrain: [],
          water: [],
          vegetation: [],
          landmarks: [],
          roads: [],
          buildings: [],
        });
      }
      return this.tileGroups.get(tileId);
    }

    setLayerVisible(layerName, visible) {
      if (this.layers[layerName]) {
        this.layers[layerName].visible = Boolean(visible);
        this.rebuildPickableList();
        if (typeof this.onStreamBatchSettled === 'function') {
          this.onStreamBatchSettled();
        }
      }
    }

    setWaterEnhancer(fn) {
      this.waterEnhancer = typeof fn === 'function' ? fn : null;
      if (this.waterEnhancer) {
        for (const mat of this.waterMaterials) {
          this.waterEnhancer(mat);
        }
      }
    }

    setTerrainEnhancer(fn) {
      this.terrainEnhancer = typeof fn === 'function' ? fn : null;
      if (this.terrainEnhancer) {
        for (const mat of this.terrainMaterials) {
          this.terrainEnhancer(mat);
        }
      }
    }

    setQualityProfile(cfg) {
      if (!cfg) return;
      this.lodScale = Number(cfg.lodScale || 1.0);
      this._maxConcurrentStreams = Number(cfg.maxConcurrentStreams || 4);
      const enableVegShadows = Boolean(cfg.shadows && cfg.id !== 'fast');
      for (const rec of this.vegShadowMeshes) {
        if (!rec || !rec.mesh) continue;
        rec.mesh.castShadow = enableVegShadows && (cfg.id === 'ultra' || rec.isCoreTile);
      }
      this._drainStreamQueue();
    }

    /**
     * Khử toàn bộ transmission > 0, nâng cấp vật liệu màu solid sang PBR dùng chung + bù UV chuẩn mét
     * và đóng băng ma trận tĩnh để tối ưu FPS
     */
    sanitizeLoadedObject(root, isWaterLayer, landmarkMeta, allowCastShadow = true, isTerrainLayer = false) {
      root.traverse((obj) => {
        if (!obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          if (!mat) return;
          if (typeof mat.transmission === 'number' && mat.transmission > 0) {
            mat.transmission = 0;
            mat.transparent = true;
            mat.opacity = Math.min(mat.opacity || 0.88, 0.88);
          }
        });
      });

      if (this.pbrLibrary) {
        this.pbrLibrary.upgradeObjectHierarchy(root, Boolean(isWaterLayer));
      }

      root.traverse((obj) => {
        if (!obj.isMesh) return;
        const objName = String(obj.name || '').toLowerCase();
        const isActualWaterMesh =
          isWaterLayer && !/embankment|promenade|coping|bank|spillway|bridge|parapet|verge/.test(objName);
        obj.castShadow = Boolean(allowCastShadow && !isActualWaterMesh);
        obj.receiveShadow = true;
        if (landmarkMeta) {
          obj.userData = obj.userData || {};
          obj.userData.landmarkId = landmarkMeta.id;
          obj.userData.landmarkMeta = landmarkMeta;
        }

        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          if (!mat) return;
          const mName = String(mat.name || '').toLowerCase();
          const isMatWater =
            isActualWaterMesh && !/embankment|promenade|stone|granite|grass|verge|spillway|concrete/.test(mName);
          if (isMatWater) {
            mat.transparent = true;
            mat.opacity = 0.9;
            mat.roughness = 0.14;
            mat.metalness = 0.32;
            if (!this.waterMaterials.includes(mat)) {
              this.waterMaterials.push(mat);
            }
            if (this.waterEnhancer) {
              this.waterEnhancer(mat);
            }
          } else if (isTerrainLayer && mat.map) {
            if (!this.terrainMaterials.includes(mat)) {
              this.terrainMaterials.push(mat);
            }
            if (this.terrainEnhancer) {
              this.terrainEnhancer(mat);
            }
          }
          if (mat.emissive && (mat.emissive.r > 0 || mat.emissive.g > 0 || mat.emissive.b > 0)) {
            this.registerEmissiveMaterial(mat, mat.emissiveIntensity || 1.0);
          }
          mat.needsUpdate = true;
        });

        if (!isActualWaterMesh && obj !== root) {
          obj.updateMatrix();
          obj.matrixAutoUpdate = false;
        }
      });
    }

    registerEmissiveMaterial(mat, baseIntensity) {
      if (!mat) return;
      mat.userData = mat.userData || {};
      if (mat.userData.baseEmissiveIntensity == null) {
        mat.userData.baseEmissiveIntensity = baseIntensity;
        this.emissiveMaterials.push(mat);
      }
    }

    applyEmissiveScale(scale) {
      for (const mat of this.emissiveMaterials) {
        const base = (mat.userData && mat.userData.baseEmissiveIntensity) || 1.0;
        mat.emissiveIntensity = base * scale;
      }
    }

    rebuildPickableList() {
      this.terrainPickMeshes = [];
      this.pickableMeshes = [];
      this.landmarkMeshes = [];
      ['terrain', 'water', 'landmarks', 'roads', 'buildings'].forEach((k) => {
        const grp = this.layers[k];
        if (!grp || !grp.visible) return;
        grp.traverse((obj) => {
          if (obj.isMesh && obj.visible) {
            this.pickableMeshes.push(obj);
            if (k === 'terrain' || k === 'water') {
              this.terrainPickMeshes.push(obj);
            }
            if (k === 'landmarks' || (obj.userData && obj.userData.landmarkId)) {
              this.landmarkMeshes.push(obj);
            }
          }
        });
      });
    }

    /**
     * Raycast chọn công trình nổi bật để bật Popup Thông Tin Kiến Trúc
     */
    pickLandmark(raycaster) {
      if (!this.layers.landmarks.visible || this.landmarkMeshes.length === 0) return null;
      const hits = raycaster.intersectObjects(this.landmarkMeshes, true);
      for (const h of hits) {
        let cur = h.object;
        while (cur) {
          if (cur.userData && (cur.userData.landmarkMeta || cur.userData.landmarkId)) {
            const meta =
              cur.userData.landmarkMeta || this.landmarkCatalog[cur.userData.landmarkId];
            if (meta) {
              return {
                meta,
                point: h.point.clone(),
              };
            }
          }
          cur = cur.parent;
        }
      }
      return null;
    }

    getLandmarkList() {
      return Object.values(this.landmarkCatalog);
    }

    async _loadLandmarksManifest() {
      const manifestSpecs = [
        { url: './assets/landmarks/landmarks_manifest.json', key: 'landmarks', isVilla: false },
        { url: './assets/hero_landmarks_ultra/hero_landmarks_manifest.json', key: 'landmarks_ultra', isVilla: false },
        { url: './assets/french_villas/french_villas_manifest.json', key: 'villas', isVilla: true },
        { url: './assets/tourism_complexes/tourism_complexes_manifest.json', key: 'complexes', isVilla: false },
      ];
      await Promise.allSettled(
        manifestSpecs.map(async (spec) => {
          try {
            const resp = await fetch(spec.url, { cache: 'no-cache' });
            if (!resp.ok) return;
            const data = await resp.json();
            const list = data && Array.isArray(data[spec.key]) ? data[spec.key] : [];
            for (const lm of list) {
              if (!lm || !lm.id) continue;
              const merged = Object.assign(
                {},
                this.landmarkCatalog[lm.id] || {},
                lm,
                { is_french_villa: spec.isVilla }
              );
              this.landmarkCatalog[lm.id] = merged;
              if (lm.tile_id) {
                const rec = this._ensureTileRecord(lm.tile_id);
                if (rec) {
                  rec.has_landmarks = true;
                  rec.has_any_real_data = true;
                }
              }
            }
          } catch (_) {
            /* tiếp tục nạp các manifest khác */
          }
        })
      );
    }

    _enqueueStreamTask(url, priority, fn) {
      if (!url || this.loadedUrls.has(url) || this.queuedUrls.has(url)) {
        return Promise.resolve();
      }
      this.queuedUrls.add(url);
      return new Promise((resolve) => {
        this._streamQueue.push({ url, priority, fn, resolve });
        this._streamQueue.sort((a, b) => a.priority - b.priority);
        this._drainStreamQueue();
      });
    }

    _drainStreamQueue() {
      while (this._activeStreams < this._maxConcurrentStreams && this._streamQueue.length > 0) {
        const job = this._streamQueue.shift();
        this._activeStreams++;
        Promise.resolve()
          .then(() => job.fn())
          .catch(() => {})
          .finally(() => {
            this._activeStreams--;
            this._completedStreamCount++;
            if (
              this._completedStreamCount - this._lastRebuildCount >= 8 ||
              (this._streamQueue.length === 0 && this._activeStreams === 0)
            ) {
              this._lastRebuildCount = this._completedStreamCount;
              this.rebuildPickableList();
              if (typeof this.onStreamBatchSettled === 'function') {
                this.onStreamBatchSettled();
              }
            }
            job.resolve();
            const delayMs = job.priority >= 10 ? 25 : 0;
            if (delayMs > 0) {
              setTimeout(() => this._drainStreamQueue(), delayMs);
            } else {
              this._drainStreamQueue();
            }
          });
      }
    }

    _inferRegionTileId(item) {
      if (item && item.tile_id) return item.tile_id;
      const name = String((item && (item.filename || item.url || item.id)) || '').toLowerCase();
      if (/xuan_huong|ong_dao|lam_vien|hoa_binh|cho_dem|tran_quoc_toan|con_ga|cdsp|thuy_ta|palace|chien_thang|cong_vien_yersin|ul_w1|ul_w2|ul_w3|ul_w5/.test(name)) {
        return 'T_E00_N00';
      }
      if (/ring0|dinh_1|dinh_2|dinh_3|ga_da_lat|domaine|crazy_house|vuon_hoa|cam_ly|da_thien|van_kiep|phan_vien/.test(name)) {
        return 'T_E01_N00';
      }
      if (/than_tho|thai_phien|trai_mat|railway|linh_phuoc|ul_w4/.test(name)) return 'T_E02_N01';
      if (/tuyen_lam|truc_lam|datanla|robin|prenn|mimosa/.test(name)) return 'T_E00_S02';
      if (/langbiang|lac_duong|klong_klanh|da_sar|jraibian|lieng_ai|bnor/.test(name)) return 'T_E00_N05';
      if (/suoi_vang|dankia|ankroet|cu_lan|da_phu|tuyet_tinh_coc/.test(name)) return 'T_W04_N04';
      if (/ta_nung|me_linh|nam_ban|dong_thanh|linh_an|thac_voi|phuc_tho|lam_ha/.test(name)) return 'T_W03_S02';
      if (/cau_dat|xuan_tho|xuan_truong|dran|ngoan_muc|don_duong|da_nhim|da_ron|ka_do|proh|bong_lai|ul_w6/.test(name)) return 'T_E05_S01';
      if (/lien_khuong|pongour|gougah|duc_trong|bao_dai/.test(name)) return 'T_E00_S06';
      if (/ring1/.test(name)) return 'T_E02_N00';
      if (/ring2/.test(name)) return 'T_E04_N00';
      return 'T_E01_N00';
    }

    _queueOrDeferTileTask(tileId, url, basePriority, fn) {
      if (!url || this.loadedUrls.has(url) || this.queuedUrls.has(url)) return null;
      const tid = tileId || 'T_E00_N00';
      const rec = this._ensureTileRecord(tid);
      const isCoreOnly = tid === 'T_E00_N00';
      if (isCoreOnly) {
        return this._enqueueStreamTask(url, basePriority, fn);
      }
      if (rec) {
        if (!rec.pendingLoads) rec.pendingLoads = [];
        rec.pendingLoads.push({ url, basePriority, fn });
      }
      return null;
    }

    async refreshWorldIndex() {
      await this._loadLandmarksManifest();

      let index = null;
      try {
        const resp = await fetch('./api/world-index.json', { cache: 'no-cache' });
        if (resp.ok) {
          index = await resp.json();
        }
      } catch (err) {
        console.warn('[TileStreamer] Không gọi được ./api/world-index.json, chuyển sang Fallback:', err);
      }
      this.worldIndex = index;

      const layers = (index && index.layers) || {};
      const corePromises = [];

      // Cập nhật trạng thái Tile vào tileRegistry cho Minimap Radar
      if (Array.isArray(layers.terrain)) {
        for (const item of layers.terrain) {
          if (item.tile_id) {
            const rec = this._ensureTileRecord(item.tile_id);
            rec.has_terrain = true;
            rec.has_any_real_data = true;
            rec.terrain_item = item;
          }
        }
      }
      if (Array.isArray(layers.vegetation_instances)) {
        for (const item of layers.vegetation_instances) {
          if (item.tile_id) {
            const rec = this._ensureTileRecord(item.tile_id);
            rec.has_vegetation = true;
            rec.has_any_real_data = true;
            rec.vegetation_item = item;
          }
        }
      }
      if (Array.isArray(layers.buildings)) {
        for (const item of layers.buildings) {
          if (item.tile_id) {
            const rec = this._ensureTileRecord(item.tile_id);
            rec.has_buildings = true;
            rec.has_any_real_data = true;
            rec.building_item = item;
          }
        }
      }
      if (Array.isArray(layers.water) && layers.water.length > 0) {
        const coreRec = this._ensureTileRecord('T_E00_N00');
        coreRec.has_water = true;
        coreRec.has_any_real_data = true;
      }

      // 1. Địa hình — nền đại cảnh Copernicus 60km (Priority 0) & lõi T_E00_N00 (Priority 1) trước
      if (layers.terrain && layers.terrain.length > 0) {
        this.usingFallback.terrain = false;
        this._clearFallbackTag(this.layers.terrain);
        for (const item of layers.terrain) {
          if (item.is_backdrop || /backdrop/i.test(item.filename || '')) {
            corePromises.push(
              this._enqueueStreamTask(item.url, 0, () =>
                this._loadGlbIntoLayer(item.url, 'terrain', false, 'T_E00_N00', { isBackdrop: true })
              )
            );
            continue;
          }
          const p = this._queueOrDeferTileTask(item.tile_id, item.url, 1, () =>
            this._loadGlbIntoLayer(item.url, 'terrain', false, item.tile_id)
          );
          if (p) corePromises.push(p);
        }
      } else if (!this.usingFallback.terrain) {
        this._buildProceduralTerrain();
        this.usingFallback.terrain = true;
      }

      // 2. Hồ nước OSM chuẩn — nạp Hồ Xuân Hương & các hồ nội đô RING_0 trước
      if (layers.water && layers.water.length > 0) {
        this.usingFallback.water = false;
        this._clearFallbackTag(this.layers.water);
        for (const item of layers.water) {
          const tid = item.tile_id || this._inferRegionTileId(item);
          const isCoreWater = /xuan_huong|ring0_osm_lakes/i.test(item.filename || item.url || '');
          if (isCoreWater) {
            corePromises.push(
              this._enqueueStreamTask(item.url, 2, () =>
                this._loadGlbIntoLayer(item.url, 'water', true, 'T_E00_N00')
              )
            );
          } else {
            this._queueOrDeferTileTask(tid, item.url, 14, () =>
              this._loadGlbIntoLayer(item.url, 'water', true, tid)
            );
          }
        }
      } else if (!this.usingFallback.water) {
        this._buildProceduralWater();
        this.usingFallback.water = true;
      }

      // 3. Rừng thông & Mai Anh Đào (đã lọc va chạm mặt hồ, lòng đường & nhà dân)
      if (layers.vegetation_instances && layers.vegetation_instances.length > 0) {
        this.usingFallback.vegetation = false;
        this._clearFallbackTag(this.layers.vegetation);
        for (const item of layers.vegetation_instances) {
          const p = this._queueOrDeferTileTask(item.tile_id, item.url, 6, () =>
            this._loadVegetationInstancesJson(item.url, item.tile_id)
          );
          if (p) corePromises.push(p);
        }
      } else if (!this.usingFallback.vegetation) {
        this._buildProceduralPineAndBlossom();
        this.usingFallback.vegetation = true;
      }

      // 4. Công trình nổi bật & Biệt thự Pháp — stream theo đúng tile_id thực tế (KHÔNG gom về giữa hồ)
      if (layers.landmarks && layers.landmarks.length > 0) {
        this.usingFallback.landmarks = false;
        this._clearFallbackTag(this.layers.landmarks);
        const loadedIds = new Set();
        for (const item of layers.landmarks) {
          loadedIds.add(item.id);
          if (item.id && item.id.startsWith('ultra_')) {
            loadedIds.add(item.id.replace(/^ultra_/, ''));
          }
          const catMeta = this.landmarkCatalog[item.id];
          if (catMeta && catMeta.replaces_slot4_id) {
            loadedIds.add(catMeta.replaces_slot4_id);
          }
          const tid = item.tile_id || (catMeta && catMeta.tile_id) || this._inferRegionTileId(item);
          if (tid === 'T_E00_N00') {
            const pri = item.is_french_villa ? 7 : 4;
            const p = this._enqueueStreamTask(item.url, pri, () => this._loadLandmarkGlb(item));
            if (!item.is_french_villa) corePromises.push(p);
          } else {
            this._queueOrDeferTileTask(tid, item.url, item.is_french_villa ? 16 : 12, () =>
              this._loadLandmarkGlb(item)
            );
          }
        }
        // Chỉ dựng fallback cho công trình lõi nếu thực sự chưa có cả bản thường lẫn bản ultra
        if (layers.landmarks.length < 6) {
          this._buildRemainingFallbackLandmarks(Array.from(loadedIds));
        }
      } else if (!this.usingFallback.landmarks) {
        this._buildProceduralLandmarks();
        this.usingFallback.landmarks = true;
      }

      // 5. Đường bộ OpenStreetMap thật theo từng ô Tile — ưu tiên T_E00_N00 ngay lập tức (Priority 2)
      if (layers.roads && layers.roads.length > 0) {
        this.usingFallback.roads = false;
        this._clearFallbackTag(this.layers.roads);
        for (const item of layers.roads) {
          const tid = item.tile_id || this._inferRegionTileId(item);
          if (tid === 'T_E00_N00') {
            corePromises.push(
              this._enqueueStreamTask(item.url, 2, () =>
                this._loadGlbIntoLayer(item.url, 'roads', false, 'T_E00_N00')
              )
            );
          } else {
            this._queueOrDeferTileTask(tid, item.url, 8, () =>
              this._loadGlbIntoLayer(item.url, 'roads', false, tid)
            );
          }
        }
      } else if (!this.usingFallback.roads) {
        this._buildProceduralLakesideRoad();
        this.usingFallback.roads = true;
      }

      // 6. Nhà dân OSM thật bám DEM — ưu tiên T_E00_N00 (Priority 3)
      if (layers.buildings && layers.buildings.length > 0) {
        for (const item of layers.buildings) {
          const p = this._queueOrDeferTileTask(item.tile_id, item.url, 3, () =>
            this._loadGlbIntoLayer(item.url, 'buildings', false, item.tile_id)
          );
          if (p) corePromises.push(p);
        }
      }

      await Promise.allSettled(corePromises);
      this.rebuildPickableList();
      return index;
    }

    /**
     * Nạp/gỡ và bật/tắt mức độ chi tiết (LOD0..LOD2 / CULLED) theo khoảng cách từ Camera tới tâm mỗi ô Tile
     */
    updateCameraLod(cameraPosGltf) {
      if (!cameraPosGltf) return;
      const camX = cameraPosGltf.x;
      const camYNorth = -cameraPosGltf.z;
      const scale = this.lodScale || 1.0;
      const lod0Max = LOD_CONFIG.LOD0_MAX_M * scale;
      const lod1Max = LOD_CONFIG.LOD1_MAX_M * scale;
      const lod2Max = LOD_CONFIG.LOD2_MAX_M * scale;
      let anyLodChanged = false;

      for (const [tileId, rec] of this.tileRegistry.entries()) {
        const dist = Math.hypot(camX - rec.center_x, camYNorth - rec.center_y);
        rec.distance_m = dist;

        // Nạp động các Tile trong vùng LOD0..LOD1 khi camera di chuyển/bay tour tới gần
        if (
          dist <= lod1Max &&
          Array.isArray(rec.pendingLoads) &&
          rec.pendingLoads.length > 0
        ) {
          const tasks = rec.pendingLoads.splice(0, rec.pendingLoads.length);
          const distBucket = 10 + Math.round(dist / 500);
          for (const t of tasks) {
            this._enqueueStreamTask(t.url, t.basePriority + distBucket, t.fn);
          }
        }

        // Xác định mức LOD với độ trễ hysteresis
        let nextLod = rec.current_lod;
        const h = LOD_CONFIG.UNLOAD_HYSTERESIS_M;
        if (dist <= lod0Max) {
          nextLod = 'LOD0';
        } else if (dist <= lod1Max) {
          if (rec.current_lod === 'LOD0' && dist < lod0Max + h * 0.4) {
            nextLod = 'LOD0';
          } else {
            nextLod = 'LOD1';
          }
        } else if (dist <= lod2Max) {
          if (rec.current_lod === 'LOD1' && dist < lod1Max + h * 0.5) {
            nextLod = 'LOD1';
          } else {
            nextLod = 'LOD2';
          }
        } else if (dist > lod2Max + h) {
          nextLod = 'CULLED';
        }

        if (nextLod !== rec.current_lod) {
          rec.current_lod = nextLod;
          this._applyTileLodVisibility(tileId, nextLod);
          anyLodChanged = true;
        }
      }

      if (anyLodChanged && typeof this.onStreamBatchSettled === 'function') {
        this.onStreamBatchSettled();
      }
    }

    _applyTileLodVisibility(tileId, lodState) {
      const bucket = this.tileGroups.get(tileId);
      if (!bucket) return;

      const isCore = tileId === 'T_E00_N00';
      const showTerrain = isCore || lodState !== 'CULLED';
      const showVeg = isCore || lodState === 'LOD0';
      const showBuildings = isCore || lodState === 'LOD0' || lodState === 'LOD1';
      const showRoads = isCore || lodState === 'LOD0' || lodState === 'LOD1';

      for (const obj of bucket.terrain) {
        obj.visible = Boolean((obj.userData && obj.userData.isBackdrop) || showTerrain);
      }
      for (const obj of bucket.water) obj.visible = showTerrain;
      for (const obj of bucket.landmarks) obj.visible = showTerrain;
      for (const obj of bucket.roads) obj.visible = showRoads;
      for (const obj of bucket.vegetation) {
        if (obj.userData && obj.userData.isLowShrub) {
          obj.visible = lodState === 'LOD0';
        } else {
          obj.visible = showVeg;
        }
      }
      for (const obj of bucket.buildings) obj.visible = showBuildings;
    }

    /**
     * Trả về danh sách trạng thái các ô Tile cho Minimap Radar HUD
     */
    getTileStatusSnapshot() {
      return Array.from(this.tileRegistry.values());
    }

    _clearFallbackTag(group) {
      const toRemove = group.children.filter((c) => c.userData && c.userData.isFallback);
      for (const obj of toRemove) {
        group.remove(obj);
      }
    }

    _loadGlbIntoLayer(url, layerName, isWater, tileId, opts) {
      if (!this.loader || this.loadedUrls.has(url)) return Promise.resolve();
      this.loadedUrls.add(url);
      const allowCastShadow = layerName === 'landmarks';
      const isBackdrop = Boolean(opts && opts.isBackdrop);
      return new Promise((resolve) => {
        this.loader.load(
          url,
          (gltf) => {
            const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
            if (root) {
              if (isBackdrop) {
                root.userData = root.userData || {};
                root.userData.isBackdrop = true;
              }
              this.sanitizeLoadedObject(root, isWater, null, allowCastShadow, layerName === 'terrain');
              this.layers[layerName].add(root);
              if (tileId) {
                const bucket = this._ensureTileGroupBucket(tileId);
                if (bucket[layerName]) bucket[layerName].push(root);
                const rec = this.tileRegistry.get(tileId);
                if (rec) this._applyTileLodVisibility(tileId, rec.current_lod);
              }
            }
            resolve();
          },
          undefined,
          (err) => {
            console.warn(`[TileStreamer] Lỗi nạp ${url}:`, err);
            this.loadedUrls.delete(url);
            resolve();
          }
        );
      });
    }

    /**
     * Nạp mô hình công trình nổi bật / biệt thự Pháp / quần thể du lịch,
     * tự động đặt đúng gltf_position & chặn tuyệt đối mọi mô hình không có tọa độ rơi vào giữa Hồ Xuân Hương
     */
    _loadLandmarkGlb(item) {
      const url = item.url;
      if (!this.loader || this.loadedUrls.has(url)) return Promise.resolve();
      this.loadedUrls.add(url);
      const lmId = item.id;
      const catMeta = this.landmarkCatalog[lmId] || {};
      const meta = Object.assign(
        {
          id: lmId,
          name_vi: item.name_vi || lmId,
          tile_id: item.tile_id || 'T_E00_N00',
        },
        catMeta,
        item.gltf_position ? { gltf_position: item.gltf_position } : {},
        typeof item.rotation_y_rad === 'number' ? { rotation_y_rad: item.rotation_y_rad } : {},
        item.name_vi ? { name_vi: item.name_vi } : {},
        item.is_french_villa != null ? { is_french_villa: item.is_french_villa } : {}
      );

      return new Promise((resolve) => {
        this.loader.load(
          url,
          (gltf) => {
            const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
            if (root) {
              const box = new THREE.Box3().setFromObject(root);
              const center = new THREE.Vector3();
              const size = new THREE.Vector3();
              box.getCenter(center);
              box.getSize(size);
              const isLocalOriginMesh =
                Math.hypot(center.x, center.z) < 160.0 && Math.max(size.x, size.z) < 450.0;

              if (isLocalOriginMesh) {
                if (
                  Array.isArray(meta.gltf_position) &&
                  meta.gltf_position.length === 3 &&
                  Math.hypot(meta.gltf_position[0], meta.gltf_position[2]) > 35.0
                ) {
                  root.position.fromArray(meta.gltf_position);
                  if (typeof meta.rotation_y_rad === 'number') {
                    root.rotation.y = meta.rotation_y_rad;
                  }
                } else {
                  console.warn(
                    `[TileStreamer] Bỏ qua ${lmId} vì có pivot tại (0,0,0) nhưng thiếu gltf_position hợp lệ (chống chồng giữa Hồ Xuân Hương).`
                  );
                  resolve();
                  return;
                }
              }

              root.userData = root.userData || {};
              root.userData.landmarkId = meta.id;
              root.userData.landmarkMeta = Object.assign({}, meta, { isRealGlb: true });
              this.sanitizeLoadedObject(root, false, root.userData.landmarkMeta);

              // Gắn nhãn tên 3D chỉ cho công trình biểu tượng đơn lẻ (không gắn lên 102 biệt thự hoặc cụm đa điểm rộng > 400m)
              const cleanTitle = String(meta.name_vi || '')
                .split('(')[0]
                .replace(/\s*Ultra-LOD\d+\s*/gi, ' ')
                .replace(/\s*LOD\d+\s*/gi, ' ')
                .replace(/\s*\/\s*.*$/, '')
                .replace(/\s+/g, ' ')
                .trim();
              const isMultiSiteSpan = Math.max(size.x, size.z) > 400;
              if (!meta.is_french_villa && !isMultiSiteSpan && cleanTitle && !cleanTitle.includes('_')) {
                const topY = (box.max.y || 24) + 10;
                const lx = isLocalOriginMesh ? 0 : center.x - root.position.x;
                const lz = isLocalOriginMesh ? 0 : center.z - root.position.z;
                const ly = Math.max(14, isLocalOriginMesh ? topY : topY - root.position.y);
                const label = this._createLabelSprite(cleanTitle, lx, ly, lz);
                root.add(label);
              }

              this.layers.landmarks.add(root);
              const tid = meta.tile_id || this._inferRegionTileId(item);
              if (tid) {
                const bucket = this._ensureTileGroupBucket(tid);
                bucket.landmarks.push(root);
                const rec = this.tileRegistry.get(tid);
                if (rec) this._applyTileLodVisibility(tid, rec.current_lod);
              }
            }
            resolve();
          },
          undefined,
          (err) => {
            console.warn(`[TileStreamer] Lỗi nạp landmark ${url}:`, err);
            this.loadedUrls.delete(url);
            resolve();
          }
        );
      });
    }

    /**
     * Nạp dữ liệu rải rừng thông & Mai Anh Đào instances_<TILE_ID>.json từ Slot 3
     * Hỗ trợ cả định dạng mảng 6 phần tử [x_m, y_m, z_local, scale, rot_rad, species_idx]
     * lẫn định dạng danh sách object
     */
    async _loadVegetationInstancesJson(url, tileId) {
      if (this.loadedUrls.has(url)) return;
      this.loadedUrls.add(url);
      try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const data = await resp.json();
        const rawItems = Array.isArray(data) ? data : data.instances || data.trees || [];
        if (rawItems.length === 0) return;

        const legend = Array.isArray(data.species_legend)
          ? data.species_legend
          : ['pine_dalat_tall', 'pine_dalat_medium', 'pine_dalat_young', 'mai_anh_dao', 'da_quy_bush'];

        const pines = [];
        const blossoms = [];
        const daQuyBushes = [];

        for (const it of rawItems) {
          let rec;
          let speciesName = 'pine_dalat_medium';
          if (Array.isArray(it)) {
            // [x_m, y_m, z_local, scale, rot_rad, species_idx]
            const spIdx = Number(it[5] ?? 1);
            speciesName = String(legend[spIdx] || 'pine_dalat_medium').toLowerCase();
            let scaleMult = Number(it[3] ?? 1.0);
            if (speciesName.includes('tall')) scaleMult *= 1.22;
            else if (speciesName.includes('young')) scaleMult *= 0.62;
            rec = {
              x: Number(it[0]),
              y: Number(it[1]),
              z_local: Number(it[2]),
              scale: scaleMult,
              rot: Number(it[4] ?? 0),
            };
          } else {
            speciesName = String(it.species || it.type || 'pine').toLowerCase();
            rec = it;
          }

          if (speciesName.includes('mai') || speciesName.includes('blossom') || speciesName.includes('cherry')) {
            blossoms.push(rec);
          } else if (speciesName.includes('da_quy') || speciesName.includes('bush')) {
            daQuyBushes.push(rec);
          } else {
            pines.push(rec);
          }
        }

        const effectiveTileId = tileId || data.tile_id || 'T_E00_N00';
        if (pines.length > 0) this._createPineInstancedMesh(pines, false, effectiveTileId);
        if (blossoms.length > 0) this._createBlossomInstancedMesh(blossoms, false, effectiveTileId);
        if (daQuyBushes.length > 0) this._createDaQuyInstancedMesh(daQuyBushes, false, effectiveTileId);
      } catch (err) {
        console.warn(`[TileStreamer] Lỗi nạp instances JSON ${url}:`, err);
        this.loadedUrls.delete(url);
      }
    }

    /* ========================================================================
     * FALLBACK PROCEDURAL ĐÀ LẠT & INSTANCED MESH BUILDERS
     * ======================================================================== */

    _buildProceduralTerrain() {
      const group = new THREE.Group();
      group.userData.isFallback = true;

      const coreMesh = this._createTerrainPatch(2000, 120, 0, 0);
      group.add(coreMesh);

      const outerMesh = this._createTerrainPatch(6000, 96, 0, 0, true);
      group.add(outerMesh);

      this.layers.terrain.add(group);
    }

    _createTerrainPatch(sizeM, segs, centerX, centerY, isOuterSkirt) {
      const geo = new THREE.PlaneGeometry(sizeM, sizeM, segs, segs);
      geo.rotateX(-Math.PI / 2);

      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();

      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + centerX;
        const zGltf = pos.getZ(i) - centerY;
        const yNorth = -zGltf;

        let zLocal = DALAT_COORDS.syntheticLocalY(x, yNorth);
        const lakeRatio = DALAT_COORDS.lakeMinRatio(x, yNorth);
        if (lakeRatio <= 0.9) {
          zLocal = -2.2;
        }
        if (isOuterSkirt && Math.abs(x) < 980 && Math.abs(yNorth) < 980) {
          zLocal -= 1.2;
        }
        pos.setXYZ(i, x, zLocal, zGltf);

        if (lakeRatio <= 0.92) {
          c.setHex(0x284e57);
        } else if (zLocal < 4.5) {
          c.setHex(0x6d9c58);
        } else if (zLocal < 24.0) {
          c.setHex(0x527d46);
        } else if (zLocal < 55.0) {
          c.setHex(0x3f6939);
        } else {
          c.setHex(0x315630);
        }
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.02,
      });

      const mesh = new THREE.Mesh(geo, mat);
      if (this.pbrLibrary) {
        this.pbrLibrary.upgradeObjectHierarchy(mesh, false);
      }
      mesh.receiveShadow = true;
      mesh.name = isOuterSkirt ? 'fallback_terrain_ring0_skirt' : 'fallback_terrain_T_E00_N00';
      return mesh;
    }

    _buildProceduralWater() {
      const geo = new THREE.PlaneGeometry(1650, 1150, 72, 52);
      geo.rotateX(-Math.PI / 2);

      const pos = geo.attributes.position;
      const baseY = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) - 90;
        const z = pos.getZ(i) - 240;
        pos.setXYZ(i, x, 0.0, z);
        baseY[i] = 0.0;
      }
      geo.userData.baseY = baseY;
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        name: 'water_ho_xuan_huong',
        color: 0x2b6e78,
        transparent: true,
        opacity: 0.88,
        roughness: 0.14,
        metalness: 0.32,
      });

      const waterMesh = new THREE.Mesh(geo, mat);
      if (this.pbrLibrary) {
        geo.deleteAttribute('uv');
        this.pbrLibrary.upgradeObjectHierarchy(waterMesh, true);
      }
      if (!this.waterMaterials.includes(waterMesh.material)) {
        this.waterMaterials.push(waterMesh.material);
      }
      if (this.waterEnhancer) {
        this.waterEnhancer(waterMesh.material);
      }
      waterMesh.receiveShadow = true;
      waterMesh.userData.isFallback = true;
      waterMesh.name = 'fallback_water_ho_xuan_huong';

      this.waterMeshes.push(waterMesh);
      this.layers.water.add(waterMesh);
    }

    _buildProceduralPineAndBlossom() {
      const rng = createRng(20261123);
      const pineTransforms = [];
      const blossomTransforms = [];
      const daQuyTransforms = [];

      const pineZones = [
        { cx: 80, cy: 643, r: 580, count: 320 },
        { cx: 723, cy: -547, r: 520, count: 300 },
        { cx: -840, cy: -405, r: 420, count: 160 },
        { cx: -600, cy: 520, r: 460, count: 180 },
        { cx: 980, cy: 420, r: 480, count: 180 },
      ];

      for (const z of pineZones) {
        for (let i = 0; i < z.count; i++) {
          const ang = rng() * Math.PI * 2;
          const dist = Math.sqrt(rng()) * z.r;
          const x = z.cx + Math.cos(ang) * dist;
          const yNorth = z.cy + Math.sin(ang) * dist;
          if (DALAT_COORDS.lakeMinRatio(x, yNorth) < 1.12) continue;
          const yElev = DALAT_COORDS.syntheticLocalY(x, yNorth);
          const scale = 0.72 + rng() * 0.75;
          pineTransforms.push({ x, y: yNorth, z_local: yElev, scale, rot: rng() * Math.PI * 2 });
        }
      }

      for (let i = 0; i < 420; i++) {
        const x = -850 + rng() * 1550;
        const yNorth = -260 + rng() * 1080;
        const ratio = DALAT_COORDS.lakeMinRatio(x, yNorth);
        if (ratio >= 1.06 && ratio <= 1.48) {
          const yElev = DALAT_COORDS.syntheticLocalY(x, yNorth);
          blossomTransforms.push({
            x,
            y: yNorth,
            z_local: yElev,
            scale: 0.75 + rng() * 0.5,
            rot: rng() * Math.PI * 2,
          });
        } else if (ratio > 1.48 && ratio <= 1.85 && i % 2 === 0) {
          const yElev = DALAT_COORDS.syntheticLocalY(x, yNorth);
          daQuyTransforms.push({
            x,
            y: yNorth,
            z_local: yElev,
            scale: 0.85 + rng() * 0.45,
            rot: rng() * Math.PI * 2,
          });
        }
      }

      this._createPineInstancedMesh(pineTransforms, true, 'T_E00_N00');
      this._createBlossomInstancedMesh(blossomTransforms, true, 'T_E00_N00');
      if (daQuyTransforms.length > 0) {
        this._createDaQuyInstancedMesh(daQuyTransforms, true, 'T_E00_N00');
      }
    }

    _mergeSimpleGeos(geos) {
      let totalVerts = 0;
      const nonIndexed = geos.map((g) => {
        const ng = g.index ? g.toNonIndexed() : g.clone();
        if (!ng.attributes.normal) ng.computeVertexNormals();
        totalVerts += ng.attributes.position.count;
        return ng;
      });
      const posArr = new Float32Array(totalVerts * 3);
      const nrmArr = new Float32Array(totalVerts * 3);
      const uvArr = new Float32Array(totalVerts * 2);
      let vOff = 0;
      for (const ng of nonIndexed) {
        const p = ng.attributes.position.array;
        const n = ng.attributes.normal.array;
        const u = ng.attributes.uv ? ng.attributes.uv.array : null;
        posArr.set(p, vOff * 3);
        nrmArr.set(n, vOff * 3);
        if (u) uvArr.set(u, vOff * 2);
        vOff += ng.attributes.position.count;
        ng.dispose();
      }
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(nrmArr, 3));
      out.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      out.computeBoundingSphere();
      return out;
    }

    _getSharedPineGeometries() {
      if (this._sharedPineGeos) return this._sharedPineGeos;
      const trunkGeo = new THREE.CylinderGeometry(0.28, 0.52, 8.2, 5);
      trunkGeo.translate(0, 4.1, 0);

      // Tán Thông 3 lá Đà Lạt 3 tầng tự nhiên (thay thế hoàn toàn hình nón đơn giản)
      const t1 = new THREE.ConeGeometry(4.1, 5.8, 6, 1, false);
      t1.translate(0, 8.4, 0);
      const t2 = new THREE.ConeGeometry(3.2, 5.6, 6, 1, false);
      t2.rotateY(0.52);
      t2.translate(0.15, 11.8, -0.1);
      const t3 = new THREE.ConeGeometry(2.1, 5.2, 6, 1, false);
      t3.rotateY(1.05);
      t3.translate(-0.1, 15.0, 0.08);
      const crownGeo = this._mergeSimpleGeos([t1, t2, t3]);
      t1.dispose();
      t2.dispose();
      t3.dispose();

      const scaleUv = (geo, su, sv) => {
        const uv = geo.attributes.uv;
        if (!uv) return;
        for (let i = 0; i < uv.array.length; i += 2) {
          uv.array[i] *= su;
          uv.array[i + 1] *= sv;
        }
        uv.needsUpdate = true;
        geo.userData = geo.userData || {};
        geo.userData._pbrUvReady = true;
      };
      scaleUv(trunkGeo, 2.5, 5.5);
      scaleUv(crownGeo, 5.5, 4.5);

      this._sharedPineGeos = { trunkGeo, crownGeo };
      return this._sharedPineGeos;
    }

    _getSharedBlossomGeometries() {
      if (this._sharedBlossomGeos) return this._sharedBlossomGeos;
      const trunkGeo = new THREE.CylinderGeometry(0.22, 0.42, 4.0, 5);
      trunkGeo.translate(0, 2.0, 0);

      // Tán Mai Anh Đào 3 cụm tự nhiên (nhẹ và mềm mại hơn khối cầu đơn)
      const b1 = new THREE.IcosahedronGeometry(2.4, 0);
      b1.scale(1.25, 0.72, 1.15);
      b1.translate(-0.9, 5.2, 0.4);
      const b2 = new THREE.IcosahedronGeometry(2.1, 0);
      b2.scale(1.15, 0.68, 1.2);
      b2.translate(1.1, 5.7, -0.5);
      const b3 = new THREE.IcosahedronGeometry(1.9, 0);
      b3.scale(1.1, 0.76, 1.1);
      b3.translate(0.0, 6.4, 0.2);
      const crownGeo = this._mergeSimpleGeos([b1, b2, b3]);
      b1.dispose();
      b2.dispose();
      b3.dispose();

      const pos = crownGeo.attributes.position;
      const cUv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        cUv[i * 2] = (pos.getX(i) + pos.getZ(i) * 0.6) * 0.55;
        cUv[i * 2 + 1] = (pos.getY(i) - pos.getZ(i) * 0.4) * 0.55;
      }
      crownGeo.setAttribute('uv', new THREE.BufferAttribute(cUv, 2));
      crownGeo.userData = { _pbrUvReady: true };
      trunkGeo.userData = { _pbrUvReady: true };

      this._sharedBlossomGeos = { trunkGeo, crownGeo };
      return this._sharedBlossomGeos;
    }

    _createPineInstancedMesh(items, isFallback, tileId) {
      const count = items.length;
      const { trunkGeo, crownGeo } = this._getSharedPineGeometries();
      let trunkMat = new THREE.MeshStandardMaterial({
        name: 'pine_bark',
        color: new THREE.Color(0x5c3d28).convertSRGBToLinear(),
        roughness: 0.92,
      });
      let crownMat = new THREE.MeshStandardMaterial({
        name: 'pine_canopy_mid',
        color: new THREE.Color(0x285d37).convertSRGBToLinear(),
        roughness: 0.84,
      });

      if (this.pbrLibrary) {
        trunkMat = this.pbrLibrary.upgradeMaterial(trunkMat, false).material;
        crownMat = this.pbrLibrary.upgradeMaterial(crownMat, false).material;
      }

      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMat, count);
      const isCoreTile = tileId === 'T_E00_N00';
      trunks.castShadow = false;
      crowns.castShadow = isCoreTile;
      crowns.receiveShadow = true;
      trunks.userData.isFallback = isFallback;
      crowns.userData.isFallback = isFallback;
      trunks.matrixAutoUpdate = false;
      crowns.matrixAutoUpdate = false;
      this.vegShadowMeshes.push({ mesh: crowns, isCoreTile });

      const dummy = new THREE.Object3D();
      const tint = new THREE.Color();
      items.forEach((it, idx) => {
        const x = Number(it.x ?? it.x_m ?? 0);
        const yNorth = Number(it.y ?? it.y_m ?? 0);
        const yElev =
          it.z_local != null
            ? Number(it.z_local)
            : it.elev_msl_m != null
              ? Number(it.elev_msl_m) - DALAT_COORDS.Z0_MSL
              : DALAT_COORDS.syntheticLocalY(x, yNorth);
        const s = Number(it.scale ?? 1.0);
        const sy = s * (0.92 + ((idx * 37) % 19) * 0.012);
        dummy.position.set(x, yElev - 0.6, -yNorth);
        dummy.rotation.set(0, Number(it.rot ?? 0), 0);
        dummy.scale.set(s * 0.92, sy, s * 0.92);
        dummy.updateMatrix();
        trunks.setMatrixAt(idx, dummy.matrix);
        crowns.setMatrixAt(idx, dummy.matrix);
        if (typeof crowns.setColorAt === 'function') {
          const shade = 0.78 + ((idx * 53) % 29) * 0.014;
          tint.setRGB(shade * 0.92, shade, shade * 0.88);
          crowns.setColorAt(idx, tint);
        }
      });

      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

      this.layers.vegetation.add(trunks, crowns);
      if (tileId) {
        const bucket = this._ensureTileGroupBucket(tileId);
        bucket.vegetation.push(trunks, crowns);
        const rec = this.tileRegistry.get(tileId);
        if (rec) this._applyTileLodVisibility(tileId, rec.current_lod);
      }
    }

    _createBlossomInstancedMesh(items, isFallback, tileId) {
      const count = items.length;
      const { trunkGeo, crownGeo } = this._getSharedBlossomGeometries();
      let trunkMat = new THREE.MeshStandardMaterial({
        name: 'cherry_bark',
        color: new THREE.Color(0x4f3629).convertSRGBToLinear(),
        roughness: 0.9,
      });
      let crownMat = new THREE.MeshStandardMaterial({
        name: 'cherry_blossom_foliage',
        color: new THREE.Color(0xf498b8).convertSRGBToLinear(),
        roughness: 0.74,
      });

      if (this.pbrLibrary) {
        trunkMat = this.pbrLibrary.upgradeMaterial(trunkMat, false).material;
        crownMat = this.pbrLibrary.upgradeMaterial(crownMat, false).material;
      }

      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMat, count);
      const isCoreTile = tileId === 'T_E00_N00';
      crowns.castShadow = isCoreTile;
      trunks.userData.isFallback = isFallback;
      crowns.userData.isFallback = isFallback;
      trunks.matrixAutoUpdate = false;
      crowns.matrixAutoUpdate = false;
      this.vegShadowMeshes.push({ mesh: crowns, isCoreTile });

      const dummy = new THREE.Object3D();
      const tint = new THREE.Color();
      items.forEach((it, idx) => {
        const x = Number(it.x ?? it.x_m ?? 0);
        const yNorth = Number(it.y ?? it.y_m ?? 0);
        const yElev =
          it.z_local != null
            ? Number(it.z_local)
            : DALAT_COORDS.syntheticLocalY(x, yNorth);
        const s = Number(it.scale ?? 1.0);
        dummy.position.set(x, yElev - 0.35, -yNorth);
        dummy.rotation.set(0, Number(it.rot ?? 0), 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        trunks.setMatrixAt(idx, dummy.matrix);
        crowns.setMatrixAt(idx, dummy.matrix);
        if (typeof crowns.setColorAt === 'function') {
          const shade = 0.86 + ((idx * 41) % 23) * 0.011;
          tint.setRGB(Math.min(1.0, shade * 1.05), shade * 0.94, Math.min(1.0, shade * 0.98));
          crowns.setColorAt(idx, tint);
        }
      });

      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

      this.layers.vegetation.add(trunks, crowns);
      if (tileId) {
        const bucket = this._ensureTileGroupBucket(tileId);
        bucket.vegetation.push(trunks, crowns);
        const rec = this.tileRegistry.get(tileId);
        if (rec) this._applyTileLodVisibility(tileId, rec.current_lod);
      }
    }

    _createDaQuyInstancedMesh(items, isFallback, tileId) {
      const count = items.length;
      const bushGeo = new THREE.DodecahedronGeometry(1.45, 0);
      bushGeo.scale(1.25, 0.85, 1.25);
      bushGeo.translate(0, 1.0, 0);
      let bushMat = new THREE.MeshStandardMaterial({
        name: 'da_quy_flower_foliage',
        color: 0xf59e0b,
        roughness: 0.76,
      });

      if (this.pbrLibrary) {
        bushGeo.deleteAttribute('uv');
        const bUp = this.pbrLibrary.upgradeMaterial(bushMat, false);
        bushMat = bUp.material;
        this.pbrLibrary.ensureMetricUVs(bushGeo, bUp.tileScaleM || 1.3);
      }

      const bushes = new THREE.InstancedMesh(bushGeo, bushMat, count);
      bushes.userData.isFallback = isFallback;
      bushes.userData.isLowShrub = true;
      bushes.matrixAutoUpdate = false;

      const dummy = new THREE.Object3D();
      items.forEach((it, idx) => {
        const x = Number(it.x ?? it.x_m ?? 0);
        const yNorth = Number(it.y ?? it.y_m ?? 0);
        const yElev =
          it.z_local != null
            ? Number(it.z_local)
            : DALAT_COORDS.syntheticLocalY(x, yNorth);
        const s = Number(it.scale ?? 1.0);
        dummy.position.set(x, yElev - 0.2, -yNorth);
        dummy.rotation.set(0, Number(it.rot ?? 0), 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        bushes.setMatrixAt(idx, dummy.matrix);
      });
      bushes.instanceMatrix.needsUpdate = true;
      this.layers.vegetation.add(bushes);
      if (tileId) {
        const bucket = this._ensureTileGroupBucket(tileId);
        bucket.vegetation.push(bushes);
      }
    }

    _tagLandmarkHierarchy(group, lmId) {
      const meta = this.landmarkCatalog[lmId] || { id: lmId, name_vi: lmId };
      group.userData = group.userData || {};
      group.userData.landmarkId = lmId;
      group.userData.landmarkMeta = meta;
      group.traverse((child) => {
        if (child.isMesh) {
          child.userData = child.userData || {};
          child.userData.landmarkId = lmId;
          child.userData.landmarkMeta = meta;
        }
      });
    }

    _buildProceduralLandmarks() {
      this._buildRemainingFallbackLandmarks([]);
    }

    _buildRemainingFallbackLandmarks(alreadyLoadedIds) {
      const skip = new Set(alreadyLoadedIds || []);
      const root = new THREE.Group();
      root.userData.isFallback = true;

      // 1. Quảng trường Lâm Viên
      if (!skip.has('lm_01_quang_truong_lam_vien')) {
        const qtlv = new THREE.Group();
        const qElev = DALAT_COORDS.syntheticLocalY(-79.6, -185.8);
        qtlv.position.set(-79.6, qElev, 185.8);

        const plaza = new THREE.Mesh(
          new THREE.CylinderGeometry(58, 62, 3.0, 24),
          new THREE.MeshStandardMaterial({ color: 0xd6cfc2, roughness: 0.85 })
        );
        plaza.position.y = -0.5;
        qtlv.add(plaza);

        const daQuyMat = new THREE.MeshStandardMaterial({
          color: 0xfacc15,
          emissive: 0xf59e0b,
          emissiveIntensity: 0.35,
          roughness: 0.32,
          metalness: 0.15,
        });
        this.registerEmissiveMaterial(daQuyMat, 0.95);
        const daQuy = new THREE.Mesh(new THREE.ConeGeometry(22, 19, 12), daQuyMat);
        daQuy.position.set(-20, 9.5, 8);
        daQuy.rotation.z = -0.26;
        daQuy.castShadow = true;
        qtlv.add(daQuy);

        const atisoMat = new THREE.MeshStandardMaterial({
          color: 0x10b981,
          emissive: 0x34d399,
          emissiveIntensity: 0.4,
          roughness: 0.25,
          metalness: 0.2,
        });
        this.registerEmissiveMaterial(atisoMat, 1.1);
        const atiso = new THREE.Mesh(new THREE.OctahedronGeometry(13.5, 1), atisoMat);
        atiso.scale.set(1.0, 1.45, 1.0);
        atiso.position.set(22, 16, -6);
        atiso.castShadow = true;
        qtlv.add(atiso);
        qtlv.add(this._createLabelSprite('Quảng trường Lâm Viên', 0, 38, 0));
        this._tagLandmarkHierarchy(qtlv, 'lm_01_quang_truong_lam_vien');
        root.add(qtlv);
      }

      // 2. Nhà hàng Thủy Tạ & Cầu Ông Đạo
      if (!skip.has('lm_06_thuy_ta_cau_ong_dao')) {
        const thuyTa = new THREE.Group();
        thuyTa.position.set(-600.0, 0.2, -95.8);
        const ttDeck = new THREE.Mesh(
          new THREE.CylinderGeometry(18, 19, 2.2, 16),
          new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.55 })
        );
        ttDeck.position.y = 1.6;
        const ttHall = new THREE.Mesh(
          new THREE.CylinderGeometry(12, 13, 6.0, 16),
          new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: 0xfef3c7,
            emissiveIntensity: 0.25,
            roughness: 0.4,
          })
        );
        this.registerEmissiveMaterial(ttHall.material, 0.65);
        ttHall.position.y = 5.5;
        const ttRoof = new THREE.Mesh(
          new THREE.ConeGeometry(14.5, 3.2, 16),
          new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.65 })
        );
        ttRoof.position.y = 10.0;
        thuyTa.add(ttDeck, ttHall, ttRoof, this._createLabelSprite('Thủy Tạ & Cầu Ông Đạo', 0, 22, 0));
        this._tagLandmarkHierarchy(thuyTa, 'lm_06_thuy_ta_cau_ong_dao');
        root.add(thuyTa);
      }

      // 3. Nhà Ga Đà Lạt
      if (!skip.has('lm_02_ga_da_lat')) {
        const ga = new THREE.Group();
        const gaElev = DALAT_COORDS.syntheticLocalY(1060.9, 176.0);
        ga.position.set(1060.9, gaElev, -176.0);
        const gaBody = new THREE.Mesh(
          new THREE.BoxGeometry(52, 10, 18),
          new THREE.MeshStandardMaterial({ color: 0xf5d073, roughness: 0.7 })
        );
        gaBody.position.y = 4.0;
        ga.add(gaBody);
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x9a3412, roughness: 0.65 });
        [-15, 0, 15].forEach((ox) => {
          const peak = new THREE.Mesh(new THREE.ConeGeometry(9.5, 13, 4), roofMat);
          peak.rotation.y = Math.PI / 4;
          peak.position.set(ox, 15.0, 0);
          ga.add(peak);
        });
        ga.add(this._createLabelSprite('Nhà Ga Đà Lạt', 0, 30, 0));
        this._tagLandmarkHierarchy(ga, 'lm_02_ga_da_lat');
        root.add(ga);
      }

      // 4. Trường CĐSP Đà Lạt
      if (!skip.has('lm_04_truong_cdsp_dalat')) {
        const cdsp = new THREE.Group();
        const cdspElev = DALAT_COORDS.syntheticLocalY(835.6, 659.0);
        cdsp.position.set(835.6, cdspElev, -659.0);
        const brickMat = new THREE.MeshStandardMaterial({ color: 0xb4533c, roughness: 0.8 });
        const arcGeo = new THREE.TorusGeometry(36, 5.5, 8, 20, Math.PI * 0.72);
        arcGeo.rotateX(Math.PI / 2);
        const arc = new THREE.Mesh(arcGeo, brickMat);
        arc.position.y = 5.0;
        const bellTower = new THREE.Mesh(new THREE.BoxGeometry(7, 36, 7), brickMat);
        bellTower.position.set(34, 18, -8);
        cdsp.add(arc, bellTower, this._createLabelSprite('Trường CĐSP Đà Lạt', 0, 44, 0));
        this._tagLandmarkHierarchy(cdsp, 'lm_04_truong_cdsp_dalat');
        root.add(cdsp);
      }

      // 5. Nhà thờ Con Gà
      if (!skip.has('lm_03_nha_tho_con_ga')) {
        const nt = new THREE.Group();
        const ntElev = DALAT_COORDS.syntheticLocalY(-841.8, -405.1);
        nt.position.set(-841.8, ntElev, 405.1);
        const pinkWall = new THREE.MeshStandardMaterial({ color: 0xd98a7c, roughness: 0.75 });
        const nave = new THREE.Mesh(new THREE.BoxGeometry(44, 15, 18), pinkWall);
        nave.position.y = 7.0;
        const spireBase = new THREE.Mesh(new THREE.BoxGeometry(9, 34, 9), pinkWall);
        spireBase.position.set(22, 17, 0);
        const spireTop = new THREE.Mesh(
          new THREE.ConeGeometry(5.5, 16, 4),
          new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.6 })
        );
        spireTop.rotation.y = Math.PI / 4;
        spireTop.position.set(22, 41, 0);
        nt.add(nave, spireBase, spireTop, this._createLabelSprite('Nhà thờ Con Gà', 12, 56, 0));
        this._tagLandmarkHierarchy(nt, 'lm_03_nha_tho_con_ga');
        root.add(nt);
      }

      // 6. Chợ Đà Lạt & Khu Hòa Bình
      if (!skip.has('lm_05_cho_da_lat_hoa_binh')) {
        const cho = new THREE.Group();
        const choElev = DALAT_COORDS.syntheticLocalY(-876.2, 125.9);
        cho.position.set(-876.2, choElev, -125.9);
        const marketMain = new THREE.Mesh(
          new THREE.BoxGeometry(58, 16, 36),
          new THREE.MeshStandardMaterial({
            color: 0xe5e7eb,
            emissive: 0xfde68a,
            emissiveIntensity: 0.2,
            roughness: 0.7,
          })
        );
        this.registerEmissiveMaterial(marketMain.material, 0.55);
        marketMain.position.y = 7.5;
        cho.add(marketMain, this._createLabelSprite('Chợ Đà Lạt & Hòa Bình', 0, 28, 0));
        this._tagLandmarkHierarchy(cho, 'lm_05_cho_da_lat_hoa_binh');
        root.add(cho);
      }

      if (root.children.length > 0) {
        if (this.pbrLibrary) this.pbrLibrary.upgradeObjectHierarchy(root, false);
        this.layers.landmarks.add(root);
      }
    }

    _buildProceduralLakesideRoad() {
      const roadPts = [
        [-770, 50], [-610, 195], [-380, 255], [-100, 225],
        [200, 175], [470, 310], [630, 540], [520, 820],
        [310, 770], [340, 440], [220, 150], [90, -180],
        [-190, -190], [-510, -75], [-770, 50],
      ];

      const group = new THREE.Group();
      group.userData.isFallback = true;

      const curvePts = roadPts.map(([x, yNorth]) => {
        const yElev = Math.max(0.8, DALAT_COORDS.syntheticLocalY(x, yNorth) + 0.65);
        return new THREE.Vector3(x, yElev, -yNorth);
      });
      const curve = new THREE.CatmullRomCurve3(curvePts, true);
      const tubeGeo = new THREE.TubeGeometry(curve, 140, 4.2, 5, true);
      tubeGeo.scale(1, 0.14, 1);
      let roadMat = new THREE.MeshStandardMaterial({
        name: 'road_asphalt',
        color: 0x3b4252,
        roughness: 0.88,
      });
      if (this.pbrLibrary) {
        tubeGeo.deleteAttribute('uv');
        const rUp = this.pbrLibrary.upgradeMaterial(roadMat, false);
        roadMat = rUp.material;
        this.pbrLibrary.ensureMetricUVs(tubeGeo, rUp.tileScaleM || 3.8);
      }
      const roadMesh = new THREE.Mesh(tubeGeo, roadMat);
      roadMesh.receiveShadow = true;
      group.add(roadMesh);

      const lampMat = new THREE.MeshStandardMaterial({
        color: 0xffedd5,
        emissive: 0xffb347,
        emissiveIntensity: 0.2,
        roughness: 0.3,
      });
      this.registerEmissiveMaterial(lampMat, 1.4);
      const bulbGeo = new THREE.SphereGeometry(1.15, 6, 6);
      const lampCount = 48;
      const lamps = new THREE.InstancedMesh(bulbGeo, lampMat, lampCount);
      const dummy = new THREE.Object3D();
      for (let i = 0; i < lampCount; i++) {
        const pt = curve.getPointAt(i / lampCount);
        dummy.position.set(pt.x, pt.y + 7.5, pt.z);
        dummy.updateMatrix();
        lamps.setMatrixAt(i, dummy.matrix);
      }
      lamps.instanceMatrix.needsUpdate = true;
      group.add(lamps);

      this.layers.roads.add(group);
    }

    _buildExpansionGrid() {
      const rings = [
        { maxIdx: 1, color: 0x34d399, y: 1.5, name: 'RING_0 (6x6km)' },
        { maxIdx: 3, color: 0x38bdf8, y: 1.0, name: 'RING_1 (14x14km)' },
        { maxIdx: 7, color: 0xfbbf24, y: 0.5, name: 'RING_2 (30x30km)' },
      ];

      rings.forEach((r) => {
        const halfSpan = (r.maxIdx + 0.5) * DALAT_COORDS.TILE_SIZE_M;
        const pts = [];
        for (let k = -r.maxIdx; k <= r.maxIdx + 1; k++) {
          const coord = k * DALAT_COORDS.TILE_SIZE_M - DALAT_COORDS.HALF_TILE_M;
          pts.push(coord, r.y, -halfSpan, coord, r.y, halfSpan);
          pts.push(-halfSpan, r.y, coord, halfSpan, r.y, coord);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const mat = new THREE.LineBasicMaterial({
          color: r.color,
          transparent: true,
          opacity: r.maxIdx === 1 ? 0.55 : 0.22,
        });
        const lines = new THREE.LineSegments(geo, mat);
        lines.name = r.name;
        this.layers.grid.add(lines);
      });
    }

    _createLabelSprite(text, x, y, z) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 96;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgba(11, 22, 44, 0.78)';
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(8, 12, 496, 72, 16);
      } else {
        ctx.rect(8, 12, 496, 72);
      }
      ctx.fill();
      ctx.stroke();

      ctx.font = 'bold 28px "Segoe UI", sans-serif';
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 256, 48);

      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(x, y, z);
      sprite.scale.set(72, 13.5, 1);
      return sprite;
    }

    update(dt, elapsed) {
      for (const mesh of this.waterMeshes) {
        if (!mesh.visible || !mesh.geometry || !mesh.geometry.userData.baseY) continue;
        if (mesh.material && mesh.material.userData && mesh.material.userData.dalatRealtimeWater) {
          continue;
        }
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const z = pos.getZ(i);
          const wave =
            Math.sin(x * 0.025 + elapsed * 1.15) * 0.14 +
            Math.cos(z * 0.032 - elapsed * 0.9) * 0.11;
          pos.setY(i, wave);
        }
        pos.needsUpdate = true;
      }
    }
  }

  global.DALAT_COORDS = DALAT_COORDS;
  global.DEFAULT_LANDMARK_CATALOG = DEFAULT_LANDMARK_CATALOG;
  global.DalatTileStreamer = DalatTileStreamer;
})(window);
