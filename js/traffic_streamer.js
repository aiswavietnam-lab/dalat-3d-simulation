/**
 * traffic_streamer.js — Hệ Thống Giao Thông 3D Điêu Khắc & Đèn Đường 5 Bóng Đà Lạt
 * Dự án: DALAT_3D_SIMULATION (Three.js r128)
 * ============================================================================
 * - Vận hành ~340 phương tiện 3D điêu khắc bo cong + bánh trụ tròn (Xe khách Phương Trang/Đà Lạt,
 *   Ô tô/Sedan cổ điển, Xe máy Scooter có người lái) chạy mượt theo làn phải & độ dốc địa hình
 * - Đồng bộ hơn 650 trụ đèn đường 5 bóng kiểu Pháp (`./api/road-sidewalk-props.json`) dọc hai bên
 *   vỉa hè các tuyến phố chính bằng 3 draw calls InstancedMesh (60 FPS).
 */

(function (global) {
  'use strict';

  function mergePartGeometries(geoms) {
    const clean = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
    let totalVerts = 0;
    for (const g of clean) {
      totalVerts += g.attributes.position.count;
    }

    const pos = new Float32Array(totalVerts * 3);
    const nrm = new Float32Array(totalVerts * 3);
    let offset = 0;

    for (const g of clean) {
      if (!g.attributes.normal) g.computeVertexNormals();
      const p = g.attributes.position.array;
      const n = g.attributes.normal.array;
      pos.set(p, offset * 3);
      nrm.set(n, offset * 3);
      offset += g.attributes.position.count;
      g.dispose();
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.computeBoundingSphere();
    return out;
  }

  function extrudeProfileSide(pts2D, width, bevel = 0.08) {
    const shape = new THREE.Shape();
    shape.moveTo(pts2D[0][0], pts2D[0][1]);
    for (let i = 1; i < pts2D.length; i++) {
      shape.lineTo(pts2D[i][0], pts2D[i][1]);
    }
    shape.closePath();
    const innerW = Math.max(0.1, width - bevel * 2);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: innerW,
      bevelEnabled: bevel > 0.005,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 4,
    });
    // Map Shape (+X -> forward +Z, +Y -> height +Y) & center extruded depth along X
    g.rotateY(-Math.PI * 0.5);
    g.translate(innerW * 0.5, 0, 0);
    return g;
  }

  function makeWheel(x, y, z, radius, tireW) {
    const w = new THREE.CylinderGeometry(radius, radius, tireW, 12);
    w.rotateZ(Math.PI * 0.5);
    w.translate(x, y, z);
    return w;
  }

  function makeBox(w, h, d, x = 0, y = 0, z = 0, rx = 0) {
    const b = new THREE.BoxGeometry(w, h, d);
    if (rx) b.rotateX(rx);
    b.translate(x, y, z);
    return b;
  }

  class DalatTrafficStreamer {
    constructor(scene) {
      this.scene = scene;
      this.group = new THREE.Group();
      this.group.name = 'layer_live_traffic';
      this.scene.add(this.group);

      this.routes = [];
      this.enabled = true;
      this.loaded = false;

      this.busMeshes = null;
      this.carMeshes = null;
      this.bikeMeshes = null;
      this.lampGroup = null;

      this._tmpMat = new THREE.Matrix4();
      this._pos = new THREE.Vector3();
      this._fwd = new THREE.Vector3();
      this._right = new THREE.Vector3();
      this._up = new THREE.Vector3();
      this._worldUp = new THREE.Vector3(0, 1, 0);
    }

    setVisible(vis) {
      this.enabled = Boolean(vis);
      this.group.visible = this.enabled;
    }

    async loadRoutes(url = './api/road-traffic-routes.json') {
      // Load sculpted streetlamps concurrently (non-blocking)
      this._loadStreetLamps('./api/road-sidewalk-props.json');

      try {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) return false;
        const data = await resp.json();
        const rawRoutes = Array.isArray(data && data.routes) ? data.routes : [];
        if (rawRoutes.length === 0) return false;

        this.routes = [];
        for (const r of rawRoutes) {
          if (!Array.isArray(r.pts) || r.pts.length < 2) continue;
          const pts = r.pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
          const cum = [0];
          let tot = 0;
          for (let i = 1; i < pts.length; i++) {
            tot += pts[i].distanceTo(pts[i - 1]);
            cum.push(tot);
          }
          if (tot < 80) continue;
          this.routes.push({
            tier: r.tier || 2,
            laneOff: r.lane_off || 1.8,
            loop: Boolean(r.loop),
            pts,
            cum,
            totalLen: tot,
          });
        }

        if (this.routes.length === 0) return false;
        this._spawnVehiclesAndMeshes();
        this.loaded = true;
        return true;
      } catch (_) {
        return false;
      }
    }

    async _loadStreetLamps(url) {
      try {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) return;
        const data = await resp.json();
        const lamps = Array.isArray(data && data.lamps) ? data.lamps : [];
        if (lamps.length === 0) return;

        // 1. Cast-iron heritage dark-green post & curved 5-arm top candelabra
        const postParts = [];
        const basePed = new THREE.CylinderGeometry(0.14, 0.24, 0.85, 8);
        basePed.translate(0, 0.42, 0);
        postParts.push(basePed);
        const shaft = new THREE.CylinderGeometry(0.065, 0.115, 4.15, 8);
        shaft.translate(0, 2.88, 0);
        postParts.push(shaft);
        postParts.push(makeBox(0.95, 0.08, 0.08, 0, 4.92, 0));
        postParts.push(makeBox(0.08, 0.08, 0.95, 0, 4.92, 0));
        const postGeo = mergePartGeometries(postParts);

        // 2. Warm brass collar & 5 lantern cups
        const brassParts = [];
        const midCollar = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 8);
        midCollar.translate(0, 0.88, 0);
        brassParts.push(midCollar);
        for (const [gx, gy, gz] of [
          [0, 5.25, 0],
          [-0.44, 4.98, 0],
          [0.44, 4.98, 0],
          [0, 4.98, -0.44],
          [0, 4.98, 0.44],
        ]) {
          const cup = new THREE.CylinderGeometry(0.09, 0.05, 0.12, 7);
          cup.translate(gx, gy, gz);
          brassParts.push(cup);
        }
        const brassGeo = mergePartGeometries(brassParts);

        // 3. 5 glowing frosted cream globes
        const globeParts = [];
        for (const [gx, gy, gz, rad] of [
          [0, 5.45, 0, 0.2],
          [-0.44, 5.16, 0, 0.155],
          [0.44, 5.16, 0, 0.155],
          [0, 5.16, -0.44, 0.155],
          [0, 5.16, 0.44, 0.155],
        ]) {
          const sp = new THREE.SphereGeometry(rad, 8, 6);
          sp.translate(gx, gy, gz);
          globeParts.push(sp);
        }
        const globeGeo = mergePartGeometries(globeParts);

        const n = lamps.length;
        const mPost = new THREE.InstancedMesh(
          postGeo,
          new THREE.MeshStandardMaterial({ color: 0x1e352a, roughness: 0.55, metalness: 0.65 }),
          n
        );
        const mBrass = new THREE.InstancedMesh(
          brassGeo,
          new THREE.MeshStandardMaterial({ color: 0xc59a45, roughness: 0.35, metalness: 0.8 }),
          n
        );
        const mGlobes = new THREE.InstancedMesh(
          globeGeo,
          new THREE.MeshBasicMaterial({ color: 0xffecc2 }),
          n
        );
        mPost.castShadow = true;
        mPost.receiveShadow = true;
        mPost.frustumCulled = false;
        mBrass.frustumCulled = false;
        mGlobes.frustumCulled = false;

        const mat = new THREE.Matrix4();
        const rot = new THREE.Matrix4();
        for (let i = 0; i < n; i++) {
          const [lx, ly, lz, yaw] = lamps[i];
          rot.makeRotationY(yaw || 0);
          mat.makeTranslation(lx, ly, lz).multiply(rot);
          mPost.setMatrixAt(i, mat);
          mBrass.setMatrixAt(i, mat);
          mGlobes.setMatrixAt(i, mat);
        }
        mPost.instanceMatrix.needsUpdate = true;
        mBrass.instanceMatrix.needsUpdate = true;
        mGlobes.instanceMatrix.needsUpdate = true;
        this.group.add(mPost, mBrass, mGlobes);
      } catch (_) {}
    }

    _spawnVehiclesAndMeshes() {
      const busAgents = [];
      const carAgents = [];
      const bikeAgents = [];

      let seed = 18932027;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      const busPalette = [
        new THREE.Color('#E85A1B'), // Phương Trang FUTA Cam
        new THREE.Color('#196B47'), // Xe buýt xanh Đà Lạt
        new THREE.Color('#D94E28'), // Xe khách du lịch cam đỏ
        new THREE.Color('#235B8C'), // Xe khách cao nguyên xanh dương
      ];
      const carPalette = [
        new THREE.Color('#EDE5CF'), // Citroen cổ kem
        new THREE.Color('#F2B705'), // Taxi vàng Lado / Mai Linh
        new THREE.Color('#7C2430'), // Bordeaux cổ điển
        new THREE.Color('#2C5886'), // Xanh dương
        new THREE.Color('#CFD6DD'), // Bạc ánh kim
        new THREE.Color('#2E4C3E'), // Xanh rêu
        new THREE.Color('#F4F6F8'), // Trắng sứ
      ];
      const bikePalette = [
        new THREE.Color('#D63E3E'),
        new THREE.Color('#2B4F78'),
        new THREE.Color('#E09F1F'),
        new THREE.Color('#26323D'),
        new THREE.Color('#E6ECEF'),
        new THREE.Color('#3F6E58'),
      ];

      const totalWeight = this.routes.reduce(
        (acc, r) => acc + r.totalLen * (r.tier === 1 ? 1.85 : 0.85),
        0
      );

      const targetTotal = 340;
      for (let ri = 0; ri < this.routes.length; ri++) {
        const r = this.routes[ri];
        const share = (r.totalLen * (r.tier === 1 ? 1.85 : 0.85)) / Math.max(1, totalWeight);
        let count = Math.round(share * targetTotal);
        if (r.tier === 1 && count < 3 && r.totalLen > 160) count = 3;
        for (let k = 0; k < count; k++) {
          const pRoll = rand();
          const dir = rand() > 0.5 ? 1 : -1;
          const s = rand() * r.totalLen;
          const baseLane = r.laneOff * (0.85 + rand() * 0.28);

          if (pRoll < 0.14 && r.tier === 1) {
            busAgents.push({
              routeIdx: ri,
              s,
              dir,
              speed: 7.5 + rand() * 3.5,
              laneOff: baseLane * 0.92,
              color: busPalette[Math.floor(rand() * busPalette.length)],
            });
          } else if (pRoll < 0.56) {
            carAgents.push({
              routeIdx: ri,
              s,
              dir,
              speed: (r.tier === 1 ? 9.5 : 7.2) + rand() * 4.5,
              laneOff: baseLane,
              color: carPalette[Math.floor(rand() * carPalette.length)],
            });
          } else {
            bikeAgents.push({
              routeIdx: ri,
              s,
              dir,
              speed: (r.tier === 1 ? 10.5 : 8.4) + rand() * 4.2,
              laneOff: baseLane + 0.55 + rand() * 0.35,
              color: bikePalette[Math.floor(rand() * bikePalette.length)],
            });
          }
        }
      }

      // 1. SCULPTED COACH / BUS (+Z = front)
      if (busAgents.length > 0) {
        const bodyG = mergePartGeometries([
          // Aerodynamic curved coach body profile
          extrudeProfileSide(
            [
              [-4.25, 0.52],
              [4.12, 0.52],
              [4.28, 0.95],
              [4.24, 1.85],
              [3.88, 2.68],
              [3.55, 2.86],
              [-3.95, 2.86],
              [-4.22, 2.66],
            ],
            2.32,
            0.09
          ),
          // Roof AC pod
          makeBox(1.42, 0.2, 2.8, 0, 2.98, -0.45),
        ]);
        const trimG = mergePartGeometries([
          // Panoramic tinted side & front windshield belt
          makeBox(2.38, 0.88, 7.35, 0, 2.02, 0.35),
          makeBox(2.1, 0.92, 0.16, 0, 1.98, 4.18, -0.22), // sloped front windshield
          makeBox(2.38, 0.18, 8.45, 0, 0.52, 0),          // dark chassis bumper skirt
          // 6 genuine round rubber tires protruding below fender skirt
          makeWheel(-1.02, 0.44, 2.58, 0.44, 0.28),
          makeWheel(1.02, 0.44, 2.58, 0.44, 0.28),
          makeWheel(-1.02, 0.44, -2.15, 0.44, 0.28),
          makeWheel(1.02, 0.44, -2.15, 0.44, 0.28),
          makeWheel(-1.02, 0.44, -3.15, 0.44, 0.28),
          makeWheel(1.02, 0.44, -3.15, 0.44, 0.28),
        ]);
        const headG = mergePartGeometries([
          makeBox(0.36, 0.2, 0.14, -0.78, 0.84, 4.32),
          makeBox(0.36, 0.2, 0.14, 0.78, 0.84, 4.32),
        ]);
        const tailG = mergePartGeometries([
          makeBox(0.34, 0.26, 0.14, -0.84, 0.96, -4.3),
          makeBox(0.34, 0.26, 0.14, 0.84, 0.96, -4.3),
        ]);
        this.busMeshes = this._makeCompoundInstanced(busAgents, bodyG, trimG, headG, tailG, 0.26, 0.22);
      }

      // 2. SCULPTED SEDAN & VINTAGE CAR
      if (carAgents.length > 0) {
        const bodyG = mergePartGeometries([
          extrudeProfileSide(
            [
              [-2.05, 0.36],
              [2.02, 0.36],
              [2.12, 0.68],
              [1.92, 0.86],
              [0.98, 0.92],
              [0.42, 1.44],
              [-0.86, 1.44],
              [-1.48, 0.96],
              [-2.02, 0.9],
            ],
            1.74,
            0.07
          ),
        ]);
        const trimG = mergePartGeometries([
          // Tinted cabin glass + front/rear windshields
          extrudeProfileSide(
            [
              [-1.38, 0.96],
              [0.86, 0.96],
              [0.36, 1.4],
              [-0.82, 1.4],
            ],
            1.6,
            0.03
          ),
          // Bumpers & grill
          makeBox(1.76, 0.16, 4.18, 0, 0.36, -0.01),
          // 4 round wheels
          makeWheel(-0.82, 0.31, 1.28, 0.31, 0.22),
          makeWheel(0.82, 0.31, 1.28, 0.31, 0.22),
          makeWheel(-0.82, 0.31, -1.26, 0.31, 0.22),
          makeWheel(0.82, 0.31, -1.26, 0.31, 0.22),
        ]);
        const headG = mergePartGeometries([
          makeBox(0.28, 0.15, 0.12, -0.58, 0.66, 2.12),
          makeBox(0.28, 0.15, 0.12, 0.58, 0.66, 2.12),
        ]);
        const tailG = mergePartGeometries([
          makeBox(0.3, 0.14, 0.12, -0.58, 0.72, -2.08),
          makeBox(0.3, 0.14, 0.12, 0.58, 0.72, -2.08),
        ]);
        this.carMeshes = this._makeCompoundInstanced(carAgents, bodyG, trimG, headG, tailG, 0.2, 0.38);
      }

      // 3. SCOOTER / MOTORBIKE + HELMETED RIDER
      if (bikeAgents.length > 0) {
        const torso = new THREE.CylinderGeometry(0.16, 0.2, 0.64, 7);
        torso.rotateX(0.24);
        torso.translate(0, 1.04, -0.05);
        const head = new THREE.SphereGeometry(0.15, 8, 6);
        head.translate(0, 1.5, 0.04);
        const shield = makeBox(0.38, 0.48, 0.14, 0, 0.68, 0.45, -0.25);
        const bodyG = mergePartGeometries([torso, head, shield]);

        const trimG = mergePartGeometries([
          makeWheel(0, 0.24, 0.54, 0.24, 0.12),
          makeWheel(0, 0.24, -0.52, 0.24, 0.12),
          makeBox(0.24, 0.22, 0.92, 0, 0.58, -0.1),  // saddle & frame
          makeBox(0.56, 0.06, 0.06, 0, 0.96, 0.38),  // handlebar
        ]);
        const headG = mergePartGeometries([makeBox(0.15, 0.14, 0.1, 0, 0.86, 0.66)]);
        const tailG = mergePartGeometries([makeBox(0.14, 0.1, 0.1, 0, 0.64, -0.68)]);
        this.bikeMeshes = this._makeCompoundInstanced(bikeAgents, bodyG, trimG, headG, tailG, 0.42, 0.12);
      }

      this.update(0.016);
    }

    _makeCompoundInstanced(agents, bodyGeo, trimGeo, headGeo, tailGeo, roughVal, metalVal) {
      const count = agents.length;
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: roughVal,
        metalness: metalVal,
      });
      const trimMat = new THREE.MeshStandardMaterial({
        color: 0x1a2028,
        roughness: 0.22,
        metalness: 0.55,
      });
      const headMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
      const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2b1f });

      const mBody = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
      const mTrim = new THREE.InstancedMesh(trimGeo, trimMat, count);
      const mHead = new THREE.InstancedMesh(headGeo, headMat, count);
      const mTail = new THREE.InstancedMesh(tailGeo, tailMat, count);

      mBody.castShadow = true;
      mBody.receiveShadow = true;
      mBody.frustumCulled = false;
      mTrim.frustumCulled = false;
      mHead.frustumCulled = false;
      mTail.frustumCulled = false;

      for (let i = 0; i < count; i++) {
        mBody.setColorAt(i, agents[i].color);
      }
      if (mBody.instanceColor) mBody.instanceColor.needsUpdate = true;

      this.group.add(mBody, mTrim, mHead, mTail);
      return { agents, mBody, mTrim, mHead, mTail };
    }

    _sampleRoutePose(route, sTarget, dir, laneOff) {
      const s = Math.max(0.01, Math.min(route.totalLen - 0.01, sTarget));
      const cum = route.cum;
      const pts = route.pts;

      let lo = 0;
      let hi = cum.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid - 1;
      }

      const span = Math.max(1e-4, cum[lo + 1] - cum[lo]);
      const t = (s - cum[lo]) / span;
      this._pos.lerpVectors(pts[lo], pts[lo + 1], t);

      this._fwd.subVectors(pts[lo + 1], pts[lo]);
      if (dir < 0) this._fwd.negate();
      if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, 1);
      else this._fwd.normalize();

      this._right.crossVectors(this._fwd, this._worldUp);
      if (this._right.lengthSq() < 1e-6) this._right.set(1, 0, 0);
      else this._right.normalize();

      this._up.crossVectors(this._right, this._fwd).normalize();
      this._pos.addScaledVector(this._right, laneOff);

      const e = this._tmpMat.elements;
      e[0] = -this._right.x; e[4] = this._up.x; e[8]  = this._fwd.x; e[12] = this._pos.x;
      e[1] = -this._right.y; e[5] = this._up.y; e[9]  = this._fwd.y; e[13] = this._pos.y;
      e[2] = -this._right.z; e[6] = this._up.z; e[10] = this._fwd.z; e[14] = this._pos.z;
      e[3] = 0;              e[7] = 0;          e[11] = 0;           e[15] = 1;
    }

    _updateGroup(grp, dt) {
      if (!grp) return;
      const { agents, mBody, mTrim, mHead, mTail } = grp;
      for (let i = 0; i < agents.length; i++) {
        const ag = agents[i];
        const r = this.routes[ag.routeIdx];
        ag.s += ag.dir * ag.speed * dt;
        if (ag.s >= r.totalLen) {
          if (r.loop) ag.s %= r.totalLen;
          else { ag.s = r.totalLen - 0.1; ag.dir = -1; }
        } else if (ag.s <= 0) {
          if (r.loop) ag.s = ((ag.s % r.totalLen) + r.totalLen) % r.totalLen;
          else { ag.s = 0.1; ag.dir = 1; }
        }
        this._sampleRoutePose(r, ag.s, ag.dir, ag.laneOff);
        mBody.setMatrixAt(i, this._tmpMat);
        mTrim.setMatrixAt(i, this._tmpMat);
        mHead.setMatrixAt(i, this._tmpMat);
        mTail.setMatrixAt(i, this._tmpMat);
      }
      mBody.instanceMatrix.needsUpdate = true;
      mTrim.instanceMatrix.needsUpdate = true;
      mHead.instanceMatrix.needsUpdate = true;
      mTail.instanceMatrix.needsUpdate = true;
    }

    update(dt) {
      if (!this.loaded || !this.enabled) return;
      const step = Math.min(Math.max(dt || 0.016, 0.0), 0.08);
      this._updateGroup(this.busMeshes, step);
      this._updateGroup(this.carMeshes, step);
      this._updateGroup(this.bikeMeshes, step);
    }
  }

  global.DalatTrafficStreamer = DalatTrafficStreamer;
})(window);
