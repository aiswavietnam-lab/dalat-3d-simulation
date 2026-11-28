/**
 * sketchup_controls.js — Bộ Điều Khiển & Phím Tắt Chuẩn SketchUp (Đồng Bộ Từ Cấu Hình Máy Cài)
 * Dự án: DALAT_3D_SIMULATION
 * ============================================================================
 * Hoạt động song song với chế độ mặc định của Đà Lạt 3D Viewer:
 *   - Chuyển đổi tức thời giữa:
 *       1. `default`  — Chế độ Đà Lạt mặc định (Chuột trái Orbit, Phải Pan, WASD+QE Flycam, F/G)
 *       2. `sketchup` — Chuẩn SketchUp 2023 đang cài trên máy (SharedPreferences.json & .bak + Curic Pie Menu)
 *   - Chuẩn chuột SketchUp:
 *       + Chuột giữa (MMB): Orbit tức thời quanh tâm raycast
 *       + Shift + Chuột giữa / MMB + Chuột trái / Kéo Chuột phải: Pan tức thời
 *       + Cuộn chuột: Zoom-to-Cursor Raycast (hỗ trợ cả Perspective & Parallel Projection)
 *       + Chuột trái (LMB): Thực hiện theo Công cụ đang chọn (Select / Orbit / Pan / Zoom / Zoom Window /
 *         Look Around / Position Camera / Walk / Tape Measure / Dimension / Protractor / Eraser / Paint Info)
 *   - Phím tắt SketchUp đầy đủ (nhóm Camera, Góc nhìn chuẩn Ctrl+1..6 & Shift+I, Phép chiếu ` & \,
 *     Kiểu hiển thị F2..F8 & K, Bóng đổ Alt+Shift+S, Ẩn/Hiện H/Shift+H/U/Shift+U/T/Alt+Q,
 *     Zoom Selection Alt+Shift+X, Zoom Extents Shift+Z, Zoom Window Ctrl+Shift+Z,
 *     Đo 3D Ctrl+Alt+T / D / X / E, Thêm Scene Ctrl+Shift+A, Ẩn UI Ctrl+H/D, Pie Menu Alt+1, Tra cứu Shift+S).
 */

