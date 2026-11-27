/**
 * traffic_streamer.js — Hệ Thống Giao Thông 3D Chuyển Động Thời Gian Thực Đà Lạt
 * Dự án: DALAT_3D_SIMULATION (Three.js r128)
 * ============================================================================
 * - Tải mạng lưới tuyến đường thật OpenStreetMap + Copernicus DEM (`./api/road-traffic-routes.json`)
 * - Vận hành ~220 phương tiện Đà Lạt (Xe khách Phương Trang cam, Xe buýt xanh, Ô tô cổ/du lịch,
 *   Taxi vàng, Xe máy/Scooter có đèn pha & đèn hậu phát sáng) bằng GPU InstancedMesh (~8 draw calls)
 * - Tự động bám theo đúng làn đường bên phải (Right-hand traffic) và độ dốc đèo thực tế 60 FPS.
 */

(function (global) {
  'use strict';

  function mergeBoxes(specs) {
    // Merge simple translated BoxGeometries cleanly into one indexed BufferGeometry (zero extra addons needed)
    let totalVerts = 0;
    let totalIdx = 0;
    const parts = specs.map((s) => {
      const g = new THREE.BoxGeometry(s.w, s.h, s.d);
      if (s.rx) g.rotateX(s.rx);
      if (s.x || s.y || s.z) g.translate(s.x || 0, s.y || 0, s.z || 0);
      totalVerts += g.attributes.position.count;
      totalIdx += g.index ? g.index.count : g.attributes.position.count;
      return g;
    });

    const pos = new Float32Array(totalVerts * 3);
    const nrm = new Float32Array(totalVerts * 3);
    const idx = new Uint32Array(totalIdx);
    let vOff = 0;
    let iOff = 0;

    for (const g of parts) {
      const p = g.attributes.position.array;
      const n = g.attributes.normal.array;
      const cnt = g.attributes.position.count;
      pos.set(p, vOff * 3);
      nrm.set(n, vOff * 3);
      if (g.index) {
        const gi = g.index.array;
        for (let k = 0; k < gi.length; k++) {
          idx[iOff + k] = gi[k] + vOff;
        }
        iOff += gi.length;
      } else {
        for (let k = 0; k < cnt; k++) {
          idx[iOff + k] = vOff + k;
        }
        iOff += cnt;
      }
      vOff += cnt;
      g.dispose();
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  class DalatTrafficStreamer {
    constructor(scene) {
      this.scene = scene;
      this.group = new THREE.Group();
      this.group.name = 'layer_live_traffic';
      this.scene.add(this.group);

      this.routes = [];
      this.agents = [];
      this.enabled = true;
      this.loaded = false;

      this.busMeshes = null;
      this.carMeshes = null;
      this.bikeMeshes = null;

      this._tmpMat = new THREE.Matrix4();
      this._headLightMat = new THREE.Matrix4();
      this._tailLightMat = new THREE.Matrix4();
      this._pos = new THREE.Vector3();
      this._fwd = new THREE.Vector3();
      this._right = new THREE.Vector3();
      this._up = new THREE.Vector3();
      this._worldUp = new THREE.Vector3(0, 1, 0);
      this._scaleOne = new THREE.Vector3(1, 1, 1);
      this._timeAcc = 0;
    }

    setVisible(vis) {
      this.enabled = Boolean(vis);
      this.group.visible = this.enabled;
    }

    async loadRoutes(url = './api/road-traffic-routes.json') {
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

    _spawnVehiclesAndMeshes() {
      const busAgents = [];
      const carAgents = [];
      const bikeAgents = [];

      // Deterministic PRNG so traffic looks rich right from t=0 on load
      let seed = 18932026;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };

      const busPalette = [
        new THREE.Color('#E85A1B'), // FUTA Phương Trang Cam
        new THREE.Color('#196B47'), // Xe buýt Thành Bưởi / Đà Lạt Xanh
        new THREE.Color('#D94E28'), // Shuttle Du lịch Cam Đỏ
        new THREE.Color('#235B8C'), // Xe khách Xanh Biển
      ];
      const carPalette = [
        new THREE.Color('#EDE5CF'), // Citroen cổ kem Đà Lạt
        new THREE.Color('#F2B705'), // Taxi Lado / Mai Linh vàng
        new THREE.Color('#7C2430'), // Bordeaux cổ điển
        new THREE.Color('#2C5886'), // Xanh dương cao nguyên
        new THREE.Color('#CFD6DD'), // Bạc
        new THREE.Color('#2E4C3E'), // Rêu thông
        new THREE.Color('#F5F7FA'), // Trắng sứ
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
        (acc, r) => acc + r.totalLen * (r.tier === 1 ? 1.8 : 0.8),
        0
      );

      const targetTotal = 220;
      for (let ri = 0; ri < this.routes.length; ri++) {
        const r = this.routes[ri];
        const share = (r.totalLen * (r.tier === 1 ? 1.8 : 0.8)) / Math.max(1, totalWeight);
        let count = Math.round(share * targetTotal);
        if (r.tier === 1 && count < 2 && r.totalLen > 180) count = 2;
        for (let k = 0; k < count; k++) {
          const pRoll = rand();
          const dir = rand() > 0.5 ? 1 : -1;
          const s = rand() * r.totalLen;
          const baseLane = r.laneOff * (0.85 + rand() * 0.28);

          if (pRoll < 0.16 && r.tier === 1) {
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
              speed: (r.tier === 1 ? 9.5 : 7.0) + rand() * 4.5,
              laneOff: baseLane,
              color: carPalette[Math.floor(rand() * carPalette.length)],
            });
          } else {
            bikeAgents.push({
              routeIdx: ri,
              s,
              dir,
              speed: (r.tier === 1 ? 10.2 : 8.2) + rand() * 4.2,
              laneOff: baseLane + 0.55 + rand() * 0.35,
              color: bikePalette[Math.floor(rand() * bikePalette.length)],
            });
          }
        }
      }

      // 1. BUSES (Forward = +Z in vehicle local coords)
      if (busAgents.length > 0) {
        const bodyG = mergeBoxes([
          { w: 2.28, h: 2.15, d: 8.5, y: 1.58 },         // raised coach body showing dark wheel wells cleanly
          { w: 1.55, h: 0.22, d: 3.1, y: 2.76, z: -0.4 }, // roof AC pod
        ]);
        const trimG = mergeBoxes([
          { w: 2.32, h: 0.88, d: 7.7, y: 1.96, z: 0.28 }, // dark panoramic glass windows
          { w: 2.34, h: 0.24, d: 8.6, y: 0.56 },          // dark lower bumper & rocker skirt
          { w: 0.34, h: 0.86, d: 0.86, x: -1.04, y: 0.43, z: 2.65 }, // FL wheel
          { w: 0.34, h: 0.86, d: 0.86, x: 1.04, y: 0.43, z: 2.65 },  // FR wheel
          { w: 0.34, h: 0.86, d: 0.86, x: -1.04, y: 0.43, z: -2.55 }, // RL wheel
          { w: 0.34, h: 0.86, d: 0.86, x: 1.04, y: 0.43, z: -2.55 },  // RR wheel
        ]);
        const headG = mergeBoxes([
          { w: 0.34, h: 0.22, d: 0.14, x: -0.78, y: 0.80, z: 4.30 },
          { w: 0.34, h: 0.22, d: 0.14, x: 0.78, y: 0.80, z: 4.30 },
        ]);
        const tailG = mergeBoxes([
          { w: 0.36, h: 0.2, d: 0.14, x: -0.82, y: 0.86, z: -4.30 },
          { w: 0.36, h: 0.2, d: 0.14, x: 0.82, y: 0.86, z: -4.30 },
        ]);
        this.busMeshes = this._makeCompoundInstanced(busAgents, bodyG, trimG, headG, tailG, 0.28, 0.2);
      }

      // 2. CARS & VINTAGE SEDANS
      if (carAgents.length > 0) {
        const bodyG = mergeBoxes([
          { w: 1.72, h: 0.72, d: 4.2, y: 0.62 },          // lower hull
          { w: 1.48, h: 0.56, d: 2.15, y: 1.22, z: -0.2 }, // upper cabin
        ]);
        const trimG = mergeBoxes([
          { w: 1.52, h: 0.44, d: 1.98, y: 1.22, z: -0.18 }, // windows wrap
          { w: 0.24, h: 0.58, d: 0.58, x: -0.78, y: 0.29, z: 1.32 },
          { w: 0.24, h: 0.58, d: 0.58, x: 0.78, y: 0.29, z: 1.32 },
          { w: 0.24, h: 0.58, d: 0.58, x: -0.78, y: 0.29, z: -1.28 },
          { w: 0.24, h: 0.58, d: 0.58, x: 0.78, y: 0.29, z: -1.28 },
        ]);
        const headG = mergeBoxes([
          { w: 0.28, h: 0.16, d: 0.12, x: -0.58, y: 0.64, z: 2.12 },
          { w: 0.28, h: 0.16, d: 0.12, x: 0.58, y: 0.64, z: 2.12 },
        ]);
        const tailG = mergeBoxes([
          { w: 0.3, h: 0.14, d: 0.12, x: -0.58, y: 0.68, z: -2.12 },
          { w: 0.3, h: 0.14, d: 0.12, x: 0.58, y: 0.68, z: -2.12 },
        ]);
        this.carMeshes = this._makeCompoundInstanced(carAgents, bodyG, trimG, headG, tailG, 0.22, 0.35);
      }

      // 3. MOTORBIKES & RIDERS
      if (bikeAgents.length > 0) {
        const bodyG = mergeBoxes([
          { w: 0.42, h: 0.68, d: 0.55, y: 1.05, z: -0.05 }, // rider torso coat
          { w: 0.28, h: 0.28, d: 0.28, y: 1.54, z: 0.02 },  // rider helmet
        ]);
        const trimG = mergeBoxes([
          { w: 0.36, h: 0.52, d: 1.55, y: 0.46, z: 0.0 },   // scooter frame & wheels
        ]);
        const headG = mergeBoxes([
          { w: 0.16, h: 0.14, d: 0.12, y: 0.88, z: 0.78 },
        ]);
        const tailG = mergeBoxes([
          { w: 0.14, h: 0.12, d: 0.1, y: 0.72, z: -0.78 },
        ]);
        this.bikeMeshes = this._makeCompoundInstanced(bikeAgents, bodyG, trimG, headG, tailG, 0.42, 0.08);
      }

      // Initial placement at t = 0
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

      // Binary search segment index
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

      // Right-hand perpendicular vector on XZ plane (+forward cross worldUp? Note: forward X worldUp gives RIGHT!)
      this._right.crossVectors(this._fwd, this._worldUp);
      if (this._right.lengthSq() < 1e-6) this._right.set(1, 0, 0);
      else this._right.normalize();

      // Road slope orthogonal up vector (local Z forward = _fwd, local X = -_right so makeBasis aligns front=+Z!)
      // Check handedness: (-right) x up = fwd => right x fwd = up => cross(up, fwd) = -right!
      // Using Basis(X = -right, Y = roadUp, Z = fwd) makes +Z = moving forward & det = +1!
      this._up.crossVectors(this._right, this._fwd).normalize();

      // Shift to right-hand lane
      this._pos.addScaledVector(this._right, laneOff);

      const negRightX = -this._right.x;
      const negRightY = -this._right.y;
      const negRightZ = -this._right.z;

      const e = this._tmpMat.elements;
      e[0] = negRightX; e[4] = this._up.x; e[8]  = this._fwd.x; e[12] = this._pos.x;
      e[1] = negRightY; e[5] = this._up.y; e[9]  = this._fwd.y; e[13] = this._pos.y;
      e[2] = negRightZ; e[6] = this._up.z; e[10] = this._fwd.z; e[14] = this._pos.z;
      e[3] = 0;         e[7] = 0;          e[11] = 0;           e[15] = 1;
    }

    _updateGroup(grp, dt) {
      if (!grp) return;
      const { agents, mBody, mTrim, mHead, mTail } = grp;
      for (let i = 0; i < agents.length; i++) {
        const ag = agents[i];
        const r = this.routes[ag.routeIdx];
        ag.s += ag.dir * ag.speed * dt;
        if (ag.s >= r.totalLen) {
          if (r.loop) {
            ag.s %= r.totalLen;
          } else {
            ag.s = r.totalLen - 0.1;
            ag.dir = -1;
          }
        } else if (ag.s <= 0) {
          if (r.loop) {
            ag.s = ((ag.s % r.totalLen) + r.totalLen) % r.totalLen;
          } else {
            ag.s = 0.1;
            ag.dir = 1;
          }
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
