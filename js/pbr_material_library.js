/**
 * pbr_material_library.js — Hệ Thống Vật Liệu Bề Mặt PBR Dùng Chung & Bù UV Tự Động
 * Dự án: DALAT_3D_SIMULATION (Three.js r128)
 * ============================================================================
 * - Nâng cấp hàng ngàn vật liệu màu solid trong 532+ tệp GLB & Procedural Fallback
 *   lên vật liệu PBR quét thật (Poly Haven CC0 nén nhẹ 512px Albedo + NormalGL + Roughness).
 * - Material Pooling: Tái sử dụng chung thực thể MeshStandardMaterial giữa các ô Tile,
 *   giúp tiết kiệm VRAM, tránh biên dịch lặp shader và giữ vững FPS ổn định.
 * - Tangent-Slope Metric UV: Tự động sinh tọa độ UV chuẩn tỉ lệ mét thực theo phương ngang
 *   tường & độ dốc mái cho hơn 6.200 khối công trình/biệt thự/cây xanh chưa có TEXCOORD_0.
 * - PMREM Sky Reflection: Tạo bản đồ phản xạ môi trường bầu trời cao nguyên theo từng
 *   khí hậu (Sương sớm / Trưa nắng / Hoàng hôn / Đêm phố núi) giúp kính màu, mái ngói,
 *   kim loại và mặt Hồ Xuân Hương phản chiếu ánh sáng chân thực mà không tốn chi phí render.
 */