(function (global) {
  'use strict';

  const STORAGE_MODE_KEY = 'dalat_control_mode_v1';
  const STORAGE_SCENES_KEY = 'dalat_su_scenes_v1';

  const TOOL_META = {
    select: { id: 'select', label: 'Select', shortcut: 'Space', hint: 'Click chọn công trình / đối tượng • MMB: Orbit' },
    orbit: { id: 'orbit', label: 'Orbit', shortcut: 'O', hint: 'Kéo chuột trái để xoay quanh tâm điểm' },
    pan: { id: 'pan', label: 'Pan', shortcut: 'Alt+` / H', hint: 'Kéo chuột trái để trượt mặt bằng / khung nhìn' },
    zoom: { id: 'zoom', label: 'Zoom', shortcut: 'Z', hint: 'Kéo chuột trái lên để phóng to, xuống để thu nhỏ' },
    zoom_window: { id: 'zoom_window', label: 'Zoom Window', shortcut: 'Ctrl+Shift+Z', hint: 'Khoanh khung chữ nhật để phóng đúng vùng chọn' },
    look_around: { id: 'look_around', label: 'Look Around', shortcut: 'N / Ctrl+`', hint: 'Đứng tại chỗ xoay mắt nhìn 360° xung quanh' },
    position_camera: { id: 'position_camera', label: 'Position Camera', shortcut: 'Alt+D', hint: 'Click hoặc kéo từ vị trí đứng tới hướng nhìn (+1.7m mắt người)' },
    walk: { id: 'walk', label: 'Walk', shortcut: 'I', hint: 'Kéo chuột trái hoặc mũi tên/WASD để dạo bộ bám địa hình (+1.7m)' },
    measure: { id: 'measure', label: 'Tape Measure', shortcut: 'Ctrl+Alt+T', hint: 'Click 2 điểm để đo khoảng cách 3D, ngang, chênh cao & độ dốc' },
    dimension: { id: 'dimension', label: 'Dimension', shortcut: 'D', hint: 'Click 2 điểm để ghim nhãn kích thước trên cảnh 3D' },
    protractor: { id: 'protractor', label: 'Protractor', shortcut: 'X', hint: 'Click 3 điểm (Tâm -> Cạnh 1 -> Cạnh 2) để đo góc & phương vị' },
    eraser: { id: 'eraser', label: 'Eraser', shortcut: 'E', hint: 'Click vào đường đo / nhãn để xóa' },
    paint: { id: 'paint', label: 'Inspect Material', shortcut: 'B', hint: 'Click lên bề mặt 3D để xem vật liệu PBR & cao độ MSL' },
  };

  const FACE_STYLE_LABELS = {
    textures: 'Shaded With Textures (F2)',
    shaded: 'Shaded (F3)',
    monochrome: 'Monochrome (F4)',
    wireframe: 'Wireframe (F5)',
    hidden_line: 'Hidden Line (F6)',
  };

  const SHORTCUT_CATALOG = [
    { group: 'Chuột & Điều hướng cơ bản', key: 'Chuột giữa (MMB)', desc: 'Orbit xoay tức thời ở mọi công cụ' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Shift+MMB / MMB+LMB / Chuột phải', desc: 'Pan trượt ngang khung nhìn' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Cuộn chuột', desc: 'Zoom-to-Cursor vào đúng vị trí con trỏ' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Space', desc: 'Công cụ Select (chọn công trình / đối tượng)' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'O', desc: 'Công cụ Orbit (kéo chuột trái xoay)' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Alt+`  (hoặc H khi chưa chọn vật)', desc: 'Công cụ Pan / Hand (selectDollyTool)' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Z', desc: 'Công cụ Zoom (kéo lên/xuống)' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Shift+Z', desc: 'Zoom Extents — bay về toàn cảnh Đà Lạt' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Ctrl+Shift+Z', desc: 'Zoom Window — khoanh khung phóng cận cảnh' },
    { group: 'Chuột & Điều hướng cơ bản', key: 'Alt+Shift+X', desc: 'Zoom Selection — phóng vừa đối tượng đang chọn' },
    { group: 'Camera & Đi bộ 3D', key: 'N  /  Ctrl+`', desc: 'Look Around — đứng yên xoay mắt 360°' },
    { group: 'Camera & Đi bộ 3D', key: 'Alt+D', desc: 'Position Camera — đặt mắt người (+1.70m) tại điểm click' },
    { group: 'Camera & Đi bộ 3D', key: 'I', desc: 'Walk Tool — đi bộ bám mặt đất DEM (+1.70m)' },
    { group: 'Camera & Đi bộ 3D', key: '` (Backquote)', desc: 'Bật/Tắt Parallel Projection (Chiếu song song ↔ Phối cảnh)' },
    { group: 'Camera & Đi bộ 3D', key: '\\ (Backslash)', desc: 'Bật/Tắt Two-Point Perspective (Phối cảnh 2 điểm tụ)' },
    { group: 'Camera & Đi bộ 3D', key: 'Ctrl+Alt+Shift+A', desc: 'Align View — căn nhìn vuông góc vào mặt/công trình chọn' },
    { group: 'Camera & Đi bộ 3D', key: 'PageUp / PageDown', desc: 'Previous / Next Camera View (Lịch sử góc nhìn)' },
    { group: 'Góc nhìn chuẩn (Standard Views)', key: 'Ctrl+1', desc: 'Top View — Mặt bằng từ trên xuống (Bắc lên trên)' },
    { group: 'Góc nhìn chuẩn (Standard Views)', key: 'Ctrl+2', desc: 'Front View — Mặt đứng nhìn từ hướng Nam' },
    { group: 'Góc nhìn chuẩn (Standard Views)', key: 'Ctrl+3', desc: 'Back View — Mặt đứng nhìn từ hướng Bắc' },
    { group: 'Góc nhìn chuẩn (Standard Views)', key: 'Ctrl+4', desc: 'Left View — Mặt đứng nhìn từ hướng Tây' },
    { group: 'Góc nhìn chuẩn (Standard Views)', key: 'Ctrl+5', desc: 'Right View — Mặt đứng nhìn từ hướng Đông' },
    { group: 'Góc nhìn chuẩn (Standard Views)', key: 'Ctrl+6', desc: 'Bottom View — Nhìn từ dưới lên' },
    { group: 'Góc nhìn chuẩn (Standard Views)', key: 'Shift+I', desc: 'Iso View — Phối cảnh trục đo chuẩn 45°' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'F2', desc: 'Shaded With Textures — Vật liệu PBR & vệ tinh gốc' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'F3', desc: 'Shaded — Màu khối đơn sắc không ảnh texture' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'F4', desc: 'Monochrome — Sa bàn trắng/xám kiến trúc' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'F5', desc: 'Wireframe — Khung dây lưới 3D' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'F6', desc: 'Hidden Line — Bản vẽ nét đen nền trắng' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'F7', desc: 'X-Ray — Bật/Tắt nhìn xuyên thấu công trình' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'F8', desc: 'Edges — Bật/Tắt đường viền cạnh 3D' },
    { group: 'Hiển thị Mặt & Cạnh (Styles)', key: 'K', desc: 'Back Edges — Bật/Tắt nét đứt khuất phía sau' },
    { group: 'Ẩn/Hiện, Bóng đổ & Lớp', key: 'Alt+Shift+S  /  Ctrl+Alt+Shift+S', desc: 'Bật/Tắt Shadows (Bóng đổ Mặt trời)' },
    { group: 'Ẩn/Hiện, Bóng đổ & Lớp', key: 'H (khi đang chọn vật)', desc: 'Hide — Ẩn công trình/nhóm đang chọn' },
    { group: 'Ẩn/Hiện, Bóng đổ & Lớp', key: 'Shift+H / U / Alt+U / Alt+J', desc: 'Unhide Last — Hiện lại đối tượng vừa ẩn' },
    { group: 'Ẩn/Hiện, Bóng đổ & Lớp', key: 'Shift+U', desc: 'Unhide All — Hiện lại toàn bộ đối tượng đã ẩn' },
    { group: 'Ẩn/Hiện, Bóng đổ & Lớp', key: 'T (đang chọn vật) / Alt+Q', desc: 'Hide Rest of Model / Isolate — Cô lập đối tượng chọn' },
    { group: 'Ẩn/Hiện, Bóng đổ & Lớp', key: 'Ctrl+Alt+Shift+L', desc: 'Layers — Mở nhanh bảng các lớp dữ liệu 3D' },
    { group: 'Ẩn/Hiện, Bóng đổ & Lớp', key: 'Ctrl+H / Ctrl+D', desc: 'Hide Dialogs — Ẩn/Hiện toàn bộ giao diện HUD' },
    { group: 'Đo đạc, Vật liệu & Scene', key: 'Ctrl+Alt+T  (hoặc T khi chưa chọn)', desc: 'Tape Measure — Thước đo 3D (Dài, Ngang, Cao, Dốc %)' },
    { group: 'Đo đạc, Vật liệu & Scene', key: 'D', desc: 'Dimension — Ghim nhãn kích thước trên 3D' },
    { group: 'Đo đạc, Vật liệu & Scene', key: 'X', desc: 'Protractor — Đo góc & phương vị 3 điểm' },
    { group: 'Đo đạc, Vật liệu & Scene', key: 'E', desc: 'Eraser — Xóa các đường đo / nhãn' },
    { group: 'Đo đạc, Vật liệu & Scene', key: 'B', desc: 'Material Inspector — Soi vật liệu PBR & cao độ MSL' },
    { group: 'Đo đạc, Vật liệu & Scene', key: 'Ctrl+Shift+A', desc: 'Add Scene — Lưu góc nhìn & khí hậu thành tab Scene' },
    { group: 'Đo đạc, Vật liệu & Scene', key: 'Shift+;', desc: 'Chuyển nhanh tới Scene / Preset kế tiếp' },
    { group: 'Menu & Hệ thống', key: 'Alt+1  (hoặc Alt+V)', desc: 'Curic Pie Menu View — Vòng tròn thao tác nhanh tại con trỏ' },
    { group: 'Menu & Hệ thống', key: 'Shift+S', desc: 'Mở/Đóng Bảng Tra Cứu Phím Tắt SketchUp' },
    { group: 'Menu & Hệ thống', key: 'F  /  G', desc: 'Bật/Tắt Sương mù Đà Lạt (F) / Chất lượng Đồ họa (G)' },
  ];

  function createSvgIcon(pathD, viewBox = '0 0 24 24') {
    return `<svg viewBox="${viewBox}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathD}</svg>`;
  }

  const TOOL_ICONS = {
    select: createSvgIcon('<path d="M5 3l14 9-6.5 1.5L10 20 5 3z"/>'),
    orbit: createSvgIcon('<circle cx="12" cy="12" r="7"/><path d="M3 12c0-2.8 4-5 9-5s9 2.2 9 5-4 5-9 5"/>'),
    pan: createSvgIcon('<path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8c0 4 2.7 6 6 6 3.5 0 6-2.5 6-6v-3a2 2 0 0 0-4 0"/>'),
    zoom: createSvgIcon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/><path d="M10.5 7.5v6M7.5 10.5h6"/>'),
    zoom_window: createSvgIcon('<rect x="3" y="3" width="12" height="12" rx="1" stroke-dasharray="3 2"/><circle cx="15" cy="15" r="4"/><path d="M18 18l3 3"/>'),
    look_around: createSvgIcon('<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>'),
    position_camera: createSvgIcon('<circle cx="12" cy="5" r="2.2"/><path d="M12 8v8M9 21l3-5 3 5M7 12h10"/>'),
    walk: createSvgIcon('<circle cx="13" cy="4.5" r="2"/><path d="M10 21l2-6 3 2v4M8 14l3-4 4 1 3 3"/>'),
    measure: createSvgIcon('<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="M7 8v3M11 8v4M15 8v3M19 8v2"/>'),
    dimension: createSvgIcon('<path d="M4 17V7M20 17V7M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3"/>'),
    protractor: createSvgIcon('<path d="M4 18A8 8 0 0 1 20 18H4z"/><path d="M12 18l4-5"/>'),
    eraser: createSvgIcon('<path d="M7 20h13M4 15l7-7 6 6-5 6H7l-3-5z"/>'),
    paint: createSvgIcon('<path d="M19 11l-8-8-7 7 8 8 7-7z"/><path d="M5 10l9 9"/><path d="M19 14c1.2 1.5 2 2.7 2 3.8a2 2 0 1 1-4 0c0-1.1.8-2.3 2-3.8z"/>'),
  };

  class DalatSketchupController {
    constructor(engine) {
      this.engine = engine;
      this.perspCamera = engine.camera;
      this.orthoCamera = new THREE.OrthographicCamera(-500, 500, 350, -350, -25000, 48000);
      this.orthoHalfHeight = 420;
      this.isParallel = false;
      this.isTwoPoint = false;
      this.twoPointShiftY = 0;

      this.mode = this._resolveInitialMode();
      this.activeTool = 'select';
      this.faceStyle = 'textures';
      this.xrayEnabled = false;
      this.edgesEnabled = false;
      this.backEdgesEnabled = false;
      this.dialogsHidden = false;

      // Hàng đợi trạng thái thao tác chuột & phím
      this.activePointers = new Map();
      this.downButtonsMask = 0;
      this.dragKind = null;
      this.tempRevertTool = false;
      this.pointerDownClient = { x: 0, y: 0 };
      this.lastClient = { x: 0, y: 0 };
      this.lastMouseScreen = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 };
      this.orbitAnchor = null;
      this.zoomAnchor = null;
      this.posCamStartHit = null;
      this.zoomWindowStart = null;
      this.arrowKeys = new Set();

      // Lịch sử góc nhìn & Scene
      this.viewHistory = [];
      this.viewHistoryIdx = -1;
      this._pushHistoryDebounced = null;
      this.scenes = this._loadSavedScenes();

      // Chọn, Ẩn, Cô lập
      this.selectedEntity = null;
      this.selectionHelper = new THREE.Box3Helper(new THREE.Box3(), 0x38bdf8);
      this.selectionHelper.visible = false;
      this.selectionHelper.renderOrder = 950;
      this.engine.scene.add(this.selectionHelper);
      this.hiddenStack = [];
      this.isolatedState = null;

      // Overlay đồ họa hỗ trợ: Mặt & Nét, Đo đạc, Nhãn 3D
      this.edgeOverlayGroup = new THREE.Group();
      this.edgeOverlayGroup.name = 'su_edge_overlay';
      this.engine.scene.add(this.edgeOverlayGroup);

      this.measureGroup = new THREE.Group();
      this.measureGroup.name = 'su_measurements';
      this.engine.scene.add(this.measureGroup);

      this._edgeGeoCache = new Map();
      this._edgeMatNormal = new THREE.LineBasicMaterial({
        color: 0x111827,
        transparent: true,
        opacity: 0.72,
      });
      this._edgeMatBack = new THREE.LineDashedMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.34,
        dashSize: 3.0,
        gapSize: 2.2,
        depthTest: false,
      });
      this._sharedMonoMat = new THREE.MeshStandardMaterial({
        name: 'su_monochrome_clay',
        color: 0xf8fafc,
        roughness: 0.82,
        metalness: 0.02,
      });
      this._sharedMonoTerrainMat = new THREE.MeshStandardMaterial({
        name: 'su_monochrome_terrain',
        color: 0xcbd5e1,
        roughness: 0.94,
        metalness: 0.0,
      });
      this._sharedMonoWaterMat = new THREE.MeshStandardMaterial({
        name: 'su_monochrome_water',
        color: 0x9fb8cb,
        roughness: 0.35,
        metalness: 0.1,
      });
      this._sharedMonoRoadMat = new THREE.MeshStandardMaterial({
        name: 'su_monochrome_road',
        color: 0x94a3b8,
        roughness: 0.9,
        metalness: 0.02,
      });
      this._sharedWireMat = new THREE.MeshBasicMaterial({
        name: 'su_wireframe_mat',
        color: 0x38bdf8,
        wireframe: true,
      });
      this._sharedHiddenMat = new THREE.MeshBasicMaterial({
        name: 'su_hidden_line_mat',
        color: 0xffffff,
        polygonOffset: true,
        polygonOffsetFactor: 1.5,
        polygonOffsetUnits: 1.5,
      });
      this._sharedHiddenTerrainMat = new THREE.MeshBasicMaterial({
        name: 'su_hidden_line_terrain',
        color: 0xeef2f6,
        polygonOffset: true,
        polygonOffsetFactor: 2.0,
        polygonOffsetUnits: 2.0,
      });
      this._sharedHiddenWaterMat = new THREE.MeshBasicMaterial({
        name: 'su_hidden_line_water',
        color: 0xe0ecf5,
        polygonOffset: true,
        polygonOffsetFactor: 2.0,
        polygonOffsetUnits: 2.0,
      });

      this._savedSceneBackground = null;
      this._savedSkyVisible = true;
      this._savedFog = null;

      // Trạng thái công cụ đo 3D
      this.measureRecords = []; // { id, kind, group, labelEl, points, valueText }
      this.measureDraft = null; // { kind, points: Vector3[], previewLine, previewPointsGroup }
      this.snapMarker = this._createSnapMarker();
      this.engine.scene.add(this.snapMarker);

      // Các phần tử DOM
      this.dom = {};
      this._toastTimer = null;
      this._pieOpen = false;
      this._pieHoveredCmd = null;

      this._buildDynamicUiRefs();
      this._bindUiEvents();
      this._renderToolbar();
      this._renderSceneTabs();
      this._renderShortcutTable('');
      this._applyModeUi();
      this._recordViewSnapshot(true);
    }

    _resolveInitialMode() {
      try {
        const params = new URLSearchParams(window.location.search || '');
        const urlMode = params.get('controls');
        if (urlMode === 'sketchup' || urlMode === 'default') return urlMode;
        const saved = localStorage.getItem(STORAGE_MODE_KEY);
        if (saved === 'sketchup' || saved === 'default') return saved;
      } catch (_) {}
      return 'default';
    }

    isSketchupMode() {
      return this.mode === 'sketchup';
    }

    setMode(nextMode, silent = false) {
      const normalized = nextMode === 'sketchup' ? 'sketchup' : 'default';
      if (normalized === this.mode && !silent) return;
      this.mode = normalized;
      try {
        localStorage.setItem(STORAGE_MODE_KEY, normalized);
      } catch (_) {}

      if (normalized === 'default') {
        this._cleanupSketchupTransientStates();
        if (this.isParallel) this.setParallelProjection(false, true);
        if (this.isTwoPoint) this.setTwoPointPerspective(false, true);
        if (this.xrayEnabled) this.xrayEnabled = false;
        if (this.edgesEnabled) this.edgesEnabled = false;
        if (this.backEdgesEnabled) this.backEdgesEnabled = false;
        if (this.dialogsHidden) this.dialogsHidden = false;
        if (this.faceStyle !== 'textures') {
          this.setFaceStyle('textures', true);
        } else {
          this.applyVisualStylesToScene();
          this._rebuildEdgeOverlay(false);
        }
      } else {
        this.setActiveTool('select', true);
      }

      this._applyModeUi();
      if (!silent) {
        this.showToast(
          normalized === 'sketchup'
            ? '📐 Đã bật Chế độ SketchUp (chuột giữa Orbit, Shift+Giữa Pan, Ctrl+1..6, F2..F8, K, Space...)'
            : '🖱 Đã chuyển về Chế độ Đà Lạt Mặc định (WASD + Chuột trái Orbit)'
        );
      }
    }

    toggleMode() {
      this.setMode(this.mode === 'sketchup' ? 'default' : 'sketchup');
    }

    _cleanupSketchupTransientStates() {
      this.dragKind = null;
      this.activePointers.clear();
      this.arrowKeys.clear();
      this._cancelMeasureDraft();
      this._hideZoomBox();
      this.closePieMenu();
      this.snapMarker.visible = false;
    }

    _createSnapMarker() {
      const geo = new THREE.SphereGeometry(1.0, 12, 10);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x22c55e,
        depthTest: false,
        transparent: true,
        opacity: 0.92,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 999;
      return m;
    }

    _buildDynamicUiRefs() {
      const ids = [
        'quick-nav-mode-btn',
        'quick-nav-mode-label',
        'quick-su-help-btn',
        'mode-btn-default',
        'mode-btn-sketchup',
        'su-panel-extras',
        'open-su-shortcuts-btn',
        'open-su-pie-btn',
        'su-toolbar',
        'su-scene-bar',
        'su-vcb-bar',
        'su-vcb-tool',
        'su-vcb-label',
        'su-vcb-value',
        'su-zoom-box',
        'su-toast',
        'su-pie-menu',
        'su-shortcuts-modal',
        'su-shortcuts-close',
        'su-shortcuts-search',
        'su-shortcuts-tbody',
        'su-label-layer',
        'controls-hint-bar',
      ];
      for (const id of ids) {
        this.dom[id] = document.getElementById(id);
      }
    }

    _bindUiEvents() {
      const bindClick = (id, fn) => {
        if (this.dom[id]) this.dom[id].addEventListener('click', fn);
      };
      bindClick('quick-nav-mode-btn', () => this.toggleMode());
      bindClick('mode-btn-default', () => this.setMode('default'));
      bindClick('mode-btn-sketchup', () => this.setMode('sketchup'));
      bindClick('quick-su-help-btn', () => this.toggleShortcutsModal());
      bindClick('open-su-shortcuts-btn', () => this.toggleShortcutsModal(true));
      bindClick('open-su-pie-btn', () => {
        if (!this.isSketchupMode()) this.setMode('sketchup');
        this.togglePieMenu(window.innerWidth * 0.5, window.innerHeight * 0.45);
      });
      bindClick('su-shortcuts-close', () => this.toggleShortcutsModal(false));

      if (this.dom['su-shortcuts-modal']) {
        this.dom['su-shortcuts-modal'].addEventListener('click', (e) => {
          if (e.target === this.dom['su-shortcuts-modal']) this.toggleShortcutsModal(false);
        });
      }
      if (this.dom['su-shortcuts-search']) {
        this.dom['su-shortcuts-search'].addEventListener('input', (e) => {
          this._renderShortcutTable(e.target.value || '');
        });
      }

      if (this.dom['su-pie-menu']) {
        this.dom['su-pie-menu'].addEventListener('click', (e) => {
          if (e.target === this.dom['su-pie-menu']) this.closePieMenu();
        });
      }
    }

    _renderToolbar() {
      const bar = this.dom['su-toolbar'];
      if (!bar) return;
      const toolOrder = [
        'select',
        'orbit',
        'pan',
        'zoom',
        'zoom_window',
        'look_around',
        'position_camera',
        'walk',
        'measure',
        'dimension',
        'protractor',
        'eraser',
        'paint',
      ];
      const toolButtonsHtml = toolOrder
        .map((id) => {
          const meta = TOOL_META[id];
          return `<button type="button" class="su-tool-btn${this.activeTool === id ? ' active' : ''}" data-su-tool="${id}" title="${meta.label} (${meta.shortcut}) — ${meta.hint}">${TOOL_ICONS[id] || ''}<span class="su-tool-kbd">${meta.shortcut.split(' ')[0]}</span></button>`;
        })
        .join('');

      const viewButtonsHtml = `
        <div class="su-sep"></div>
        <button type="button" class="su-tool-btn su-mini-txt" data-su-cmd="zoom_extents" title="Zoom Extents (Shift+Z)">⤢</button>
        <button type="button" class="su-tool-btn su-mini-txt" data-su-cmd="view_top" title="Top View (Ctrl+1)">T</button>
        <button type="button" class="su-tool-btn su-mini-txt" data-su-cmd="view_iso" title="Iso View (Shift+I)">Iso</button>
        <button type="button" class="su-tool-btn su-mini-txt" id="su-btn-parallel" data-su-cmd="toggle_parallel" title="Parallel Projection (\`)">∥</button>
        <button type="button" class="su-tool-btn su-mini-txt" id="su-btn-twopoint" data-su-cmd="toggle_twopoint" title="Two-Point Perspective (\\)">2P</button>
        <button type="button" class="su-tool-btn su-mini-txt" id="su-btn-xray" data-su-cmd="toggle_xray" title="X-Ray (F7)">X</button>
        <button type="button" class="su-tool-btn su-mini-txt" id="su-btn-edges" data-su-cmd="toggle_edges" title="Edges (F8)">□</button>
        <button type="button" class="su-tool-btn su-mini-txt" data-su-cmd="add_scene" title="Thêm Scene (Ctrl+Shift+A)">+Sc</button>
        <button type="button" class="su-tool-btn su-mini-txt" data-su-cmd="pie_menu" title="Curic Pie Menu (Alt+1)">◔</button>
        <button type="button" class="su-tool-btn su-mini-txt" data-su-cmd="shortcuts_help" title="Bảng Phím tắt SketchUp (Shift+S)">?</button>
      `;

      bar.innerHTML = `<div class="su-toolbar-scroll">${toolButtonsHtml}${viewButtonsHtml}</div>`;

      bar.querySelectorAll('[data-su-tool]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.setActiveTool(btn.dataset.suTool);
        });
      });
      bar.querySelectorAll('[data-su-cmd]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          this.runQuickCommand(btn.dataset.suCmd, e);
        });
      });
    }

    runQuickCommand(cmd, ev) {
      switch (cmd) {
        case 'zoom_extents':
          this.zoomExtents();
          break;
        case 'view_top':
          this.applyStandardView('top');
          break;
        case 'view_front':
          this.applyStandardView('front');
          break;
        case 'view_back':
          this.applyStandardView('back');
          break;
        case 'view_left':
          this.applyStandardView('left');
          break;
        case 'view_right':
          this.applyStandardView('right');
          break;
        case 'view_bottom':
          this.applyStandardView('bottom');
          break;
        case 'view_iso':
          this.applyStandardView('iso');
          break;
        case 'toggle_parallel':
          this.toggleParallelProjection();
          break;
        case 'toggle_twopoint':
          this.toggleTwoPointPerspective();
          break;
        case 'toggle_xray':
          this.toggleXray();
          break;
        case 'toggle_edges':
          this.toggleEdges();
          break;
        case 'toggle_back_edges':
          this.toggleBackEdges();
          break;
        case 'add_scene':
          this.addScene();
          break;
        case 'prev_view':
          this.navigateHistory(-1);
          break;
        case 'next_view':
          this.navigateHistory(1);
          break;
        case 'pie_menu':
          this.togglePieMenu(
            ev ? ev.clientX : window.innerWidth * 0.5,
            ev ? ev.clientY : window.innerHeight * 0.45
          );
          break;
        case 'style_textures':
          this.setFaceStyle('textures');
          break;
        case 'style_shaded':
          this.setFaceStyle('shaded');
          break;
        case 'style_monochrome':
          this.setFaceStyle('monochrome');
          break;
        case 'style_wireframe':
          this.setFaceStyle('wireframe');
          break;
        case 'style_hidden':
          this.setFaceStyle('hidden_line');
          break;
        case 'toggle_shadows':
          this.toggleShadows();
          break;
        case 'shortcuts_help':
          this.toggleShortcutsModal();
          break;
        default:
          break;
      }
    }

    _applyModeUi() {
      const isSu = this.isSketchupMode();
      document.body.classList.toggle('su-mode-active', isSu);
      document.body.classList.toggle('su-dialogs-hidden', isSu && this.dialogsHidden);

      if (this.dom['quick-nav-mode-btn']) {
        this.dom['quick-nav-mode-btn'].classList.toggle('is-active', isSu);
        this.dom['quick-nav-mode-btn'].setAttribute('aria-pressed', String(isSu));
      }
      if (this.dom['quick-nav-mode-label']) {
        this.dom['quick-nav-mode-label'].textContent = isSu ? 'Chế độ: SketchUp' : 'Chế độ: Mặc định';
      }
      if (this.dom['mode-btn-default']) {
        this.dom['mode-btn-default'].classList.toggle('active', !isSu);
      }
      if (this.dom['mode-btn-sketchup']) {
        this.dom['mode-btn-sketchup'].classList.toggle('active', isSu);
      }
      if (this.dom['su-panel-extras']) {
        this.dom['su-panel-extras'].classList.toggle('hidden', !isSu);
      }
      if (this.dom['su-toolbar']) {
        this.dom['su-toolbar'].classList.toggle('hidden', !isSu);
        if (isSu && window.innerWidth > 900) {
          const brandEl = document.querySelector('.hud-brand');
          if (brandEl) {
            const br = brandEl.getBoundingClientRect();
            this.dom['su-toolbar'].style.top = `${Math.round(br.bottom + 10)}px`;
          }
        } else if (window.innerWidth <= 900) {
          this.dom['su-toolbar'].style.top = '';
        }
      }
      if (this.dom['su-vcb-bar']) {
        this.dom['su-vcb-bar'].classList.toggle('hidden', !isSu);
      }
      if (this.dom['su-scene-bar']) {
        this.dom['su-scene-bar'].classList.toggle('hidden', !isSu || this.scenes.length === 0);
      }
      if (this.dom['controls-hint-bar']) {
        this.dom['controls-hint-bar'].innerHTML = isSu
          ? [
              '<span><strong>Giữa:</strong> Orbit</span>',
              '<span><strong>Shift+Giữa / Phải:</strong> Pan</span>',
              '<span><strong>Cuộn:</strong> Zoom</span>',
              '<span><strong>Space/O/Z/N/I:</strong> Select/Orbit/Zoom/Look/Walk</span>',
              '<span><strong>Ctrl+1..6 / `:</strong> Góc nhìn / Song song</span>',
              '<span><strong>F2..F8 / K / Shift+S:</strong> Kiểu mặt &amp; Phím tắt</span>',
            ].join('')
          : [
              '<span><strong>Click công trình:</strong> Xem kiến trúc</span>',
              '<span><strong>Xoay:</strong> Chuột trái / giữa</span>',
              '<span><strong>Pan:</strong> Shift + Giữa / Phải</span>',
              '<span><strong>Zoom:</strong> Cuộn chuột</span>',
              '<span><strong>Flycam:</strong> W A S D + Q E</span>',
              '<span><strong>Phím F / G:</strong> Sương mù / Đồ họa</span>',
            ].join('');
      }
      this._syncToolbarStates();
      this._syncVcb();
    }

    _syncToolbarStates() {
      const bar = this.dom['su-toolbar'];
      if (bar) {
        bar.querySelectorAll('[data-su-tool]').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.suTool === this.activeTool);
        });
      }
      const toggleCls = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', Boolean(on));
      };
      toggleCls('su-btn-parallel', this.isParallel);
      toggleCls('su-btn-twopoint', this.isTwoPoint);
      toggleCls('su-btn-xray', this.xrayEnabled);
      toggleCls('su-btn-edges', this.edgesEnabled);

      const vp = this.engine.container;
      if (vp && this.isSketchupMode()) {
        vp.dataset.suTool = this.activeTool;
      } else if (vp) {
        delete vp.dataset.suTool;
      }
    }

    setActiveTool(toolId, silent = false) {
      if (!TOOL_META[toolId]) return;
      if (this.activeTool !== toolId) {
        this._cancelMeasureDraft();
        this._hideZoomBox();
      }
      this.activeTool = toolId;
      this.snapMarker.visible = ['measure', 'dimension', 'protractor', 'position_camera'].includes(toolId);
      if (!this.snapMarker.visible) this.snapMarker.visible = false;
      this._syncToolbarStates();
      this._syncVcb();
      if (!silent) {
        const m = TOOL_META[toolId];
        this.showToast(`🛠 ${m.label} (${m.shortcut})`);
      }
    }

    _syncVcb(customLabel, customValue) {
      const tEl = this.dom['su-vcb-tool'];
      const lEl = this.dom['su-vcb-label'];
      const vEl = this.dom['su-vcb-value'];
      if (!tEl || !lEl || !vEl) return;

      const meta = TOOL_META[this.activeTool] || TOOL_META.select;
      tEl.textContent = `${meta.label} (${meta.shortcut})`;
      if (customLabel != null && customValue != null) {
        lEl.textContent = customLabel;
        vEl.textContent = customValue;
        return;
      }
      if (this.selectedEntity && this.activeTool === 'select') {
        lEl.textContent = 'Đang chọn';
        vEl.textContent = this.selectedEntity.summary || this.selectedEntity.name;
        return;
      }
      const elev = (this.engine.camera.position.y + window.DALAT_COORDS.Z0_MSL).toFixed(1);
      lEl.textContent = this.isParallel ? 'Song song' : this.isTwoPoint ? '2 Điểm tụ' : 'Tâm/Cao độ';
      vEl.textContent = `FOV ${Math.round(this.perspCamera.fov)}° • ${elev}m MSL`;
    }

    showToast(msg, durationMs = 2400) {
      const el = this.dom['su-toast'];
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('hidden');
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        el.classList.add('hidden');
      }, durationMs);
    }

    /* ========================================================================
     * XỬ LÝ CHUỘT & PHÍM TẮT TRONG CHẾ ĐỘ SKETCHUP
     * ======================================================================== */

    onPointerDown(e) {
      const dom = this.engine.renderer.domElement;
      if (this.engine.minimapHud && this.engine.minimapHud.tourActive) {
        this.engine.minimapHud.stopTour();
      }
      this.engine.flightAnim = null;
      this.lastMouseScreen = { x: e.clientX, y: e.clientY };

      if (this._pieOpen) {
        this.closePieMenu();
      }

      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button });
      try {
        dom.setPointerCapture(e.pointerId);
      } catch (_) {}

      if (this.activePointers.size >= 2) {
        this.dragKind = 'pinch';
        this.pinchState = this._getPinchMetrics();
        this.engine.container.classList.add('is-dragging');
        return;
      }

      this.downButtonsMask = e.buttons || (e.button === 1 ? 4 : e.button === 2 ? 2 : 1);
      this.pointerDownClient = { x: e.clientX, y: e.clientY };
      this.lastClient = { x: e.clientX, y: e.clientY };

      // Quy chuẩn chuột SketchUp:
      // - MMB (button 1) + Shift hoặc MMB + LMB đồng thời hoặc RMB (button 2): Pan tức thời
      // - MMB (button 1): Orbit tức thời
      const bothLeftAndMid = (this.downButtonsMask & 1) !== 0 && (this.downButtonsMask & 4) !== 0;
      if (e.button === 2 || (e.button === 1 && e.shiftKey) || bothLeftAndMid) {
        this.dragKind = 'pan';
        this.tempRevertTool = true;
        this.engine.container.classList.add('is-dragging');
        return;
      }
      if (e.button === 1) {
        this.dragKind = 'orbit';
        this.tempRevertTool = true;
        const hit = this.engine._raycastPoint(e.clientX, e.clientY);
        if (hit) this.engine.target.copy(hit);
        this.engine.container.classList.add('is-dragging');
        return;
      }

      if (e.button === 0 || e.pointerType === 'touch') {
        this.tempRevertTool = false;
        switch (this.activeTool) {
          case 'orbit': {
            this.dragKind = 'orbit';
            if (e.pointerType !== 'touch') {
              const hit = this.engine._raycastPoint(e.clientX, e.clientY);
              if (hit) this.engine.target.copy(hit);
            }
            this.engine.container.classList.add('is-dragging');
            break;
          }
          case 'pan':
            this.dragKind = 'pan';
            this.engine.container.classList.add('is-dragging');
            break;
          case 'zoom':
            this.dragKind = 'zoom_drag';
            this.zoomAnchor = this.engine._raycastPoint(e.clientX, e.clientY) || this.engine.target.clone();
            this.engine.container.classList.add('is-dragging');
            break;
          case 'zoom_window':
            this.dragKind = 'zoom_window';
            this.zoomWindowStart = { x: e.clientX, y: e.clientY };
            this._updateZoomBox(e.clientX, e.clientY, e.clientX, e.clientY);
            break;
          case 'look_around':
            this.dragKind = 'look_around';
            this.engine.container.classList.add('is-dragging');
            break;
          case 'position_camera':
            this.dragKind = 'position_camera';
            this.posCamStartHit = this.engine._raycastPoint(e.clientX, e.clientY);
            break;
          case 'walk':
            this.dragKind = 'walk_drag';
            this.engine.container.classList.add('is-dragging');
            break;
          case 'select':
          default:
            this.dragKind = 'select_pending';
            break;
        }
      }
    }

    onPointerMove(e) {
      this.lastMouseScreen = { x: e.clientX, y: e.clientY };
      if (this.activePointers.has(e.pointerId)) {
        const prev = this.activePointers.get(e.pointerId);
        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: prev.button });
      }

      if (this.activePointers.size >= 2) {
        const nextPinch = this._getPinchMetrics();
        if (nextPinch && this.pinchState) {
          const mdx = nextPinch.midX - this.pinchState.midX;
          const mdy = nextPinch.midY - this.pinchState.midY;
          if (Math.abs(mdx) > 0.2 || Math.abs(mdy) > 0.2) this._panCamera(mdx, mdy);
          const distDelta = nextPinch.dist - Math.max(12, this.pinchState.dist);
          if (Math.abs(distDelta) > 0.5) {
            this._applyZoomDelta(distDelta * 0.004, nextPinch.midX, nextPinch.midY);
          }
        }
        this.pinchState = nextPinch;
        return;
      }

      // Kiểm tra chuyển động giữa chừng khi giữ thêm LMB trong lúc giữ MMB -> chuyển Orbit thành Pan chuẩn SketchUp
      if (this.dragKind === 'orbit' && this.tempRevertTool && (e.buttons & 1) !== 0 && (e.buttons & 4) !== 0) {
        this.dragKind = 'pan';
      }

      const dx = e.clientX - this.lastClient.x;
      const dy = e.clientY - this.lastClient.y;
      this.lastClient = { x: e.clientX, y: e.clientY };

      if (!this.dragKind || this.dragKind === 'select_pending') {
        if (e.pointerType !== 'touch') {
          this._handleHover(e.clientX, e.clientY);
        }
        return;
      }

      if (this.dragKind === 'orbit') {
        this._orbitCamera(dx, dy);
      } else if (this.dragKind === 'pan') {
        this._panCamera(dx, dy);
      } else if (this.dragKind === 'zoom_drag') {
        this._applyZoomDelta(-dy * 0.0085, this.pointerDownClient.x, this.pointerDownClient.y);
      } else if (this.dragKind === 'zoom_window' && this.zoomWindowStart) {
        this._updateZoomBox(this.zoomWindowStart.x, this.zoomWindowStart.y, e.clientX, e.clientY);
      } else if (this.dragKind === 'look_around') {
        this._lookAround(dx, dy);
      } else if (this.dragKind === 'walk_drag') {
        this._walkDrag(dx, dy);
      } else if (this.dragKind === 'position_camera') {
        this._updateSnapAtClient(e.clientX, e.clientY);
      }
    }

    onPointerUp(e) {
      const dom = this.engine.renderer.domElement;
      const wasPinch = this.dragKind === 'pinch';
      this.activePointers.delete(e.pointerId);
      try {
        dom.releasePointerCapture(e.pointerId);
      } catch (_) {}

      if (this.activePointers.size === 1) {
        const rem = Array.from(this.activePointers.values())[0];
        this.lastClient = { x: rem.x, y: rem.y };
        this.dragKind = 'orbit';
        this.pinchState = null;
        return;
      }

      const movedDist = Math.hypot(e.clientX - this.pointerDownClient.x, e.clientY - this.pointerDownClient.y);
      const finishedKind = this.dragKind;
      this.dragKind = null;
      this.pinchState = null;
      this.engine.container.classList.remove('is-dragging');

      if (wasPinch) return;

      if (finishedKind === 'zoom_window' && this.zoomWindowStart) {
        this._hideZoomBox();
        this._commitZoomWindow(this.zoomWindowStart, { x: e.clientX, y: e.clientY });
        this.zoomWindowStart = null;
        return;
      }

      if (finishedKind === 'position_camera' && e.type === 'pointerup') {
        this._commitPositionCamera(e.clientX, e.clientY, movedDist);
        return;
      }

      if (finishedKind === 'orbit' || finishedKind === 'pan' || finishedKind === 'zoom_drag' || finishedKind === 'look_around') {
        this._recordViewSnapshot();
      }

      // Click đơn (< 7px) với chuột trái theo tool
      if (e.type === 'pointerup' && (e.button === 0 || e.pointerType === 'touch') && movedDist < 7.0) {
        if (this.activeTool === 'select') {
          this._handleSelectClick(e.clientX, e.clientY);
        } else if (this.activeTool === 'measure' || this.activeTool === 'dimension' || this.activeTool === 'protractor') {
          this._handleMeasureClick(this.activeTool, e.clientX, e.clientY);
        } else if (this.activeTool === 'eraser') {
          this._handleEraserClick(e.clientX, e.clientY);
        } else if (this.activeTool === 'paint') {
          this._handlePaintInspectClick(e.clientX, e.clientY);
        }
      }
    }

    onWheel(e) {
      e.preventDefault();
      if (this.engine.minimapHud && this.engine.minimapHud.tourActive) {
        this.engine.minimapHud.stopTour();
      }
      this.engine.flightAnim = null;
      const factor = e.deltaY < 0 ? 0.16 : -0.19;
      this._applyZoomDelta(factor, e.clientX, e.clientY);
      this._scheduleHistorySnapshot();
    }

    onKeyDown(e) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        if (e.code === 'Escape' && this.dom['su-shortcuts-modal'] && !this.dom['su-shortcuts-modal'].classList.contains('hidden')) {
          this.toggleShortcutsModal(false);
        }
        return false;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      const alt = e.altKey;
      const shift = e.shiftKey;
      const code = e.code;

      // Phím mũi tên cho Walk / Orbit mượt
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code) && !ctrl && !alt) {
        if (this.activeTool === 'walk' || code.startsWith('Arrow')) {
          this.arrowKeys.add(code);
          if (code.startsWith('Arrow')) return true;
        }
      }

      if (code === 'Escape') {
        if (this._pieOpen) {
          this.closePieMenu();
          return true;
        }
        if (this.dom['su-shortcuts-modal'] && !this.dom['su-shortcuts-modal'].classList.contains('hidden')) {
          this.toggleShortcutsModal(false);
          return true;
        }
        if (this.measureDraft) {
          this._cancelMeasureDraft();
          this.showToast('Đã hủy phép đo đang thực hiện');
          return true;
        }
        if (this.isolatedState) {
          this.exitIsolation();
          return true;
        }
        if (this.selectedEntity) {
          this.clearSelection();
          return true;
        }
        if (this.engine.minimapHud) {
          this.engine.minimapHud.hideLandmarkPopup();
          if (this.engine.minimapHud.tourActive) this.engine.minimapHud.stopTour();
        }
        return true;
      }

      // Chặn F2..F8 của trình duyệt khi ở chế độ SketchUp
      if (/^F[2-8]$/.test(code) && !ctrl && !alt && !shift) {
        e.preventDefault();
        if (code === 'F2') this.setFaceStyle('textures');
        else if (code === 'F3') this.setFaceStyle('shaded');
        else if (code === 'F4') this.setFaceStyle('monochrome');
        else if (code === 'F5') this.setFaceStyle('wireframe');
        else if (code === 'F6') this.setFaceStyle('hidden_line');
        else if (code === 'F7') this.toggleXray();
        else if (code === 'F8') this.toggleEdges();
        return true;
      }

      // Góc nhìn chuẩn Ctrl+1..6 (hỗ trợ cả Digit và Numpad)
      if (ctrl && !alt && !shift) {
        const viewMap = {
          Digit1: 'top',
          Numpad1: 'top',
          Digit2: 'front',
          Numpad2: 'front',
          Digit3: 'back',
          Numpad3: 'back',
          Digit4: 'left',
          Numpad4: 'left',
          Digit5: 'right',
          Numpad5: 'right',
          Digit6: 'bottom',
          Numpad6: 'bottom',
        };
        if (viewMap[code]) {
          e.preventDefault();
          this.applyStandardView(viewMap[code]);
          return true;
        }
      }

      // Ẩn/hiện UI: Ctrl+H / Ctrl+D
      if (ctrl && !alt && !shift && (code === 'KeyH' || code === 'KeyD')) {
        e.preventDefault();
        this.toggleDialogsHidden();
        return true;
      }

      // Zoom Window: Ctrl+Shift+Z
      if (ctrl && !alt && shift && code === 'KeyZ') {
        e.preventDefault();
        this.setActiveTool('zoom_window');
        return true;
      }

      // Add Scene: Ctrl+Shift+A
      if (ctrl && !alt && shift && code === 'KeyA') {
        e.preventDefault();
        this.addScene();
        return true;
      }

      // Ctrl+Alt+T: Tape Measure
      if (ctrl && alt && !shift && code === 'KeyT') {
        e.preventDefault();
        this.setActiveTool('measure');
        return true;
      }

      // Ctrl+Alt+Shift+A: Align View By Face/Selection
      if (ctrl && alt && shift && code === 'KeyA') {
        e.preventDefault();
        this.alignViewByCursorOrSelection();
        return true;
      }

      // Ctrl+Alt+Shift+L: Layers
      if (ctrl && alt && shift && code === 'KeyL') {
        e.preventDefault();
        this.focusLayersPanel();
        return true;
      }

      // Alt+Shift+S hoặc Ctrl+Alt+Shift+S: Shadows
      if (!ctrl && alt && shift && code === 'KeyS') {
        e.preventDefault();
        this.toggleShadows();
        return true;
      }
      if (ctrl && alt && shift && code === 'KeyS') {
        e.preventDefault();
        this.toggleShadows();
        return true;
      }

      // Alt+Shift+X: Zoom Selection
      if (!ctrl && alt && shift && code === 'KeyX') {
        e.preventDefault();
        this.zoomSelection();
        return true;
      }

      // Alt+1 / Alt+V / Alt+Shift+1: Curic Pie Menu
      if (!ctrl && alt && !shift && (code === 'Digit1' || code === 'KeyV' || code === 'F1')) {
        e.preventDefault();
        this.togglePieMenu(this.lastMouseScreen.x, this.lastMouseScreen.y);
        return true;
      }
      if (!ctrl && alt && shift && code === 'Digit1') {
        e.preventDefault();
        this.togglePieMenu(this.lastMouseScreen.x, this.lastMouseScreen.y);
        return true;
      }

      // Alt+D: Position Camera
      if (!ctrl && alt && !shift && code === 'KeyD') {
        e.preventDefault();
        this.setActiveTool('position_camera');
        return true;
      }

      // Alt+`: Pan (Dolly Tool trong .bak)
      if (!ctrl && alt && !shift && code === 'Backquote') {
        e.preventDefault();
        this.setActiveTool('pan');
        return true;
      }

      // Ctrl+`: Look Around (selectTurnTool trong .bak)
      if (ctrl && !alt && !shift && code === 'Backquote') {
        e.preventDefault();
        this.setActiveTool('look_around');
        return true;
      }

      // Alt+Q: Isolate Selection
      if (!ctrl && alt && !shift && code === 'KeyQ') {
        e.preventDefault();
        this.toggleIsolateSelection();
        return true;
      }

      // Alt+U / Alt+J: Unhide Last
      if (!ctrl && alt && !shift && (code === 'KeyU' || code === 'KeyJ')) {
        e.preventDefault();
        this.unhideLast();
        return true;
      }

      // Lịch sử View: PageUp / PageDown
      if (!ctrl && !alt && !shift && (code === 'PageUp' || code === 'PageDown')) {
        e.preventDefault();
        this.navigateHistory(code === 'PageUp' ? -1 : 1);
        return true;
      }

      // Các phím có Shift (không Ctrl/Alt)
      if (!ctrl && !alt && shift) {
        if (code === 'KeyZ') {
          e.preventDefault();
          this.zoomExtents();
          return true;
        }
        if (code === 'KeyI') {
          e.preventDefault();
          this.applyStandardView('iso');
          return true;
        }
        if (code === 'KeyS') {
          e.preventDefault();
          this.toggleShortcutsModal();
          return true;
        }
        if (code === 'KeyH') {
          e.preventDefault();
          this.unhideLast();
          return true;
        }
        if (code === 'KeyU') {
          e.preventDefault();
          this.unhideAll();
          return true;
        }
        if (code === 'Semicolon') {
          e.preventDefault();
          this.cycleNextScene();
          return true;
        }
      }

      // Phím đơn không modifier
      if (!ctrl && !alt && !shift && !e.repeat) {
        switch (code) {
          case 'Space':
            e.preventDefault();
            this.setActiveTool('select');
            return true;
          case 'KeyO':
            this.setActiveTool('orbit');
            return true;
          case 'KeyZ':
            this.setActiveTool('zoom');
            return true;
          case 'KeyN':
            this.setActiveTool('look_around');
            return true;
          case 'KeyI':
            this.setActiveTool('walk');
            return true;
          case 'KeyH':
            if (this.selectedEntity) {
              this.hideSelected();
            } else {
              this.setActiveTool('pan');
              this.showToast('✋ Pan Tool (Alt+` cũng là Pan • Chọn công trình + H để Ẩn)');
            }
            return true;
          case 'KeyU':
            this.unhideLast();
            return true;
          case 'KeyT':
            if (this.selectedEntity || this.isolatedState) {
              this.toggleIsolateSelection();
            } else {
              this.setActiveTool('measure');
              this.showToast('📏 Tape Measure (Ctrl+Alt+T) — Chọn công trình + T để cô lập');
            }
            return true;
          case 'KeyD':
            if (this.activeTool !== 'walk') {
              this.setActiveTool('dimension');
              return true;
            }
            break;
          case 'KeyX':
            this.setActiveTool('protractor');
            return true;
          case 'KeyE':
            this.setActiveTool('eraser');
            return true;
          case 'KeyB':
            this.setActiveTool('paint');
            return true;
          case 'KeyK':
            this.toggleBackEdges();
            return true;
          case 'Backquote':
            e.preventDefault();
            this.toggleParallelProjection();
            return true;
          case 'Backslash':
            e.preventDefault();
            this.toggleTwoPointPerspective();
            return true;
          case 'KeyF':
            this.engine.toggleFog();
            this.showToast(this.engine.fogEnabled ? '☁ Sương mù Đà Lạt: BẬT (F)' : '☀ Sương mù Đà Lạt: TẮT (F)');
            return true;
          case 'KeyG':
            this.engine.cycleQualityPreset();
            if (this.engine.realtime) {
              const st = this.engine.realtime.getStatusSummary();
              this.showToast(`✦ Đồ họa: ${st.label_vi} (G)`);
            }
            return true;
          default:
            break;
        }
      }
      return false;
    }

    onKeyUp(e) {
      this.arrowKeys.delete(e.code);
    }

    update(dt) {
      if (!this.isSketchupMode()) return;

      // Xử lý di chuyển Walk (mũi tên hoặc WASD khi đang ở Walk Tool)
      const isWalk = this.activeTool === 'walk';
      const hasMove =
        this.arrowKeys.has('ArrowUp') ||
        this.arrowKeys.has('ArrowDown') ||
        this.arrowKeys.has('ArrowLeft') ||
        this.arrowKeys.has('ArrowRight') ||
        (isWalk &&
          (this.arrowKeys.has('KeyW') ||
            this.arrowKeys.has('KeyS') ||
            this.arrowKeys.has('KeyA') ||
            this.arrowKeys.has('KeyD')));

      if (hasMove) {
        const cam = this.engine.camera;
        const fwd = new THREE.Vector3();
        cam.getWorldDirection(fwd);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

        const moveSpeed = isWalk ? 26.0 * dt : Math.max(24.0, cam.position.distanceTo(this.engine.target) * 0.35) * dt;
        const delta = new THREE.Vector3();

        if (this.arrowKeys.has('ArrowUp') || (isWalk && this.arrowKeys.has('KeyW'))) {
          delta.addScaledVector(fwd, moveSpeed);
        }
        if (this.arrowKeys.has('ArrowDown') || (isWalk && this.arrowKeys.has('KeyS'))) {
          delta.addScaledVector(fwd, -moveSpeed);
        }
        if (isWalk) {
          if (this.arrowKeys.has('ArrowLeft')) this._lookAround(2.8, 0);
          if (this.arrowKeys.has('ArrowRight')) this._lookAround(-2.8, 0);
          if (this.arrowKeys.has('KeyA')) delta.addScaledVector(right, -moveSpeed);
          if (this.arrowKeys.has('KeyD')) delta.addScaledVector(right, moveSpeed);
        } else {
          if (this.arrowKeys.has('ArrowLeft')) delta.addScaledVector(right, -moveSpeed);
          if (this.arrowKeys.has('ArrowRight')) delta.addScaledVector(right, moveSpeed);
        }

        if (delta.lengthSq() > 0) {
          cam.position.add(delta);
          this.engine.target.add(delta);
          if (isWalk) {
            this._snapCameraToGroundEyeHeight(cam.position.x, cam.position.z, 1.7);
          }
          cam.lookAt(this.engine.target);
          this.engine._updateGpsHud(this.engine.target);
          this._syncVcb();
        }
      }

      // Cập nhật vị trí nhãn 2D nổi của các phép đo 3D
      this._updateMeasureScreenLabels();
    }

    /* ========================================================================
     * ĐIỀU KHIỂN CAMERA CHÍNH XÁC (ORBIT, PAN, ZOOM, LOOK AROUND, WALK, VIEWS)
     * ======================================================================== */

    _getPinchMetrics() {
      const pts = Array.from(this.activePointers.values());
      if (pts.length < 2) return null;
      return {
        dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
        midX: (pts[0].x + pts[1].x) * 0.5,
        midY: (pts[0].y + pts[1].y) * 0.5,
      };
    }

    _orbitCamera(dx, dy) {
      const cam = this.engine.camera;
      if (this.isTwoPoint) {
        // Two-Point Perspective: chỉ xoay ngang, kéo dọc dịch chân trời không làm nghiêng nhà
        const offset = new THREE.Vector3().subVectors(cam.position, this.engine.target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta -= dx * 0.0055;
        spherical.phi = Math.PI * 0.5;
        offset.setFromSpherical(spherical);
        cam.position.copy(this.engine.target).add(offset);
        this.twoPointShiftY = THREE.MathUtils.clamp(this.twoPointShiftY - dy * 1.4, -window.innerHeight * 0.45, window.innerHeight * 0.45);
        this._applyTwoPointViewOffset();
        cam.lookAt(this.engine.target);
        return;
      }

      cam.up.set(0, 1, 0);
      const offset = new THREE.Vector3().subVectors(cam.position, this.engine.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * 0.0055;
      spherical.phi -= dy * 0.0055;
      spherical.phi = Math.max(0.03, Math.min(Math.PI - 0.03, spherical.phi));
      offset.setFromSpherical(spherical);
      cam.position.copy(this.engine.target).add(offset);
      if (!this.isParallel && cam.position.y < 2.2) cam.position.y = 2.2;
      cam.lookAt(this.engine.target);
    }

    _panCamera(dx, dy) {
      const cam = this.engine.camera;
      if (this.isParallel) {
        const aspect = window.innerWidth / Math.max(1, window.innerHeight);
        const worldPerPxY = (this.orthoHalfHeight * 2.0) / Math.max(1, window.innerHeight);
        const worldPerPxX = (this.orthoHalfHeight * 2.0 * aspect) / Math.max(1, window.innerWidth);
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const camUp = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
        const move = new THREE.Vector3()
          .addScaledVector(right, -dx * worldPerPxX)
          .addScaledVector(camUp, dy * worldPerPxY);
        cam.position.add(move);
        this.engine.target.add(move);
        cam.lookAt(this.engine.target);
        this.engine._updateGpsHud(this.engine.target);
        return;
      }

      const dist = cam.position.distanceTo(this.engine.target);
      const speed = Math.max(0.15, dist * 0.00145);
      const forward = new THREE.Vector3();
      cam.getWorldDirection(forward);

      const isNearVertical = Math.abs(forward.y) > 0.92;
      const move = new THREE.Vector3();
      if (isNearVertical) {
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const camUp = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
        move.addScaledVector(right, -dx * speed).addScaledVector(camUp, dy * speed);
      } else {
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        move.addScaledVector(right, -dx * speed).addScaledVector(forward, dy * speed);
      }

      cam.position.add(move);
      this.engine.target.add(move);
      cam.lookAt(this.engine.target);
      this.engine._updateGpsHud(this.engine.target);
    }

    _applyZoomDelta(factor, clientX, clientY) {
      const cam = this.engine.camera;
      if (this.isParallel) {
        const aspect = window.innerWidth / Math.max(1, window.innerHeight);
        const rect = this.engine.renderer.domElement.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

        const oldHalfH = this.orthoHalfHeight;
        const scale = Math.exp(-factor);
        const newHalfH = THREE.MathUtils.clamp(oldHalfH * scale, 4.0, 22000.0);
        if (Math.abs(newHalfH - oldHalfH) < 1e-4) return;

        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const camUp = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
        const dH = oldHalfH - newHalfH;
        const dW = dH * aspect;
        const panAdjust = new THREE.Vector3()
          .addScaledVector(right, ndcX * dW)
          .addScaledVector(camUp, ndcY * dH);

        this.orthoHalfHeight = newHalfH;
        this._syncOrthoFrustum();
        cam.position.add(panAdjust);
        this.engine.target.add(panAdjust);
        cam.lookAt(this.engine.target);
        this._syncVcb('Song song', `Khung nhìn ${(newHalfH * 2).toFixed(0)}m`);
        return;
      }

      const hit = this.zoomAnchor || this.engine._raycastPoint(clientX, clientY) || this.engine.target;
      const vec = new THREE.Vector3().subVectors(hit, cam.position);
      const dist = vec.length();
      if (dist < 10 && factor > 0) return;
      if (dist > 22000 && factor < 0) return;

      const move = vec.multiplyScalar(THREE.MathUtils.clamp(factor, -0.35, 0.35));
      cam.position.add(move);
      if (factor > 0) {
        this.engine.target.lerp(hit, 0.22);
      }
      if (cam.position.y < 2.2) cam.position.y = 2.2;
      cam.lookAt(this.engine.target);
      this.engine._updateGpsHud(hit);
      this._syncVcb();
    }

    _lookAround(dx, dy) {
      const cam = this.engine.camera;
      cam.up.set(0, 1, 0);
      const lookVec = new THREE.Vector3().subVectors(this.engine.target, cam.position);
      const dist = Math.max(12.0, lookVec.length());
      const sph = new THREE.Spherical().setFromVector3(lookVec);
      sph.theta -= dx * 0.0042;
      sph.phi = THREE.MathUtils.clamp(sph.phi + dy * 0.0042, 0.12, Math.PI - 0.12);
      lookVec.setFromSpherical(sph).setLength(dist);
      this.engine.target.copy(cam.position).add(lookVec);
      cam.lookAt(this.engine.target);
      this._syncVcb('Look Around', `Góc ${(THREE.MathUtils.radToDeg(sph.theta) % 360).toFixed(0)}°`);
    }

    _walkDrag(dx, dy) {
      const cam = this.engine.camera;
      cam.up.set(0, 1, 0);
      // Xoay nhẹ hướng nhìn theo dx và bước tới/lùi theo dy
      this._lookAround(dx * 0.75, 0);
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const step = -dy * 0.35;
      cam.position.addScaledVector(fwd, step);
      this.engine.target.addScaledVector(fwd, step);
      this._snapCameraToGroundEyeHeight(cam.position.x, cam.position.z, 1.7);
      cam.lookAt(this.engine.target);
      this.engine._updateGpsHud(this.engine.target);
      const msl = (cam.position.y + window.DALAT_COORDS.Z0_MSL).toFixed(1);
      this._syncVcb('Walk (+1.7m)', `${msl} m MSL`);
    }

    _snapCameraToGroundEyeHeight(x, z, eyeHeight = 1.7) {
      const downRay = new THREE.Raycaster(
        new THREE.Vector3(x, 2200, z),
        new THREE.Vector3(0, -1, 0),
        0.1,
        4500
      );
      const targets =
        this.engine.streamer.terrainPickMeshes.length > 0
          ? this.engine.streamer.terrainPickMeshes
          : this.engine.streamer.pickableMeshes;
      let groundY = window.DALAT_COORDS.syntheticLocalY(x, -z);
      if (targets.length > 0) {
        const hits = downRay.intersectObjects(targets, false);
        if (hits.length > 0) groundY = hits[0].point.y;
      }
      const nextY = groundY + eyeHeight;
      const dy = nextY - this.engine.camera.position.y;
      this.engine.camera.position.y = nextY;
      this.engine.target.y += dy * 0.85;
    }

    _commitPositionCamera(clientX, clientY, movedDist) {
      const endHit = this.engine._raycastPoint(clientX, clientY);
      const startHit = this.posCamStartHit || endHit;
      if (!startHit) return;
      if (this.isParallel) this.setParallelProjection(false, true);

      const eyePos = startHit.clone().add(new THREE.Vector3(0, 1.7, 0));
      let lookTarget;
      if (movedDist > 12 && endHit && endHit.distanceTo(startHit) > 1.5) {
        lookTarget = endHit.clone().add(new THREE.Vector3(0, 1.7, 0));
      } else {
        const curFwd = new THREE.Vector3();
        this.engine.camera.getWorldDirection(curFwd);
        curFwd.y = 0;
        if (curFwd.lengthSq() < 1e-6) curFwd.set(0, 0, -1);
        curFwd.normalize();
        lookTarget = eyePos.clone().addScaledVector(curFwd, 120);
      }

      this.engine.camera.up.set(0, 1, 0);
      this.engine.flyToPreset({
        position_gltf: [eyePos.x, eyePos.y, eyePos.z],
        target_gltf: [lookTarget.x, lookTarget.y, lookTarget.z],
        fov: 55,
        duration_ms: 650,
        onComplete: () => {
          this.setActiveTool('look_around', true);
          this._recordViewSnapshot();
          this.showToast('🧍 Đã đặt mắt người (+1.70m) — Rê chuột để Look Around');
        },
      });
    }

    _updateZoomBox(x0, y0, x1, y1) {
      const box = this.dom['su-zoom-box'];
      if (!box) return;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      box.classList.remove('hidden');
    }

    _hideZoomBox() {
      if (this.dom['su-zoom-box']) this.dom['su-zoom-box'].classList.add('hidden');
    }

    _commitZoomWindow(p0, p1) {
      const w = Math.abs(p1.x - p0.x);
      const h = Math.abs(p1.y - p0.y);
      if (w < 14 || h < 14) return;

      const cx = (p0.x + p1.x) * 0.5;
      const cy = (p0.y + p1.y) * 0.5;
      const ratio = Math.max(w / window.innerWidth, h / window.innerHeight);
      const hit = this.engine._raycastPoint(cx, cy) || this.engine.target.clone();

      if (this.isParallel) {
        const cam = this.orthoCamera;
        const aspect = window.innerWidth / Math.max(1, window.innerHeight);
        const ndcX = (cx / window.innerWidth) * 2 - 1;
        const ndcY = -(cy / window.innerHeight) * 2 + 1;
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const camUp = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
        const shift = new THREE.Vector3()
          .addScaledVector(right, ndcX * this.orthoHalfHeight * aspect)
          .addScaledVector(camUp, ndcY * this.orthoHalfHeight);
        cam.position.add(shift);
        this.engine.target.add(shift);
        this.orthoHalfHeight = Math.max(5.0, this.orthoHalfHeight * ratio);
        this._syncOrthoFrustum();
        cam.lookAt(this.engine.target);
        this._recordViewSnapshot();
        return;
      }

      const camPos = this.engine.camera.position;
      const curDist = camPos.distanceTo(hit);
      const newDist = THREE.MathUtils.clamp(curDist * ratio, 16, 16000);
      const dir = new THREE.Vector3().subVectors(camPos, hit).normalize();
      const nextPos = hit.clone().addScaledVector(dir, newDist);
      if (nextPos.y < 3.5) nextPos.y = 3.5;

      this.engine.flyToPreset({
        position_gltf: [nextPos.x, nextPos.y, nextPos.z],
        target_gltf: [hit.x, hit.y, hit.z],
        fov: this.engine.camera.fov,
        duration_ms: 520,
        onComplete: () => this._recordViewSnapshot(),
      });
    }

    /* ========================================================================
     * GÓC NHÌN CHUẨN (CTRL+1..6, SHIFT+I), PHÉP CHIẾU (` & \), ALIGN VIEW
     * ======================================================================== */

    applyStandardView(viewName) {
      const target = this.engine.target.clone();
      const dist = this.isParallel
        ? Math.max(120, this.orthoHalfHeight / Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov * 0.5)))
        : THREE.MathUtils.clamp(this.engine.camera.position.distanceTo(target), 120, 12000);

      let nextPos = new THREE.Vector3();
      let nextUp = new THREE.Vector3(0, 1, 0);
      let labelVi = '';

      switch (viewName) {
        case 'top':
          nextPos.set(target.x, target.y + dist, target.z);
          nextUp.set(0, 0, -1); // Bắc lên trên màn hình
          labelVi = 'Top View — Nhìn từ trên xuống (Ctrl+1)';
          break;
        case 'bottom':
          nextPos.set(target.x, target.y - dist, target.z);
          nextUp.set(0, 0, 1);
          labelVi = 'Bottom View — Nhìn từ dưới lên (Ctrl+6)';
          break;
        case 'front':
          nextPos.set(target.x, target.y, target.z + dist);
          labelVi = 'Front View — Nhìn từ hướng Nam (Ctrl+2)';
          break;
        case 'back':
          nextPos.set(target.x, target.y, target.z - dist);
          labelVi = 'Back View — Nhìn từ hướng Bắc (Ctrl+3)';
          break;
        case 'left':
          nextPos.set(target.x - dist, target.y, target.z);
          labelVi = 'Left View — Nhìn từ hướng Tây (Ctrl+4)';
          break;
        case 'right':
          nextPos.set(target.x + dist, target.y, target.z);
          labelVi = 'Right View — Nhìn từ hướng Đông (Ctrl+5)';
          break;
        case 'iso':
        default:
          nextPos.set(target.x - dist * 0.58, target.y + dist * 0.58, target.z + dist * 0.58);
          labelVi = 'Iso View — Trục đo 45° (Shift+I)';
          break;
      }

      if (this.isTwoPoint) this.setTwoPointPerspective(false, true);
      const cam = this.engine.camera;
      cam.up.copy(nextUp);
      cam.position.copy(nextPos);
      cam.lookAt(target);
      this.engine.target.copy(target);
      this.engine.flightAnim = null;
      this.engine._updateGpsHud(target);
      this._recordViewSnapshot();
      this.showToast(`🧭 ${labelVi}`);
    }

    _syncOrthoFrustum() {
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      const hh = this.orthoHalfHeight;
      const hw = hh * aspect;
      this.orthoCamera.left = -hw;
      this.orthoCamera.right = hw;
      this.orthoCamera.top = hh;
      this.orthoCamera.bottom = -hh;
      this.orthoCamera.updateProjectionMatrix();
    }

    setParallelProjection(enabled, silent = false) {
      const next = Boolean(enabled);
      if (next === this.isParallel) return;

      if (next) {
        if (this.isTwoPoint) this.setTwoPointPerspective(false, true);
        const dist = Math.max(30, this.perspCamera.position.distanceTo(this.engine.target));
        this.orthoHalfHeight = dist * Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov * 0.5));
        this.orthoCamera.position.copy(this.perspCamera.position);
        this.orthoCamera.up.copy(this.perspCamera.up);
        this._syncOrthoFrustum();
        this.orthoCamera.lookAt(this.engine.target);
        this.isParallel = true;
        this.engine.setActiveCamera(this.orthoCamera);
      } else {
        const dir = new THREE.Vector3().subVectors(this.orthoCamera.position, this.engine.target);
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1);
        dir.normalize();
        const dist = THREE.MathUtils.clamp(
          this.orthoHalfHeight / Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov * 0.5)),
          18,
          18000
        );
        this.perspCamera.position.copy(this.engine.target).addScaledVector(dir, dist);
        this.perspCamera.up.copy(this.orthoCamera.up);
        this.perspCamera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
        this.perspCamera.updateProjectionMatrix();
        this.perspCamera.lookAt(this.engine.target);
        this.isParallel = false;
        this.engine.setActiveCamera(this.perspCamera);
      }

      this._syncToolbarStates();
      this._syncVcb();
      if (!silent) {
        this.showToast(
          this.isParallel
            ? '📐 Parallel Projection: BẬT (`) — Chiếu song song không tụ'
            : '🎥 Perspective: BẬT (`) — Phối cảnh thực'
        );
      }
    }

    toggleParallelProjection() {
      this.setParallelProjection(!this.isParallel);
    }

    _applyTwoPointViewOffset() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (this.isTwoPoint && Math.abs(this.twoPointShiftY) > 0.5) {
        this.perspCamera.setViewOffset(w, h, 0, this.twoPointShiftY, w, h);
      } else {
        this.perspCamera.clearViewOffset();
      }
    }

    setTwoPointPerspective(enabled, silent = false) {
      const next = Boolean(enabled);
      if (next === this.isTwoPoint) return;
      if (next && this.isParallel) {
        this.setParallelProjection(false, true);
      }
      this.isTwoPoint = next;
      if (next) {
        this.perspCamera.up.set(0, 1, 0);
        const horiz = new THREE.Vector3(
          this.engine.target.x - this.perspCamera.position.x,
          0,
          this.engine.target.z - this.perspCamera.position.z
        );
        const horizDist = Math.max(40, horiz.length());
        horiz.normalize();
        this.engine.target.set(
          this.perspCamera.position.x + horiz.x * horizDist,
          this.perspCamera.position.y,
          this.perspCamera.position.z + horiz.z * horizDist
        );
        this.twoPointShiftY = 0;
        this.perspCamera.clearViewOffset();
        this.perspCamera.lookAt(this.engine.target);
      } else {
        this.twoPointShiftY = 0;
        this.perspCamera.clearViewOffset();
      }
      this._syncToolbarStates();
      this._syncVcb();
      if (!silent) {
        this.showToast(
          next
            ? '🏛 Two-Point Perspective: BẬT (\\) — Khóa đứng 100% cạnh kiến trúc'
            : '🎥 Two-Point Perspective: TẮT (\\)'
        );
      }
    }

    toggleTwoPointPerspective() {
      this.setTwoPointPerspective(!this.isTwoPoint);
    }

    alignViewByCursorOrSelection() {
      let anchor = null;
      let normal = null;

      this.engine._setRaycasterFromClient(this.lastMouseScreen.x, this.lastMouseScreen.y);
      const meshes = this.engine.streamer.pickableMeshes || [];
      if (meshes.length > 0) {
        const hits = this.engine.raycaster.intersectObjects(meshes, false);
        if (hits.length > 0 && hits[0].face) {
          anchor = hits[0].point.clone();
          const nMat = new THREE.Matrix3().getNormalMatrix(hits[0].object.matrixWorld);
          normal = hits[0].face.normal.clone().applyMatrix3(nMat).normalize();
        }
      }

      if ((!anchor || !normal) && this.selectedEntity) {
        const box = new THREE.Box3().setFromObject(this.selectedEntity.root);
        anchor = box.getCenter(new THREE.Vector3());
        normal = new THREE.Vector3().subVectors(this.engine.camera.position, anchor).normalize();
      }

      if (!anchor || !normal) {
        this.showToast('Di chuột lên bề mặt công trình hoặc chọn công trình trước khi Align View');
        return;
      }

      const dist = THREE.MathUtils.clamp(this.engine.camera.position.distanceTo(anchor), 45, 900);
      const nextPos = anchor.clone().addScaledVector(normal, dist);
      if (!this.isParallel && nextPos.y < 3.0) nextPos.y = 3.0;
      const cam = this.engine.camera;
      if (Math.abs(normal.y) > 0.97) {
        cam.up.set(0, 0, -1);
      } else {
        cam.up.set(0, 1, 0);
      }
      this.engine.flyToPreset({
        position_gltf: [nextPos.x, nextPos.y, nextPos.z],
        target_gltf: [anchor.x, anchor.y, anchor.z],
        fov: this.perspCamera.fov,
        duration_ms: 650,
        onComplete: () => {
          this._recordViewSnapshot();
          this.showToast('📐 Đã căn góc nhìn vuông góc với bề mặt (Align View)');
        },
      });
    }

    zoomExtents() {
      if (this.engine.minimapHud && this.engine.minimapHud.tourActive) {
        this.engine.minimapHud.stopTour();
      }
      if (this.engine.cameraPresets && this.engine.cameraPresets.length > 0) {
        this.engine.flyToPreset(this.engine.cameraPresets[0]);
      } else {
        this.engine.flyToPreset({
          position_gltf: [-680, 420, 860],
          target_gltf: [0, 8, -40],
          fov: 48,
          duration_ms: 950,
        });
      }
      this.showToast('⤢ Zoom Extents — Toàn cảnh Hồ Xuân Hương & Đà Lạt (Shift+Z)');
    }

    zoomSelection() {
      if (!this.selectedEntity || !this.selectedEntity.root) {
        this.showToast('Hãy click chọn một công trình trước rồi nhấn Alt+Shift+X');
        return;
      }
      const box = new THREE.Box3().setFromObject(this.selectedEntity.root);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(12, size.length() * 0.5);
      const dir = new THREE.Vector3().subVectors(this.engine.camera.position, center);
      if (dir.lengthSq() < 1e-4) dir.set(-1, 0.65, 1);
      dir.normalize();
      const dist = radius * 2.4;
      const nextPos = center.clone().addScaledVector(dir, dist);
      if (nextPos.y < center.y + 4) nextPos.y = center.y + Math.max(8, radius * 0.45);

      this.engine.flyToPreset({
        position_gltf: [nextPos.x, nextPos.y, nextPos.z],
        target_gltf: [center.x, center.y, center.z],
        fov: this.perspCamera.fov,
        duration_ms: 750,
        onComplete: () => {
          this._recordViewSnapshot();
          this.showToast(`🔍 Zoom Selection: ${this.selectedEntity.name}`);
        },
      });
    }

    /* ========================================================================
     * CHỌN ĐỐI TƯỢNG, ẨN / HIỆN / CÔ LẬP (SELECT, HIDE, UNHIDE, ISOLATE)
     * ======================================================================== */

    _handleSelectClick(clientX, clientY) {
      this.engine._setRaycasterFromClient(clientX, clientY);
      const streamer = this.engine.streamer;

      // Ưu tiên 1: Công trình nổi bật
      const lmPick = streamer.pickLandmark(this.engine.raycaster);
      if (lmPick) {
        const root = this._findEntityRoot(lmPick.meta.id, clientX, clientY) || this._raycastEntityRoot(clientX, clientY, ['landmarks']);
        if (root) {
          this.selectEntity(root, lmPick.meta.name_vi, lmPick.meta);
        }
        if (this.engine.minimapHud) {
          this.engine.minimapHud.showLandmarkPopup(lmPick.meta);
        }
        this.engine._updateGpsHud(lmPick.point);
        return;
      }

      // Ưu tiên 2: Nhà dân / Đường phố / Công trình khác
      const picked = this._raycastEntityRoot(clientX, clientY, ['landmarks', 'buildings', 'roads']);
      if (picked) {
        this.selectEntity(picked.root, picked.name, null);
        this.engine._updateGpsHud(picked.point);
        return;
      }

      this.clearSelection();
    }

    _findEntityRoot(landmarkId) {
      let found = null;
      const grp = this.engine.streamer.layers.landmarks;
      if (!grp) return null;
      for (const child of grp.children) {
        let hit = false;
        child.traverse((o) => {
          if (o.userData && o.userData.landmarkId === landmarkId) hit = true;
        });
        if (hit) {
          found = child;
          break;
        }
      }
      return found;
    }

    _raycastEntityRoot(clientX, clientY, layerNames) {
      this.engine._setRaycasterFromClient(clientX, clientY);
      const streamer = this.engine.streamer;
      for (const lname of layerNames) {
        const grp = streamer.layers[lname];
        if (!grp || !grp.visible) continue;
        const hits = this.engine.raycaster.intersectObjects(grp.children, true);
        const visibleHit = hits.find((h) => h.object && h.object.visible);
        if (visibleHit) {
          let cur = visibleHit.object;
          while (cur.parent && cur.parent !== grp) {
            cur = cur.parent;
          }
          const rawName = visibleHit.object.name || cur.name || lname;
          const labelMap = {
            landmarks: 'Công trình',
            buildings: 'Khối nhà / Khu phố',
            roads: 'Tuyến đường',
          };
          return {
            root: visibleHit.object.isInstancedMesh ? visibleHit.object : cur,
            name: `${labelMap[lname] || lname}: ${rawName}`,
            point: visibleHit.point.clone(),
          };
        }
      }
      return null;
    }

    selectEntity(root, name, landmarkMeta = null) {
      if (!root) return;
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const summary = `${name} (${size.x.toFixed(1)}×${size.z.toFixed(1)}×${size.y.toFixed(1)}m)`;

      this.selectedEntity = {
        root,
        name,
        meta: landmarkMeta,
        summary,
      };
      this.selectionHelper.box.copy(box);
      this.selectionHelper.visible = true;
      this._syncVcb('Đang chọn', summary);
    }

    clearSelection() {
      this.selectedEntity = null;
      this.selectionHelper.visible = false;
      this._syncVcb();
    }

    hideSelected() {
      if (!this.selectedEntity || !this.selectedEntity.root) {
        this.showToast('Chưa chọn công trình/nhóm để ẩn');
        return;
      }
      const { root, name } = this.selectedEntity;
      root.visible = false;
      this.hiddenStack.push({ root, name });
      this.clearSelection();
      this.engine.streamer.rebuildPickableList();
      if (this.engine.realtime) this.engine.realtime.markShadowDirty();
      this.showToast(`👁‍🗨 Đã ẩn "${name}" (Shift+H hoặc U để hiện lại)`);
    }

    unhideLast() {
      if (this.hiddenStack.length === 0) {
        this.showToast('Không có đối tượng nào đang ẩn');
        return;
      }
      const item = this.hiddenStack.pop();
      if (item && item.root) {
        item.root.visible = true;
        this.engine.streamer.rebuildPickableList();
        if (this.engine.realtime) this.engine.realtime.markShadowDirty();
        this.showToast(`👁 Đã hiện lại "${item.name}"`);
      }
    }

    unhideAll() {
      if (this.isolatedState) this.exitIsolation();
      if (this.hiddenStack.length === 0) {
        this.showToast('Toàn bộ đối tượng đều đang hiển thị');
        return;
      }
      while (this.hiddenStack.length > 0) {
        const item = this.hiddenStack.pop();
        if (item && item.root) item.root.visible = true;
      }
      this.engine.streamer.rebuildPickableList();
      if (this.engine.realtime) this.engine.realtime.markShadowDirty();
      this.showToast('👁 Đã hiện lại toàn bộ đối tượng ẩn (Shift+U)');
    }

    toggleIsolateSelection() {
      if (this.isolatedState) {
        this.exitIsolation();
        return;
      }
      if (!this.selectedEntity || !this.selectedEntity.root) {
        this.showToast('Chọn một công trình rồi nhấn T hoặc Alt+Q để cô lập');
        return;
      }
      const targetRoot = this.selectedEntity.root;
      const savedVisibility = [];
      const layers = this.engine.streamer.layers;

      ['landmarks', 'buildings', 'roads', 'vegetation'].forEach((lname) => {
        const grp = layers[lname];
        if (!grp) return;
        for (const child of grp.children) {
          if (child === targetRoot || this._isAncestorOrDescendant(child, targetRoot)) continue;
          if (child.visible) {
            savedVisibility.push(child);
            child.visible = false;
          }
        }
      });

      if (this.engine.trafficStreamer && this.engine.trafficStreamer.enabled) {
        this.engine.trafficStreamer.group.visible = false;
      }

      this.isolatedState = {
        targetName: this.selectedEntity.name,
        savedVisibility,
      };
      if (this.engine.realtime) this.engine.realtime.markShadowDirty();
      this.showToast(`🎯 Đang cô lập "${this.selectedEntity.name}" (Nhấn T / Alt+Q / Esc để hiện lại)`);
    }

    exitIsolation() {
      if (!this.isolatedState) return;
      for (const obj of this.isolatedState.savedVisibility) {
        obj.visible = true;
      }
      if (this.engine.trafficStreamer) {
        this.engine.trafficStreamer.group.visible = this.engine.trafficStreamer.enabled;
      }
      const name = this.isolatedState.targetName;
      this.isolatedState = null;
      if (this.engine.realtime) this.engine.realtime.markShadowDirty();
      this.showToast(`👁 Đã thoát cô lập "${name}"`);
    }

    _isAncestorOrDescendant(a, b) {
      let cur = b;
      while (cur) {
        if (cur === a) return true;
        cur = cur.parent;
      }
      cur = a;
      while (cur) {
        if (cur === b) return true;
        cur = cur.parent;
      }
      return false;
    }

    /* ========================================================================
     * CHẾ ĐỘ HIỂN THỊ MẶT & CẠNH (F2..F8, K) + BÓNG ĐỔ (ALT+SHIFT+S)
     * ======================================================================== */

    _getStyleTargetLayers() {
      const l = this.engine.streamer.layers;
      return [
        { key: 'terrain', grp: l.terrain },
        { key: 'water', grp: l.water },
        { key: 'landmarks', grp: l.landmarks },
        { key: 'roads', grp: l.roads },
        { key: 'buildings', grp: l.buildings },
        { key: 'vegetation', grp: l.vegetation },
      ];
    }

    setFaceStyle(styleId, silent = false) {
      if (!FACE_STYLE_LABELS[styleId]) return;
      this.faceStyle = styleId;

      const scene = this.engine.scene;
      const realtime = this.engine.realtime;

      // Quản lý nền trắng kỹ thuật cho Hidden Line (F6)
      if (styleId === 'hidden_line') {
        if (this._savedSceneBackground === null) {
          this._savedSceneBackground = scene.background ? scene.background.clone() : new THREE.Color('#92BCE3');
        }
        scene.background = new THREE.Color('#f4f7fb');
        if (realtime && realtime.skyDome) {
          this._savedSkyVisible = realtime.skyDome.visible;
          realtime.skyDome.visible = false;
        }
        if (scene.fog) {
          this._savedFog = scene.fog;
          scene.fog = null;
        }
      } else if (this._savedSceneBackground !== null) {
        scene.background = this._savedSceneBackground;
        this._savedSceneBackground = null;
        if (realtime && realtime.skyDome) {
          realtime.skyDome.visible = this._savedSkyVisible !== false;
        }
        if (this._savedFog) {
          scene.fog = this._savedFog;
          this._savedFog = null;
        }
      }

      this.applyVisualStylesToScene();

      // Hidden Line tự bật Edges nếu chưa bật
      if (styleId === 'hidden_line') {
        this._rebuildEdgeOverlay(true);
      } else {
        this._rebuildEdgeOverlay(this.edgesEnabled || this.backEdgesEnabled);
      }

      this._syncToolbarStates();
      if (!silent) {
        this.showToast(`🎨 Kiểu hiển thị: ${FACE_STYLE_LABELS[styleId]}`);
      }
    }

    applyVisualStylesToScene() {
      const targets = this._getStyleTargetLayers();
      for (const { key, grp } of targets) {
        if (!grp) continue;
        grp.traverse((obj) => {
          if (!obj.isMesh || !obj.material) return;
          this._applyStyleToMesh(obj, key);
        });
      }
      if (this.engine.trafficStreamer && this.engine.trafficStreamer.group) {
        this.engine.trafficStreamer.group.traverse((obj) => {
          if (obj.isMesh && obj.material) this._applyStyleToMesh(obj, 'buildings');
        });
      }
    }

    _applyStyleToMesh(mesh, layerKey) {
      if (!mesh.userData) mesh.userData = {};
      if (!mesh.userData._suOrigMat) {
        mesh.userData._suOrigMat = mesh.material;
      }
      const origMat = mesh.userData._suOrigMat;

      // Lưu thuộc tính từng material gốc để khôi phục 100%
      const saveMatProps = (m) => {
        if (!m || !m.userData) return;
        if (m.userData && !m.userData._suProps) {
          m.userData._suProps = {
            map: m.map,
            normalMap: m.normalMap,
            roughnessMap: m.roughnessMap,
            transparent: Boolean(m.transparent),
            opacity: m.opacity != null ? m.opacity : 1.0,
            depthWrite: m.depthWrite != null ? m.depthWrite : true,
            wireframe: Boolean(m.wireframe),
          };
        }
      };
      if (Array.isArray(origMat)) origMat.forEach(saveMatProps);
      else saveMatProps(origMat);

      const applyXrayOnMaterial = (mat) => {
        if (!mat || !mat.userData || !mat.userData._suProps) return;
        const p = mat.userData._suProps;
        if (this.xrayEnabled && (layerKey === 'landmarks' || layerKey === 'buildings')) {
          mat.transparent = true;
          mat.opacity = Math.min(p.opacity, 0.36);
          mat.depthWrite = false;
        } else {
          mat.transparent = p.transparent;
          mat.opacity = p.opacity;
          mat.depthWrite = p.depthWrite;
        }
      };

      if (this.faceStyle === 'textures') {
        mesh.material = origMat;
        const mats = Array.isArray(origMat) ? origMat : [origMat];
        for (const m of mats) {
          if (!m || !m.userData || !m.userData._suProps) continue;
          const p = m.userData._suProps;
          if (m.map !== p.map) m.map = p.map;
          if (m.normalMap !== p.normalMap) m.normalMap = p.normalMap;
          if (m.roughnessMap !== p.roughnessMap) m.roughnessMap = p.roughnessMap;
          m.wireframe = p.wireframe;
          applyXrayOnMaterial(m);
          m.needsUpdate = true;
        }
        return;
      }

      if (this.faceStyle === 'shaded') {
        mesh.material = origMat;
        const mats = Array.isArray(origMat) ? origMat : [origMat];
        for (const m of mats) {
          if (!m || !m.userData || !m.userData._suProps) continue;
          const p = m.userData._suProps;
          // Giữ map trên lá cây có alphaTest để tán thông không biến thành hình vuông
          if (!(layerKey === 'vegetation' && m.alphaTest > 0.05)) {
            m.map = null;
          }
          m.normalMap = null;
          m.roughnessMap = null;
          m.wireframe = false;
          applyXrayOnMaterial(m);
          m.needsUpdate = true;
        }
        return;
      }

      if (this.faceStyle === 'monochrome') {
        if (layerKey === 'vegetation') {
          mesh.material = origMat;
          return;
        }
        if (this.xrayEnabled && (layerKey === 'landmarks' || layerKey === 'buildings')) {
          if (!this._sharedMonoXrayMat) {
            this._sharedMonoXrayMat = this._sharedMonoMat.clone();
            this._sharedMonoXrayMat.transparent = true;
            this._sharedMonoXrayMat.opacity = 0.38;
            this._sharedMonoXrayMat.depthWrite = false;
          }
          mesh.material = this._sharedMonoXrayMat;
        } else if (layerKey === 'terrain') {
          mesh.material = this._sharedMonoTerrainMat;
        } else if (layerKey === 'water') {
          mesh.material = this._sharedMonoWaterMat;
        } else if (layerKey === 'roads') {
          mesh.material = this._sharedMonoRoadMat;
        } else {
          mesh.material = this._sharedMonoMat;
        }
        return;
      }

      if (this.faceStyle === 'wireframe') {
        mesh.material = this._sharedWireMat;
        return;
      }

      if (this.faceStyle === 'hidden_line') {
        if (layerKey === 'terrain') mesh.material = this._sharedHiddenTerrainMat;
        else if (layerKey === 'water') mesh.material = this._sharedHiddenWaterMat;
        else if (layerKey === 'roads') mesh.material = this._sharedHiddenTerrainMat;
        else mesh.material = this._sharedHiddenMat;
      }
    }

    toggleXray() {
      this.xrayEnabled = !this.xrayEnabled;
      this.applyVisualStylesToScene();
      this._syncToolbarStates();
      this.showToast(this.xrayEnabled ? '🩻 X-Ray: BẬT (F7)' : '🧱 X-Ray: TẮT (F7)');
    }

    toggleEdges() {
      this.edgesEnabled = !this.edgesEnabled;
      this._rebuildEdgeOverlay(this.edgesEnabled || this.backEdgesEnabled || this.faceStyle === 'hidden_line');
      this._syncToolbarStates();
      this.showToast(this.edgesEnabled ? '✏ Edges (Viền cạnh 3D): BẬT (F8)' : '✏ Edges (Viền cạnh 3D): TẮT (F8)');
    }

    toggleBackEdges() {
      this.backEdgesEnabled = !this.backEdgesEnabled;
      this._rebuildEdgeOverlay(this.edgesEnabled || this.backEdgesEnabled || this.faceStyle === 'hidden_line');
      this._syncToolbarStates();
      this.showToast(
        this.backEdgesEnabled ? '⋯ Back Edges (Nét khuất): BẬT (K)' : '⋯ Back Edges (Nét khuất): TẮT (K)'
      );
    }

    _rebuildEdgeOverlay(shouldShow) {
      while (this.edgeOverlayGroup.children.length > 0) {
        const ch = this.edgeOverlayGroup.children[0];
        this.edgeOverlayGroup.remove(ch);
      }
      if (!shouldShow) return;

      const l = this.engine.streamer.layers;
      const targetLayers = [l.landmarks, l.buildings];
      const focusPt = this.engine.target || this.engine.camera.position;
      const candidates = [];
      const worldPos = new THREE.Vector3();

      for (const grp of targetLayers) {
        if (!grp || !grp.visible) continue;
        grp.traverse((obj) => {
          if (!obj.isMesh || !obj.visible || obj.isInstancedMesh || !obj.geometry) return;
          if (obj.geometry.attributes.position && obj.geometry.attributes.position.count > 36000) return;
          obj.updateWorldMatrix(true, false);
          if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
          const bs = obj.geometry.boundingSphere;
          if (bs) {
            worldPos.copy(bs.center).applyMatrix4(obj.matrixWorld);
          } else {
            worldPos.setFromMatrixPosition(obj.matrixWorld);
          }
          const dist = worldPos.distanceTo(focusPt);
          if (dist <= 3200) {
            candidates.push({ obj, dist });
          }
        });
      }

      candidates.sort((a, b) => a.dist - b.dist);
      const limit = Math.min(candidates.length, 240);

      for (let i = 0; i < limit; i++) {
        const { obj } = candidates[i];
        let edgeGeo = this._edgeGeoCache.get(obj.geometry.uuid);
        if (!edgeGeo) {
          edgeGeo = new THREE.EdgesGeometry(obj.geometry, 24);
          this._edgeGeoCache.set(obj.geometry.uuid, edgeGeo);
        }

        if (this.edgesEnabled || this.faceStyle === 'hidden_line') {
          const line = new THREE.LineSegments(edgeGeo, this._edgeMatNormal);
          line.matrixAutoUpdate = false;
          line.matrix.copy(obj.matrixWorld);
          this.edgeOverlayGroup.add(line);
        }
        if (this.backEdgesEnabled && i < 80) {
          const backLine = new THREE.LineSegments(edgeGeo, this._edgeMatBack);
          backLine.computeLineDistances();
          backLine.matrixAutoUpdate = false;
          backLine.matrix.copy(obj.matrixWorld);
          backLine.renderOrder = 900;
          this.edgeOverlayGroup.add(backLine);
        }
      }
    }

    onNewGeometrySettled() {
      if (this.faceStyle !== 'textures' || this.xrayEnabled) {
        this.applyVisualStylesToScene();
      }
      if (this.edgesEnabled || this.backEdgesEnabled || this.faceStyle === 'hidden_line') {
        this._rebuildEdgeOverlay(true);
      }
    }

    toggleShadows() {
      const chk = document.getElementById('shadows-toggle');
      const next = this.engine.realtime ? !this.engine.realtime.shadowsEnabled : chk ? !chk.checked : true;
      if (this.engine.realtime) {
        this.engine.realtime.setShadowsEnabled(next);
        this.engine._syncRealtimeUi();
      }
      if (chk) chk.checked = next;
      this.showToast(next ? '☀ Bóng đổ Mặt trời: BẬT (Alt+Shift+S)' : '☁ Bóng đổ Mặt trời: TẮT (Alt+Shift+S)');
    }

    toggleDialogsHidden() {
      this.dialogsHidden = !this.dialogsHidden;
      document.body.classList.toggle('su-dialogs-hidden', this.isSketchupMode() && this.dialogsHidden);
      this.showToast(this.dialogsHidden ? '🖥 Đã ẩn bảng giao diện (Ctrl+H để hiện lại)' : '🖥 Đã hiện lại bảng giao diện');
    }

    focusLayersPanel() {
      const panel = document.getElementById('control-panel');
      if (panel && panel.classList.contains('collapsed')) {
        panel.classList.remove('collapsed');
        document.body.classList.add('mobile-drawer-open');
      }
      const firstLayer = document.querySelector('#control-panel .layer-list');
      if (firstLayer) {
        firstLayer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      this.showToast('🗂 Các Lớp Dữ Liệu 3D (Layers)');
    }

    /* ========================================================================
     * ĐO ĐẠC 3D: TAPE MEASURE, DIMENSION, PROTRACTOR, ERASER, INSPECT MATERIAL
     * ======================================================================== */

    _handleHover(clientX, clientY) {
      const now = performance.now();
      if (now - (this._lastHoverMs || 0) < 40) return;
      this._lastHoverMs = now;

      if (['measure', 'dimension', 'protractor', 'position_camera'].includes(this.activeTool)) {
        const hit = this._updateSnapAtClient(clientX, clientY);
        if (hit && this.measureDraft) {
          this._updateMeasureDraftPreview(hit);
        }
      } else {
        this.snapMarker.visible = false;
      }

      if (now - this.engine._lastHoverRaycastTime >= 75) {
        this.engine._lastHoverRaycastTime = now;
        const hoverHit = this.engine._raycastHoverTerrain(clientX, clientY);
        if (hoverHit) this.engine._updateGpsHud(hoverHit);
      }
    }

    _updateSnapAtClient(clientX, clientY) {
      const hit = this.engine._raycastPoint(clientX, clientY);
      if (!hit) {
        this.snapMarker.visible = false;
        return null;
      }
      const dist = hit.distanceTo(this.engine.camera.position);
      const scale = THREE.MathUtils.clamp(dist * 0.0085, 0.35, 16.0);
      this.snapMarker.position.copy(hit);
      this.snapMarker.scale.setScalar(scale);
      this.snapMarker.visible = true;
      return hit;
    }

    _handleMeasureClick(kind, clientX, clientY) {
      const pt = this.engine._raycastPoint(clientX, clientY);
      if (!pt) return;

      if (!this.measureDraft || this.measureDraft.kind !== kind) {
        this._cancelMeasureDraft();
        const mat = new THREE.LineBasicMaterial({
          color: kind === 'measure' ? 0xfacc15 : kind === 'dimension' ? 0x38bdf8 : 0xf472b6,
          depthTest: false,
        });
        const geo = new THREE.BufferGeometry().setFromPoints([pt, pt.clone()]);
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 995;
        this.measureGroup.add(line);
        this.measureDraft = { kind, points: [pt], previewLine: line };
        this._syncVcb(TOOL_META[kind].label, 'Chọn điểm kế tiếp...');
        return;
      }

      this.measureDraft.points.push(pt);
      if (kind === 'protractor' && this.measureDraft.points.length < 3) {
        this._syncVcb('Protractor', 'Chọn điểm thứ 3 để xác định góc...');
        return;
      }

      this._commitMeasureDraft();
    }

    _updateMeasureDraftPreview(hoverPt) {
      if (!this.measureDraft || !this.measureDraft.previewLine) return;
      const pts = [...this.measureDraft.points, hoverPt];
      this.measureDraft.previewLine.geometry.setFromPoints(pts);

      if (this.measureDraft.kind === 'measure' || this.measureDraft.kind === 'dimension') {
        const a = pts[0];
        const b = pts[1];
        const dist3d = a.distanceTo(b);
        const horiz = Math.hypot(b.x - a.x, b.z - a.z);
        const dy = b.y - a.y;
        const slopePct = horiz > 0.1 ? (dy / horiz) * 100 : 0;
        this._syncVcb(
          this.measureDraft.kind === 'measure' ? 'Chiều dài' : 'Kích thước',
          `${dist3d.toFixed(1)}m | Ngang ${horiz.toFixed(1)}m | ΔZ ${dy >= 0 ? '+' : ''}${dy.toFixed(1)}m (${slopePct.toFixed(1)}%)`
        );
      } else if (this.measureDraft.kind === 'protractor' && pts.length === 3) {
        const deg = this._computeAngleDeg(pts[0], pts[1], pts[2]);
        this._syncVcb('Góc đo', `${deg.toFixed(1)}°`);
      }
    }

    _commitMeasureDraft() {
      if (!this.measureDraft) return;
      const { kind, points, previewLine } = this.measureDraft;
      this.measureDraft = null;
      previewLine.geometry.setFromPoints(points);

      let labelText = '';
      let anchorWorld = points[0].clone();

      if (kind === 'measure' || kind === 'dimension') {
        const a = points[0];
        const b = points[1];
        const dist3d = a.distanceTo(b);
        const horiz = Math.hypot(b.x - a.x, b.z - a.z);
        const dy = b.y - a.y;
        const slope = horiz > 0.1 ? (dy / horiz) * 100 : 0;
        labelText =
          kind === 'dimension'
            ? `${dist3d.toFixed(1)} m`
            : `${dist3d.toFixed(1)} m (ΔZ ${dy >= 0 ? '+' : ''}${dy.toFixed(1)}m • ${slope.toFixed(1)}%)`;
        anchorWorld = a.clone().lerp(b, 0.5);
      } else if (kind === 'protractor' && points.length >= 3) {
        const deg = this._computeAngleDeg(points[0], points[1], points[2]);
        labelText = `${deg.toFixed(1)}°`;
        anchorWorld = points[0].clone();
      }

      const labelEl = document.createElement('div');
      labelEl.className = `su-measure-tag su-tag-${kind}`;
      labelEl.textContent = labelText;
      if (this.dom['su-label-layer']) {
        this.dom['su-label-layer'].appendChild(labelEl);
      }

      const rec = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        kind,
        line: previewLine,
        points,
        anchorWorld,
        labelEl,
        labelText,
      };
      this.measureRecords.push(rec);
      this._syncVcb(TOOL_META[kind].label, labelText);
      this._updateMeasureScreenLabels();
    }

    _cancelMeasureDraft() {
      if (!this.measureDraft) return;
      if (this.measureDraft.previewLine) {
        this.measureGroup.remove(this.measureDraft.previewLine);
        this.measureDraft.previewLine.geometry.dispose();
        this.measureDraft.previewLine.material.dispose();
      }
      this.measureDraft = null;
    }

    _computeAngleDeg(origin, a, b) {
      const va = new THREE.Vector3().subVectors(a, origin).normalize();
      const vb = new THREE.Vector3().subVectors(b, origin).normalize();
      return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1)));
    }

    _updateMeasureScreenLabels() {
      if (this.measureRecords.length === 0) return;
      const cam = this.engine.camera;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const tmp = new THREE.Vector3();

      for (const rec of this.measureRecords) {
        if (!rec.labelEl) continue;
        tmp.copy(rec.anchorWorld).project(cam);
        if (tmp.z > 1 || tmp.z < -1) {
          rec.labelEl.style.display = 'none';
          continue;
        }
        const sx = (tmp.x * 0.5 + 0.5) * w;
        const sy = (-tmp.y * 0.5 + 0.5) * h;
        rec.labelEl.style.display = 'block';
        rec.labelEl.style.left = `${sx.toFixed(1)}px`;
        rec.labelEl.style.top = `${sy.toFixed(1)}px`;
      }
    }

    _handleEraserClick(clientX, clientY) {
      if (this.measureRecords.length === 0) {
        this.showToast('Không có đường đo nào để xóa');
        return;
      }
      const cam = this.engine.camera;
      const w = window.innerWidth;
      const h = window.innerHeight;
      let bestIdx = -1;
      let bestDist = 48;

      const toScreen = (pt) => {
        const v = pt.clone().project(cam);
        return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
      };
      const distPointToSeg = (px, py, ax, ay, bx, by) => {
        const vx = bx - ax;
        const vy = by - ay;
        const wx = px - ax;
        const wy = py - ay;
        const c1 = vx * wx + vy * wy;
        if (c1 <= 0) return Math.hypot(px - ax, py - ay);
        const c2 = vx * vx + vy * vy;
        if (c2 <= c1) return Math.hypot(px - bx, py - by);
        const t = c1 / c2;
        return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
      };

      this.measureRecords.forEach((rec, idx) => {
        const sAnchor = toScreen(rec.anchorWorld);
        let d = Math.hypot(sAnchor.x - clientX, sAnchor.y - clientY);
        if (Array.isArray(rec.points) && rec.points.length >= 2) {
          for (let i = 0; i < rec.points.length - 1; i++) {
            const sa = toScreen(rec.points[i]);
            const sb = toScreen(rec.points[i + 1]);
            d = Math.min(d, distPointToSeg(clientX, clientY, sa.x, sa.y, sb.x, sb.y));
          }
        }
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      });

      if (bestIdx >= 0) {
        const [removed] = this.measureRecords.splice(bestIdx, 1);
        this.measureGroup.remove(removed.line);
        removed.line.geometry.dispose();
        removed.line.material.dispose();
        if (removed.labelEl && removed.labelEl.parentNode) {
          removed.labelEl.parentNode.removeChild(removed.labelEl);
        }
        this.showToast(`🧹 Đã xóa đường đo "${removed.labelText}"`);
      } else {
        this.showToast('Click gần đường đo hoặc nhãn số đo trên cảnh để xóa');
      }
    }

    _handlePaintInspectClick(clientX, clientY) {
      this.engine._setRaycasterFromClient(clientX, clientY);
      const meshes = this.engine.streamer.pickableMeshes || [];
      if (meshes.length === 0) return;
      const hits = this.engine.raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) {
        this.showToast('Không chạm bề mặt 3D nào');
        return;
      }
      const h = hits[0];
      const mat = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      const matName = (mat && mat.name) || 'Standard Material';
      const hex = mat && mat.color ? `#${mat.color.getHexString()}` : '#FFFFFF';
      const rough = mat && typeof mat.roughness === 'number' ? mat.roughness.toFixed(2) : '-';
      const elev = (h.point.y + window.DALAT_COORDS.Z0_MSL).toFixed(1);
      this._syncVcb('Vật liệu', `${matName} (${hex}, R=${rough}) • ${elev}m`);
      this.showToast(`🎨 ${matName} | Màu ${hex} | Roughness ${rough} | Cao độ ${elev}m MSL`, 3200);
    }

    /* ========================================================================
     * LỊCH SỬ VIEW & SCENES (PREV/NEXT VIEW, CTRL+SHIFT+A)
     * ======================================================================== */

    _scheduleHistorySnapshot() {
      if (this._pushHistoryDebounced) clearTimeout(this._pushHistoryDebounced);
      this._pushHistoryDebounced = setTimeout(() => this._recordViewSnapshot(), 420);
    }

    _recordViewSnapshot(initial = false) {
      const cam = this.engine.camera;
      const snap = {
        pos: cam.position.clone(),
        target: this.engine.target.clone(),
        up: cam.up.clone(),
        fov: this.perspCamera.fov,
        isParallel: this.isParallel,
        orthoHalfHeight: this.orthoHalfHeight,
      };
      if (!initial && this.viewHistoryIdx >= 0) {
        const prev = this.viewHistory[this.viewHistoryIdx];
        if (prev && prev.pos.distanceTo(snap.pos) < 1.0 && prev.target.distanceTo(snap.target) < 1.0 && prev.isParallel === snap.isParallel) {
          return;
        }
      }
      if (this.viewHistoryIdx < this.viewHistory.length - 1) {
        this.viewHistory = this.viewHistory.slice(0, this.viewHistoryIdx + 1);
      }
      this.viewHistory.push(snap);
      if (this.viewHistory.length > 25) this.viewHistory.shift();
      this.viewHistoryIdx = this.viewHistory.length - 1;
    }

    navigateHistory(delta) {
      const nextIdx = this.viewHistoryIdx + delta;
      if (nextIdx < 0 || nextIdx >= this.viewHistory.length) {
        this.showToast(delta < 0 ? 'Đã ở góc nhìn đầu tiên' : 'Đã ở góc nhìn mới nhất');
        return;
      }
      this.viewHistoryIdx = nextIdx;
      const snap = this.viewHistory[nextIdx];
      this.setParallelProjection(snap.isParallel, true);
      if (snap.isParallel) {
        this.orthoHalfHeight = snap.orthoHalfHeight;
        this._syncOrthoFrustum();
      }
      const cam = this.engine.camera;
      cam.position.copy(snap.pos);
      cam.up.copy(snap.up);
      this.engine.target.copy(snap.target);
      cam.lookAt(this.engine.target);
      this.engine._updateGpsHud(this.engine.target);
      this.showToast(delta < 0 ? '⏮ Previous View' : '⏭ Next View');
    }

    _loadSavedScenes() {
      try {
        const raw = localStorage.getItem(STORAGE_SCENES_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (_) {
        return [];
      }
    }

    _saveScenes() {
      try {
        localStorage.setItem(STORAGE_SCENES_KEY, JSON.stringify(this.scenes));
      } catch (_) {}
    }

    addScene() {
      const cam = this.engine.camera;
      const idx = this.scenes.length + 1;
      const activeClimateBtn = document.querySelector('#climate-grid .preset-btn.active');
      const climateId = activeClimateBtn ? activeClimateBtn.dataset.climate : 'early_mist';
      const sceneRec = {
        id: `scene_${Date.now()}`,
        name: `Scene ${idx}`,
        pos: [cam.position.x, cam.position.y, cam.position.z],
        target: [this.engine.target.x, this.engine.target.y, this.engine.target.z],
        up: [cam.up.x, cam.up.y, cam.up.z],
        fov: this.perspCamera.fov,
        isParallel: this.isParallel,
        orthoHalfHeight: this.orthoHalfHeight,
        climateId,
      };
      this.scenes.push(sceneRec);
      this._activeSceneId = sceneRec.id;
      this._saveScenes();
      this._renderSceneTabs();
      if (this.dom['su-scene-bar']) {
        this.dom['su-scene-bar'].classList.toggle('hidden', !this.isSketchupMode() || this.scenes.length === 0);
      }
      this.showToast(`🎬 Đã lưu ${sceneRec.name} (Ctrl+Shift+A)`);
    }

    activateScene(sceneId) {
      const sc = this.scenes.find((s) => s.id === sceneId);
      if (!sc) return;
      this._activeSceneId = sc.id;
      if (sc.climateId) this.engine.applyClimate(sc.climateId);
      this.setParallelProjection(Boolean(sc.isParallel), true);
      if (sc.isParallel && sc.orthoHalfHeight) {
        this.orthoHalfHeight = sc.orthoHalfHeight;
        this._syncOrthoFrustum();
      }
      this.engine.camera.up.fromArray(sc.up || [0, 1, 0]);
      this.engine.flyToPreset({
        position_gltf: sc.pos,
        target_gltf: sc.target,
        fov: sc.fov || 48,
        duration_ms: 850,
        onComplete: () => this._recordViewSnapshot(),
      });
      this._renderSceneTabs();
      this.showToast(`🎬 Chuyển tới ${sc.name}`);
    }

    deleteScene(sceneId) {
      this.scenes = this.scenes.filter((s) => s.id !== sceneId);
      this._saveScenes();
      this._renderSceneTabs();
      if (this.dom['su-scene-bar']) {
        this.dom['su-scene-bar'].classList.toggle('hidden', !this.isSketchupMode() || this.scenes.length === 0);
      }
    }

    cycleNextScene() {
      if (this.scenes.length > 0) {
        const curIdx = this.scenes.findIndex((s) => s.id === this._activeSceneId);
        const next = this.scenes[(curIdx + 1) % this.scenes.length];
        this.activateScene(next.id);
        return;
      }
      if (this.engine.cameraPresets && this.engine.cameraPresets.length > 0) {
        this._presetCycleIdx = ((this._presetCycleIdx || 0) + 1) % this.engine.cameraPresets.length;
        const p = this.engine.cameraPresets[this._presetCycleIdx];
        this.engine.flyToPreset(p);
        this.showToast(`📍 ${p.name_vi}`);
      }
    }

    _renderSceneTabs() {
      const bar = this.dom['su-scene-bar'];
      if (!bar) return;
      if (this.scenes.length === 0) {
        bar.innerHTML = '';
        return;
      }
      bar.innerHTML = this.scenes
        .map(
          (s) =>
            `<div class="su-scene-chip${s.id === this._activeSceneId ? ' active' : ''}" data-scene-id="${s.id}"><span>${s.name}</span><button type="button" class="su-scene-del" data-scene-del="${s.id}" title="Xóa Scene">×</button></div>`
        )
        .join('');
      bar.querySelectorAll('[data-scene-id]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.dataset && e.target.dataset.sceneDel) return;
          this.activateScene(el.dataset.sceneId);
        });
      });
      bar.querySelectorAll('[data-scene-del]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteScene(btn.dataset.sceneDel);
        });
      });
    }

    /* ========================================================================
     * CURIC PIE MENU (VIEW.JSON) & MODAL BẢNG PHÍM TẮT (SHIFT+S)
     * ======================================================================== */

    togglePieMenu(cx, cy) {
      if (this._pieOpen) {
        this.closePieMenu();
        return;
      }
      const overlay = this.dom['su-pie-menu'];
      if (!overlay) return;

      const items = [
        { label: 'Top', kbd: 'Ctrl+1', cmd: 'view_top' },
        { label: 'Iso', kbd: 'Shift+I', cmd: 'view_iso' },
        { label: 'Extents', kbd: 'Shift+Z', cmd: 'zoom_extents' },
        { label: 'Prev View', kbd: 'PgUp', cmd: 'prev_view' },
        { label: 'Pos Cam', kbd: 'Alt+D', tool: 'position_camera' },
        { label: 'Look', kbd: 'N', tool: 'look_around' },
        { label: 'Parallel', kbd: '`', cmd: 'toggle_parallel' },
        { label: 'X-Ray', kbd: 'F7', cmd: 'toggle_xray' },
        { label: 'Mono', kbd: 'F4', cmd: 'style_monochrome' },
        { label: 'Textures', kbd: 'F2', cmd: 'style_textures' },
        { label: 'Shadows', kbd: 'Alt+Sh+S', cmd: 'toggle_shadows' },
        { label: 'Edges', kbd: 'F8', cmd: 'toggle_edges' },
      ];

      const safeX = THREE.MathUtils.clamp(cx || window.innerWidth * 0.5, 165, window.innerWidth - 165);
      const safeY = THREE.MathUtils.clamp(cy || window.innerHeight * 0.45, 165, window.innerHeight - 165);
      const radius = 112;

      const wheelHtml = items
        .map((it, i) => {
          const ang = (i / items.length) * Math.PI * 2 - Math.PI * 0.5;
          const x = Math.cos(ang) * radius;
          const y = Math.sin(ang) * radius;
          return `<button type="button" class="su-pie-item" style="transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px)" data-idx="${i}"><strong>${it.label}</strong><span>${it.kbd}</span></button>`;
        })
        .join('');

      overlay.innerHTML = `<div class="su-pie-wheel" style="left:${safeX}px;top:${safeY}px"><div class="su-pie-center">CURIC VIEW</div>${wheelHtml}</div>`;
      overlay.classList.remove('hidden');
      this._pieOpen = true;

      overlay.querySelectorAll('.su-pie-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          const spec = items[Number(btn.dataset.idx)];
          this.closePieMenu();
          if (spec.tool) this.setActiveTool(spec.tool);
          else if (spec.cmd) this.runQuickCommand(spec.cmd);
        });
      });
    }

    closePieMenu() {
      const overlay = this.dom['su-pie-menu'];
      if (overlay) overlay.classList.add('hidden');
      this._pieOpen = false;
    }

    toggleShortcutsModal(forceState) {
      const modal = this.dom['su-shortcuts-modal'];
      if (!modal) return;
      const shouldOpen = typeof forceState === 'boolean' ? forceState : modal.classList.contains('hidden');
      modal.classList.toggle('hidden', !shouldOpen);
      if (shouldOpen && this.dom['su-shortcuts-search']) {
        this.dom['su-shortcuts-search'].value = '';
        this._renderShortcutTable('');
        setTimeout(() => this.dom['su-shortcuts-search'].focus(), 50);
      }
    }

    _renderShortcutTable(query) {
      const tbody = this.dom['su-shortcuts-tbody'];
      if (!tbody) return;
      const q = String(query || '').trim().toLowerCase();
      const filtered = SHORTCUT_CATALOG.filter(
        (r) =>
          !q ||
          r.key.toLowerCase().includes(q) ||
          r.desc.toLowerCase().includes(q) ||
          r.group.toLowerCase().includes(q)
      );
      tbody.innerHTML = filtered
        .map(
          (r) =>
            `<tr><td><span class="su-tbl-group">${r.group}</span></td><td><kbd class="su-tbl-kbd">${r.key}</kbd></td><td>${r.desc}</td></tr>`
        )
        .join('');
    }

    onResize() {
      if (this.isParallel) {
        this._syncOrthoFrustum();
      }
      if (this.isTwoPoint) {
        this._applyTwoPointViewOffset();
      }
      if (this.isSketchupMode() && this.dom['su-toolbar']) {
        if (window.innerWidth > 900) {
          const brandEl = document.querySelector('.hud-brand');
          if (brandEl) {
            this.dom['su-toolbar'].style.top = `${Math.round(brandEl.getBoundingClientRect().bottom + 10)}px`;
          }
        } else {
          this.dom['su-toolbar'].style.top = '';
        }
      }
    }
  }

  global.DalatSketchupController = DalatSketchupController;
})(window);