(function (global) {
  'use strict';

  const PBR_BASE_URL = './assets/pbr';

  const SURFACE_ARCHETYPES = {
    stone_masonry: {
      albedo: 'stone_masonry_albedo.jpg',
      normal: 'stone_masonry_normal.jpg',
      rough: 'stone_masonry_rough.jpg',
      tileScaleM: 2.5,
      roughness: 0.86,
      metalness: 0.03,
      normalScale: 1.0,
      envIntensity: 0.55,
      minLum: 0.055,
      colorBoost: 1.16,
    },
    granite_paver: {
      albedo: 'granite_paver_albedo.jpg',
      normal: 'granite_paver_normal.jpg',
      rough: 'granite_paver_rough.jpg',
      tileScaleM: 2.4,
      roughness: 0.72,
      metalness: 0.05,
      normalScale: 0.78,
      envIntensity: 0.68,
      minLum: 0.06,
      colorBoost: 1.12,
    },
    heritage_stucco: {
      albedo: 'heritage_stucco_albedo.jpg',
      normal: 'heritage_stucco_normal.jpg',
      rough: 'heritage_stucco_rough.jpg',
      tileScaleM: 3.2,
      roughness: 0.8,
      metalness: 0.02,
      normalScale: 0.72,
      envIntensity: 0.5,
      minLum: 0.05,
      colorBoost: 1.08,
    },
    arch_concrete: {
      albedo: 'arch_concrete_albedo.jpg',
      normal: 'arch_concrete_normal.jpg',
      rough: 'arch_concrete_rough.jpg',
      tileScaleM: 3.4,
      roughness: 0.82,
      metalness: 0.03,
      normalScale: 0.78,
      envIntensity: 0.55,
      minLum: 0.055,
      colorBoost: 1.12,
    },
    clay_brick: {
      albedo: 'clay_brick_albedo.jpg',
      normal: 'clay_brick_normal.jpg',
      rough: 'clay_brick_rough.jpg',
      tileScaleM: 2.0,
      roughness: 0.83,
      metalness: 0.02,
      normalScale: 0.95,
      envIntensity: 0.52,
      minLum: 0.055,
      colorBoost: 1.16,
    },
    terracotta_paver: {
      albedo: 'terracotta_paver_albedo.jpg',
      normal: 'terracotta_paver_normal.jpg',
      rough: 'terracotta_paver_rough.jpg',
      tileScaleM: 2.2,
      roughness: 0.74,
      metalness: 0.03,
      normalScale: 0.85,
      envIntensity: 0.62,
      minLum: 0.055,
      colorBoost: 1.14,
    },
    clay_roof: {
      albedo: 'clay_roof_albedo.jpg',
      normal: 'clay_roof_normal.jpg',
      rough: 'clay_roof_rough.jpg',
      tileScaleM: 1.75,
      roughness: 0.74,
      metalness: 0.03,
      normalScale: 0.95,
      envIntensity: 0.68,
      minLum: 0.05,
      colorBoost: 1.15,
    },
    glazed_roof: {
      albedo: 'clay_roof_albedo.jpg',
      normal: 'clay_roof_normal.jpg',
      rough: 'clay_roof_rough.jpg',
      tileScaleM: 1.65,
      roughness: 0.24,
      metalness: 0.08,
      normalScale: 0.92,
      envIntensity: 1.25,
      minLum: 0.05,
      colorBoost: 1.18,
    },
    slate_roof: {
      albedo: 'slate_roof_albedo.jpg',
      normal: 'slate_roof_normal.jpg',
      rough: 'slate_roof_rough.jpg',
      tileScaleM: 2.0,
      roughness: 0.66,
      metalness: 0.06,
      normalScale: 0.88,
      envIntensity: 0.75,
      minLum: 0.05,
      colorBoost: 1.16,
    },
    corrugated_metal: {
      albedo: 'corrugated_metal_albedo.jpg',
      normal: 'corrugated_metal_normal.jpg',
      rough: 'corrugated_metal_rough.jpg',
      tileScaleM: 1.85,
      roughness: 0.44,
      metalness: 0.48,
      normalScale: 0.82,
      envIntensity: 1.05,
      minLum: 0.05,
      colorBoost: 1.15,
    },
    fine_wood: {
      albedo: 'fine_wood_albedo.jpg',
      normal: 'fine_wood_normal.jpg',
      rough: 'fine_wood_rough.jpg',
      tileScaleM: 1.8,
      roughness: 0.66,
      metalness: 0.04,
      normalScale: 0.75,
      envIntensity: 0.65,
      minLum: 0.045,
      colorBoost: 1.2,
    },
    tree_bark: {
      albedo: 'tree_bark_albedo.jpg',
      normal: 'tree_bark_normal.jpg',
      rough: 'tree_bark_rough.jpg',
      tileScaleM: 1.15,
      roughness: 0.9,
      metalness: 0.0,
      normalScale: 1.0,
      envIntensity: 0.42,
      minLum: 0.045,
      colorBoost: 1.22,
    },
    road_asphalt: {
      albedo: 'road_asphalt_albedo.jpg',
      normal: 'road_asphalt_normal.jpg',
      rough: 'road_asphalt_rough.jpg',
      tileScaleM: 3.8,
      roughness: 0.82,
      metalness: 0.05,
      normalScale: 0.9,
      envIntensity: 0.62,
      minLum: 0.048,
      colorBoost: 1.28,
    },
    lush_grass: {
      albedo: 'lush_grass_albedo.jpg',
      normal: 'lush_grass_normal.jpg',
      rough: 'lush_grass_rough.jpg',
      tileScaleM: 4.5,
      roughness: 0.88,
      metalness: 0.0,
      normalScale: 0.82,
      envIntensity: 0.45,
      minLum: 0.045,
      colorBoost: 1.18,
    },
    brushed_metal: {
      albedo: 'brushed_metal_albedo.jpg',
      normal: 'brushed_metal_normal.jpg',
      rough: 'brushed_metal_rough.jpg',
      tileScaleM: 1.6,
      roughness: 0.36,
      metalness: 0.72,
      normalScale: 0.48,
      envIntensity: 1.25,
      minLum: 0.05,
      colorBoost: 1.18,
    },
    foliage_canopy: {
      albedo: 'foliage_canopy_albedo.jpg',
      normal: 'foliage_canopy_normal.jpg',
      rough: 'foliage_canopy_rough.jpg',
      tileScaleM: 1.65,
      roughness: 0.76,
      metalness: 0.0,
      normalScale: 0.72,
      envIntensity: 0.5,
      minLum: 0.042,
      colorBoost: 1.18,
    },
    water_ripple: {
      albedo: null,
      normal: 'water_ripple_normal.jpg',
      rough: null,
      tileScaleM: 28.0,
      roughness: 0.16,
      metalness: 0.12,
      normalScale: 0.22,
      envIntensity: 0.65,
      minLum: 0.018,
      colorBoost: 0.96,
    },
  };

  class DalatPbrMaterialLibrary {
    constructor(renderer, scene) {
      this.renderer = renderer;
      this.scene = scene;
      this.texLoader = new THREE.TextureLoader();
      this.maxAnisotropy = Math.min(
        (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy()) || 1,
        16
      );
      this.textureCache = new Map();
      this.materialPool = new Map();
      this.envCache = new Map();
      this.pendingTextures = 0;
      this.pmremGenerator = null;

      if (renderer && typeof THREE.PMREMGenerator === 'function') {
        try {
          this.pmremGenerator = new THREE.PMREMGenerator(renderer);
          if (typeof this.pmremGenerator.compileCubemapShader === 'function') {
            this.pmremGenerator.compileCubemapShader();
          }
        } catch (_) {
          this.pmremGenerator = null;
        }
      }

      // Khởi tạo sẵn texture mặt nước động dùng chung cho Hồ Xuân Hương, Tuyền Lâm, Đa Nhim
      this.waterNormalMap = this._getTexture('water_ripple_normal.jpg', false);
    }

    _getTexture(filename, isSrgb) {
      if (!filename) return null;
      const key = `${filename}|${isSrgb ? 'srgb' : 'lin'}`;
      if (this.textureCache.has(key)) return this.textureCache.get(key);

      const url = `${PBR_BASE_URL}/${filename}`;
      this.pendingTextures += 1;
      const done = () => {
        this.pendingTextures = Math.max(0, this.pendingTextures - 1);
      };
      const tex = this.texLoader.load(url, done, undefined, done);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = this.maxAnisotropy;
      if (isSrgb && THREE.sRGBEncoding !== undefined) {
        tex.encoding = THREE.sRGBEncoding;
      }
      this.textureCache.set(key, tex);
      return tex;
    }

    /**
     * Tạo & lưu đệm bản đồ phản xạ bầu trời PMREM theo từng chế độ khí hậu Đà Lạt
     */
    applyClimateEnvironment(climatePreset) {
      if (!this.pmremGenerator || !this.scene || !climatePreset) return;
      const cacheKey = climatePreset.id || 'default';
      if (this.envCache.has(cacheKey)) {
        this.scene.environment = this.envCache.get(cacheKey);
        return;
      }

      try {
        const envScene = new THREE.Scene();
        const geo = new THREE.SphereGeometry(30, 20, 14);
        const pos = geo.attributes.position;
        const colors = new Float32Array(pos.count * 3);

        const topCol = new THREE.Color(climatePreset.sky_hex || '#7BB5E8');
        const horCol = new THREE.Color(climatePreset.fog_hex || '#DCE6EE').lerp(
          new THREE.Color(climatePreset.sun_hex || '#FFE2B0'),
          0.28
        );
        const gndCol = new THREE.Color('#2c3a2d').lerp(topCol, 0.22);
        const tmp = new THREE.Color();

        for (let i = 0; i < pos.count; i++) {
          const ny = pos.getY(i) / 30.0;
          if (ny >= 0) {
            tmp.copy(horCol).lerp(topCol, Math.pow(ny, 0.65));
          } else {
            tmp.copy(horCol).lerp(gndCol, Math.min(1.0, Math.pow(-ny, 0.55) * 1.25));
          }
          colors[i * 3] = tmp.r;
          colors[i * 3 + 1] = tmp.g;
          colors[i * 3 + 2] = tmp.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const dome = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })
        );
        envScene.add(dome);

        // Điểm sáng mặt trời tạo phản xạ specular trên mặt hồ, kính màu và mái ngói
        const elevRad = THREE.MathUtils.degToRad(climatePreset.sun_elevation_deg || 35);
        const azimRad = THREE.MathUtils.degToRad(climatePreset.sun_azimuth_deg || 120);
        const sunDisc = new THREE.Mesh(
          new THREE.SphereGeometry(2.6, 10, 8),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(climatePreset.sun_hex || '#FFF4D8').multiplyScalar(1.8),
          })
        );
        sunDisc.position.set(
          Math.sin(azimRad) * Math.cos(elevRad) * 24,
          Math.sin(elevRad) * 24,
          -Math.cos(azimRad) * Math.cos(elevRad) * 24
        );
        envScene.add(sunDisc);

        const rt = this.pmremGenerator.fromScene(envScene, 0.035);
        geo.dispose();
        dome.material.dispose();
        sunDisc.geometry.dispose();
        sunDisc.material.dispose();

        if (rt && rt.texture) {
          this.envCache.set(cacheKey, rt.texture);
          this.scene.environment = rt.texture;
        }
      } catch (err) {
        console.warn('[DalatPBR] Không tạo được PMREM environment:', err);
      }
    }

    /**
     * Phân loại ngữ nghĩa tên vật liệu + thuộc tính màu sang đúng bề mặt vật lý Đà Lạt
     */
    classifyMaterial(mat, isWaterLayer) {
      const n = String((mat && mat.name) || '').toLowerCase();
      if (isWaterLayer && !/embankment|promenade|stone|granite|grass|verge|spillway|concrete|bridge|bank/.test(n)) {
        return 'water_ripple';
      }

      // 1. Không gắn texture đè lên đèn phát sáng thuần túy, vạch kẻ đường phát sáng hoặc kính
      if (
        /bulb|neon|streetlamp_emissive|lantern_glow|headlight|taillight|ember|stringlights|string_bulb|growlight|retrosign|road_marking|centerline|pitch_lines|icao_white|taxi_yellow|thermoplastic/.test(
          n
        )
      ) {
        return null;
      }

      if (/water|ho_xuan_huong|settlingbasin|retention_water|plunge_foam/.test(n)) {
        return 'water_ripple';
      }
      if (/bark|flutedbark|stem_base/.test(n)) {
        return 'tree_bark';
      }
      if (
        /foliage|canopy_deep|canopy_mid|canopy_sunlit|pine_canopy|emerald|tea_hedge|blossom|flower|petal|hydrangea|bougainvillea|climbing_rose|pink_grass|vine_/.test(
          n
        )
      ) {
        return 'foliage_canopy';
      }
      if (/grass|turf|lawn|pitch|verge|plateau_terrain|soil/.test(n)) {
        return 'lush_grass';
      }
      if (/asphalt|runway|road_|cau_ong_dao|tire/.test(n)) {
        return 'road_asphalt';
      }
      if (/glazed_crimson|luu_ly/.test(n)) {
        return 'glazed_roof';
      }
      if (/terracotta_gable|terracotta_tile|roof_tile|clay_roof/.test(n)) {
        return 'clay_roof';
      }
      if (/slate|mansard|shingle/.test(n)) {
        return 'slate_roof';
      }
      if (
        /pine_green_hip|highland_blue_gable|zinc_silver_gable|greenhouse_arch|corrugated|container_|galvanized|sheds/.test(
          n
        )
      ) {
        return 'corrugated_metal';
      }
      if (/brick|cdsp/.test(n)) {
        return 'clay_brick';
      }
      if (/terracotta_piste/.test(n)) {
        return 'terracotta_paver';
      }
      if (
        /splitstone|split_stone|split_granite|taluy|embankment|riprap|retaining_wall|stone_skirt|stone_foot|basalt|cliff/.test(
          n
        )
      ) {
        return 'stone_masonry';
      }
      if (
        /granite|paver|promenade|plaza|curb|coping|sandstone|quoin|trim_stone|cornice|baluster|sculpture/.test(
          n
        )
      ) {
        return 'granite_paver';
      }
      if (/wood|timber|truss|shutter|deck|cedar|columns_and_rafters/.test(n)) {
        return 'fine_wood';
      }
      if (
        /iron|steel|brass|bronze|gilded|gold_accent|diagrid|tour_van|jeep_army|jeep_orange|jeep_sand/.test(
          n
        )
      ) {
        return 'brushed_metal';
      }
      if (/concrete|spillway|weir|apron|flat_parapet|bowl_structure|concourse/.test(n)) {
        return 'arch_concrete';
      }
      if (/stucco|wall|ochre|cream|pastel|warmwhite|warm_white|backing|canopy_|tent|canvas|coat|seats_/.test(n)) {
        return 'heritage_stucco';
      }

      // Fallback thông minh theo độ kim loại / độ nhám nếu tên vật liệu chung chung
      if (mat && typeof mat.metalness === 'number' && mat.metalness >= 0.45) {
        return 'brushed_metal';
      }
      return 'heritage_stucco';
    }

    /**
     * Sinh tọa độ UV chuẩn tỉ lệ mét thực theo phương ngang tường & độ dốc mái
     * cho các BufferGeometry chưa có thuộc tính `uv` (0 chi phí runtime sau khi nạp)
     */
    ensureMetricUVs(geometry, tileScaleM) {
      if (!geometry || !geometry.attributes || !geometry.attributes.position) return;
      if (geometry.userData && geometry.userData._pbrUvReady) return;

      const existingUv = geometry.attributes.uv;
      if (existingUv && existingUv.count > 0) {
        const arr = existingUv.array;
        let minU = Infinity,
          maxU = -Infinity,
          minV = Infinity,
          maxV = -Infinity;
        const sampleStep = Math.max(1, Math.floor(existingUv.count / 96)) * 2;
        for (let i = 0; i < arr.length; i += sampleStep) {
          const u = arr[i];
          const v = arr[i + 1];
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        const uvSpan = Math.max(maxU - minU, maxV - minV);
        if (uvSpan > 1e-3) {
          if (!geometry.boundingBox) geometry.computeBoundingBox();
          const bb = geometry.boundingBox;
          const geomSpan = bb
            ? Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z)
            : 0;
          const targetTile = Math.max(tileScaleM || 2.5, 0.5);
          const isStretchedBoxUv =
            geomSpan > targetTile * 3.4 && geomSpan / uvSpan > targetTile * 3.4;
          if (!isStretchedBoxUv) {
            geometry.userData = geometry.userData || {};
            geometry.userData._pbrUvReady = true;
            return;
          }
        }
      }

      if (!geometry.attributes.normal) {
        geometry.computeVertexNormals();
      }
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      const bb = geometry.boundingBox;
      const cx = bb ? 0.5 * (bb.min.x + bb.max.x) : 0;
      const cz = bb ? 0.5 * (bb.min.z + bb.max.z) : 0;
      const radiusXZ = bb ? Math.max(0.35, 0.25 * (bb.max.x - bb.min.x + (bb.max.z - bb.min.z))) : 1.0;

      const pos = geometry.attributes.position;
      const norm = geometry.attributes.normal;
      const count = pos.count;
      const pArr = pos.array;
      const nArr = norm ? norm.array : null;
      const uvArr = new Float32Array(count * 2);
      const invScale = 1.0 / Math.max(tileScaleM || 2.5, 0.25);

      let uMin = Infinity,
        uMax = -Infinity;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        const x = pArr[i3];
        const y = pArr[i3 + 1];
        const z = pArr[i3 + 2];

        const nx = nArr ? nArr[i3] : 0;
        const ny = nArr ? nArr[i3 + 1] : 1;
        const nz = nArr ? nArr[i3 + 2] : 0;
        const h = Math.hypot(nx, nz);

        let u, v;
        if (h > 0.08) {
          const tux = nz / h;
          const tuz = -nx / h;
          const tvx = (-nx * ny) / h;
          const tvy = h;
          const tvz = (-ny * nz) / h;
          u = ((x - cx) * tux + (z - cz) * tuz) * invScale;
          v = (x * tvx + y * tvy + z * tvz) * invScale;
        } else {
          u = x * invScale;
          v = -z * invScale;
        }
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        const i2 = i * 2;
        uvArr[i2] = u;
        uvArr[i2 + 1] = v;
      }

      // Khối tròn xoay đồng tâm (thân cây, tán thông hình nón, cột tròn, tháp): chiếu trụ Polar 360°
      if (uMax - uMin < 0.12 && radiusXZ > 0.2) {
        const circum = 2.0 * Math.PI * radiusXZ * invScale;
        for (let i = 0; i < count; i++) {
          const i3 = i * 3;
          const dx = pArr[i3] - cx;
          const y = pArr[i3 + 1];
          const dz = pArr[i3 + 2] - cz;
          const ang = Math.atan2(dz, dx) / (2.0 * Math.PI) + 0.5;
          uvArr[i * 2] = ang * Math.max(1.0, Math.round(circum));
          uvArr[i * 2 + 1] = y * invScale;
        }
      }

      geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      geometry.userData = geometry.userData || {};
      geometry.userData._pbrUvReady = true;
    }

    _calibrateColor(srcColor, spec) {
      const c = srcColor ? srcColor.clone() : new THREE.Color(0xffffff);
      c.multiplyScalar(spec.colorBoost || 1.1);
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const minLum = spec.minLum || 0.045;
      if (lum < minLum) {
        if (lum < 1e-4) {
          c.setScalar(minLum);
        } else {
          const lift = (minLum + lum * 0.5) / lum;
          c.multiplyScalar(Math.min(lift, 3.2));
        }
      }
      c.r = Math.min(c.r, 1.0);
      c.g = Math.min(c.g, 1.0);
      c.b = Math.min(c.b, 1.0);
      return c;
    }

    /**
     * Nâng cấp một vật liệu đơn lẻ sang thực thể PBR dùng chung (Pooled MeshStandardMaterial)
     */
    upgradeMaterial(mat, isWaterLayer) {
      if (!mat) return { material: mat, tileScaleM: null };

      // Vật liệu đã có sẵn texture hợp lệ riêng (DEM vệ tinh, Datanla PBR, biển hiệu...) -> giữ nguyên & tăng độ nét nghiêng 16x
      if ((mat.map && mat.map.image) || (mat.normalMap && mat.normalMap.image)) {
        if (mat.map) {
          mat.map.anisotropy = this.maxAnisotropy;
          mat.map.minFilter = THREE.LinearMipmapLinearFilter;
          mat.map.magFilter = THREE.LinearFilter;
          mat.map.needsUpdate = true;
        }
        if (mat.normalMap) mat.normalMap.anisotropy = this.maxAnisotropy;
        const isSatTerrain = /terrainreal|esri_satellite|highland_backdrop|satellite/i.test(mat.name || '');
        if (isSatTerrain) {
          mat.roughness = 0.96;
          mat.metalness = 0.0;
          mat.envMapIntensity = 0.18;
        } else {
          mat.envMapIntensity = mat.envMapIntensity != null ? mat.envMapIntensity : 0.75;
        }
        return { material: mat, tileScaleM: null };
      }

      // Kính màu (Hoa Dã Quỳ, Nụ Atiso), cửa sổ biệt thự, màng nhà kính -> tăng phản xạ bầu trời
      if (!isWaterLayer && (mat.transparent || (typeof mat.opacity === 'number' && mat.opacity < 0.96))) {
        mat.roughness = Math.min(mat.roughness != null ? mat.roughness : 0.22, 0.26);
        mat.metalness = Math.max(mat.metalness != null ? mat.metalness : 0.12, 0.12);
        mat.envMapIntensity = 1.35;
        mat.needsUpdate = true;
        return { material: mat, tileScaleM: null };
      }

      // Bỏ qua vật liệu dùng vertexColors (địa hình fallback đã phối màu cao độ)
      if (mat.vertexColors) {
        const grassSpec = SURFACE_ARCHETYPES.lush_grass;
        mat.normalMap = this._getTexture(grassSpec.normal, false);
        mat.roughnessMap = this._getTexture(grassSpec.rough, false);
        mat.normalScale = new THREE.Vector2(0.55, 0.55);
        mat.envMapIntensity = 0.45;
        mat.needsUpdate = true;
        return { material: mat, tileScaleM: 12.0 };
      }

      const archetypeKey = this.classifyMaterial(mat, isWaterLayer);
      if (!archetypeKey || !SURFACE_ARCHETYPES[archetypeKey]) {
        return { material: mat, tileScaleM: null };
      }

      const spec = SURFACE_ARCHETYPES[archetypeKey];
      const calColor = this._calibrateColor(mat.color, spec);
      const hasEmissive =
        Boolean(mat.emissive) &&
        (mat.emissive.r > 0.005 || mat.emissive.g > 0.005 || mat.emissive.b > 0.005);

      const roughVal =
        archetypeKey === 'water_ripple' || archetypeKey === 'glazed_roof'
          ? spec.roughness
          : mat.roughness != null
            ? THREE.MathUtils.lerp(mat.roughness, spec.roughness, 0.65)
            : spec.roughness;

      const metalVal =
        mat.metalness != null && mat.metalness > spec.metalness
          ? THREE.MathUtils.lerp(mat.metalness, spec.metalness, 0.35)
          : spec.metalness;

      const sideVal = mat.side != null ? mat.side : THREE.FrontSide;
      const poolKey = [
        archetypeKey,
        calColor.getHexString(),
        Math.round(roughVal * 25),
        Math.round(metalVal * 25),
        sideVal,
        isWaterLayer ? 1 : 0,
        hasEmissive ? `${mat.emissive.getHexString()}_${Math.round((mat.emissiveIntensity || 1) * 20)}` : 'noem',
      ].join('|');

      if (this.materialPool.has(poolKey)) {
        return { material: this.materialPool.get(poolKey), tileScaleM: spec.tileScaleM };
      }

      const albedoMap = spec.albedo ? this._getTexture(spec.albedo, true) : null;
      const normalMap =
        archetypeKey === 'water_ripple'
          ? this.waterNormalMap
          : spec.normal
            ? this._getTexture(spec.normal, false)
            : null;
      const roughMap = spec.rough ? this._getTexture(spec.rough, false) : null;

      const pbrMat = new THREE.MeshStandardMaterial({
        name: `${mat.name || archetypeKey}_PBR`,
        color: calColor,
        map: albedoMap,
        normalMap: normalMap,
        normalScale: new THREE.Vector2(spec.normalScale, spec.normalScale),
        roughnessMap: roughMap,
        roughness: roughVal,
        metalness: metalVal,
        side: sideVal,
        transparent: archetypeKey === 'water_ripple',
        opacity: archetypeKey === 'water_ripple' ? 0.9 : 1.0,
        envMapIntensity: spec.envIntensity,
      });

      if (hasEmissive) {
        pbrMat.emissive = mat.emissive.clone();
        pbrMat.emissiveIntensity = mat.emissiveIntensity != null ? mat.emissiveIntensity : 1.0;
      }

      this.materialPool.set(poolKey, pbrMat);
      return { material: pbrMat, tileScaleM: spec.tileScaleM };
    }

    /**
     * Duyệt toàn bộ cây Object3D vừa nạp, nâng cấp vật liệu PBR & bù UV tự động
     */
    upgradeObjectHierarchy(root, isWaterLayer) {
      if (!root) return;
      root.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry || !obj.material) return;

        if (Array.isArray(obj.material)) {
          let chosenScale = null;
          obj.material = obj.material.map((m) => {
            const res = this.upgradeMaterial(m, isWaterLayer);
            if (!chosenScale && res.tileScaleM) chosenScale = res.tileScaleM;
            return res.material;
          });
          if (chosenScale) this.ensureMetricUVs(obj.geometry, chosenScale);
        } else {
          const res = this.upgradeMaterial(obj.material, isWaterLayer);
          obj.material = res.material;
          if (res.tileScaleM) this.ensureMetricUVs(obj.geometry, res.tileScaleM);
        }
      });
    }

    /**
     * Cập nhật chuyển động gợn sóng mặt nước nhẹ trên GPU mỗi khung hình (~0.005ms)
     */
    update(dt) {
      if (this.waterNormalMap) {
        this.waterNormalMap.offset.x = (this.waterNormalMap.offset.x + dt * 0.016) % 1.0;
        this.waterNormalMap.offset.y = (this.waterNormalMap.offset.y + dt * 0.011) % 1.0;
      }
    }
  }

  global.DalatPbrMaterialLibrary = DalatPbrMaterialLibrary;
})(window);
