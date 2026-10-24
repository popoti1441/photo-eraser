// 사진 지우개 엔진 — 워커와 Node 테스트에서 함께 쓰는 순수 JS
// 이미지: {w, h, d: Uint8ClampedArray(RGBA)}, 마스크: Uint8Array(w*h, 0/1)
(function (root) {
  'use strict';

  // ───────────── 기본 도구 ─────────────
  function bbox(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[row + x]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // 1D 최대/최소 필터 (van Herk–Gil-Werman, O(n))
  function line1d(src, dst, n, stride, off, k, isMax, g, hbuf) {
    const r = k >> 1;
    const pad = n + 2 * r;
    const len = Math.ceil(pad / k) * k;
    const ext = isMax ? -Infinity : Infinity;
    const at = (i) => { const j = i - r; return (j < 0 || j >= n) ? ext : src[off + j * stride]; };
    for (let b = 0; b < len; b += k) {
      g[b] = at(b);
      for (let i = 1; i < k; i++) { const v = at(b + i); g[b + i] = isMax ? Math.max(g[b + i - 1], v) : Math.min(g[b + i - 1], v); }
      hbuf[b + k - 1] = at(b + k - 1);
      for (let i = k - 2; i >= 0; i--) { const v = at(b + i); hbuf[b + i] = isMax ? Math.max(hbuf[b + i + 1], v) : Math.min(hbuf[b + i + 1], v); }
    }
    for (let i = 0; i < n; i++) {
      const a = hbuf[i], c = g[i + k - 1];
      dst[off + i * stride] = isMax ? Math.max(a, c) : Math.min(a, c);
    }
  }
  // 정사각형 커널 팽창(max)/침식(min). src: TypedArray, k: 홀수
  function morph(src, w, h, k, isMax) {
    if (k <= 1) return src.slice();
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const n = Math.max(w, h) + 2 * k + k;
    const g = new Float32Array(n + k), hb = new Float32Array(n + k);
    for (let y = 0; y < h; y++) line1d(src, tmp, w, 1, y * w, k, isMax, g, hb);
    for (let x = 0; x < w; x++) line1d(tmp, out, h, w, x, k, isMax, g, hb);
    return out;
  }
  const dilate = (m, w, h, k) => toU8(morph(m, w, h, odd(k), true));
  const erode = (m, w, h, k) => toU8(morph(m, w, h, odd(k), false));
  const close = (m, w, h, k) => erode(dilate(m, w, h, k), w, h, k);
  const open = (m, w, h, k) => dilate(erode(m, w, h, k), w, h, k);
  function odd(k) { k = Math.max(1, Math.round(k)); return k % 2 ? k : k + 1; }
  function toU8(f) { const o = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) o[i] = f[i] > 0.5 ? 1 : 0; return o; }

  // 박스 블러(3회 반복 ≈ 가우시안), Float32 단일 채널
  function boxBlur(src, w, h, r) {
    r = Math.max(1, Math.round(r));
    let a = Float32Array.from(src), b = new Float32Array(w * h);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < h; y++) {
        const o = y * w; let s = 0, c = 0;
        for (let x = -r; x <= r; x++) if (x >= 0 && x < w) { s += a[o + x]; c++; }
        for (let x = 0; x < w; x++) {
          b[o + x] = s / c;
          const xo = x - r, xi = x + r + 1;
          if (xo >= 0) { s -= a[o + xo]; c--; }
          if (xi < w) { s += a[o + xi]; c++; }
        }
      }
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let y = -r; y <= r; y++) if (y >= 0 && y < h) { s += b[y * w + x]; c++; }
        for (let y = 0; y < h; y++) {
          a[y * w + x] = s / c;
          const yo = y - r, yi = y + r + 1;
          if (yo >= 0) { s -= b[yo * w + x]; c--; }
          if (yi < h) { s += b[yi * w + x]; c++; }
        }
      }
    }
    return a;
  }

  // 연결 요소: 각 요소의 {area, x0,y0,x1,y1}와 라벨 배열
  function components(m, w, h) {
    const lab = new Int32Array(w * h).fill(-1), comps = [], stack = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!m[i] || lab[i] >= 0) continue;
      const id = comps.length; let sp = 0; stack[sp++] = i; lab[i] = id;
      const c = { area: 0, x0: w, y0: h, x1: 0, y1: 0 };
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        c.area++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        if (x > 0 && m[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && m[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && m[p - w] && lab[p - w] < 0) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && m[p + w] && lab[p + w] < 0) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      comps.push(c);
    }
    return { lab, comps };
  }

  // RGBA → 축소 RGB(Float32, 면적 평균)
  function resizeRGB(d, w, h, nw, nh) {
    const out = new Float32Array(nw * nh * 3), sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
      const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.min(h, Math.floor((y + 1) * sy)));
      for (let x = 0; x < nw; x++) {
        const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.min(w, Math.floor((x + 1) * sx)));
        let r = 0, g = 0, b = 0, c = 0;
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) {
          const i = (yy * w + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; c++;
        }
        const o = (y * nw + x) * 3; out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c;
      }
    }
    return out;
  }
  // 마스크 축소: 하나라도 걸리면 1
  function resizeMaskAny(m, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh), sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
      const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.min(h, Math.ceil((y + 1) * sy)));
      for (let x = 0; x < nw; x++) {
        const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.min(w, Math.ceil((x + 1) * sx)));
        let any = 0;
        for (let yy = ya; yy < yb && !any; yy++) for (let xx = xa; xx < xb; xx++) if (m[yy * w + xx]) { any = 1; break; }
        out[y * nw + x] = any;
      }
    }
    return out;
  }
  // 마스크 확대(최근접)
  function upMask(m, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, Math.floor(y * h / nh));
      for (let x = 0; x < nw; x++) out[y * nw + x] = m[sy * w + Math.min(w - 1, Math.floor(x * w / nw))];
    }
    return out;
  }
  // RGB float 이중선형 샘플
  function sampleRGB(img, w, h, fx, fy, out) {
    fx = Math.max(0, Math.min(w - 1, fx)); fy = Math.max(0, Math.min(h - 1, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 3; c++) {
      const a = img[(y0 * w + x0) * 3 + c], b = img[(y0 * w + x1) * 3 + c];
      const cc = img[(y1 * w + x0) * 3 + c], dd = img[(y1 * w + x1) * 3 + c];
      out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + dd * ax) * ay;
    }
  }

  // ───────────── 1) 채우기: 다중 해상도 PatchMatch ─────────────
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  function down2(img, hole, w, h) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const o = new Float32Array(nw * nh * 3), m = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let any = 0; const acc = [0, 0, 0]; let c = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const xx = Math.min(w - 1, 2 * x + dx), yy = Math.min(h - 1, 2 * y + dy), i = yy * w + xx;
        if (hole[i]) any = 1;
        acc[0] += img[i * 3]; acc[1] += img[i * 3 + 1]; acc[2] += img[i * 3 + 2]; c++;
      }
      const j = y * nw + x; m[j] = any;
      o[j * 3] = acc[0] / c; o[j * 3 + 1] = acc[1] / c; o[j * 3 + 2] = acc[2] / c;
    }
    return { img: o, hole: m, w: nw, h: nh };
  }

  // 구멍 안쪽에서 가장자리까지의 최대 거리(체스판 거리, 2패스)
  function maxHoleRadius(hole, w, h) {
    const d = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = hole[i] ? 1e9 : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + 1); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1); }
      d[i] = v;
    }
    let mx = 0;
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1); if (x > 0) v = Math.min(v, d[i + w - 1] + 1); }
      d[i] = v; if (v > mx) mx = v;
    }
    return mx;
  }

  // 구멍을 주변 평균으로 대충 채움(가장 거친 단계 초기값)
  function pushPullFill(img, hole, w, h) {
    const known = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) known[i] = hole[i] ? 0 : 1;
    for (let it = 0; it < 64; it++) {
      let changed = false;
      const nk = known.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (known[i]) continue;
        let s0 = 0, s1 = 0, s2 = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (!known[j]) continue;
          s0 += img[j * 3]; s1 += img[j * 3 + 1]; s2 += img[j * 3 + 2]; c++;
        }
        if (c) { img[i * 3] = s0 / c; img[i * 3 + 1] = s1 / c; img[i * 3 + 2] = s2 / c; nk[i] = 1; changed = true; }
      }
      known.set(nk);
      if (!changed) break;
    }
  }

  function patchMatchLevel(L, nnx, nny, iters, r, rand, onTick) {
    const { img, hole, w, h } = L;
    const P = 2 * r + 1;
    // 원본 후보: 패치 전체가 알려진 중심
    const holeF = new Float32Array(w * h); for (let i = 0; i < w * h; i++) holeF[i] = hole[i];
    const holeDil = morph(holeF, w, h, P, true);
    const valid = new Uint8Array(w * h); const validList = [];
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) { const i = y * w + x; if (!holeDil[i]) { valid[i] = 1; validList.push(i); } }
    if (!validList.length) return false;
    // 대상: 패치가 구멍과 겹치는 중심
    const targets = [];
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) if (holeDil[y * w + x]) targets.push(y * w + x);
    const isT = new Uint8Array(w * h); for (const t of targets) isT[t] = 1;
    const dist = new Float32Array(w * h).fill(Infinity);

    function d(tx, ty, sx, sy, best) {
      let s = 0;
      for (let dy = -r; dy <= r; dy++) {
        let ti = ((ty + dy) * w + tx - r) * 3, si = ((sy + dy) * w + sx - r) * 3;
        for (let k = 0; k < P * 3; k++) { const e = img[ti + k] - img[si + k]; s += e * e; }
        if (s >= best) return s;
      }
      return s;
    }
    // 주변에서 가져오는 게 자연스러움: 탐색 범위를 대상 근처로 제한(지역성)
    const win = Math.max(12, Math.round(Math.max(w, h) * 0.18));
    const randSrc = (tx, ty) => {
      for (let rr = win; rr < 4 * Math.max(w, h); rr *= 2) {
        for (let k = 0; k < 40; k++) {
          const x = Math.round(tx + (rand() * 2 - 1) * rr), y = Math.round(ty + (rand() * 2 - 1) * rr);
          if (x >= r && y >= r && x < w - r && y < h - r && valid[y * w + x]) return y * w + x;
        }
      }
      return validList[(rand() * validList.length) | 0];
    };
    // 초기화/재평가
    for (const t of targets) {
      const tx = t % w, ty = (t / w) | 0;
      let sx = nnx[t], sy = nny[t];
      if (sx < 0 || !valid[sy * w + sx]) { const s = randSrc(tx, ty); sx = s % w; sy = (s / w) | 0; }
      nnx[t] = sx; nny[t] = sy; dist[t] = d(tx, ty, sx, sy, Infinity);
    }
    const maxR = win;
    for (let it = 0; it < iters; it++) {
      const rev = it % 2 === 1, step = rev ? -1 : 1;
      for (let n = 0; n < targets.length; n++) {
        const t = targets[rev ? targets.length - 1 - n : n];
        const tx = t % w, ty = (t / w) | 0;
        let bx = nnx[t], by = nny[t], bd = dist[t];
        // 전파
        for (const [ox, oy] of [[-step, 0], [0, -step]]) {
          const nx = tx + ox, ny = ty + oy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx; if (!isT[ni]) continue;
          const cx = nnx[ni] - ox, cy = nny[ni] - oy;
          if (cx < r || cy < r || cx >= w - r || cy >= h - r || !valid[cy * w + cx]) continue;
          const dd = d(tx, ty, cx, cy, bd); if (dd < bd) { bd = dd; bx = cx; by = cy; }
        }
        // 무작위 탐색
        for (let R = maxR; R >= 1; R >>= 1) {
          const cx = Math.round(bx + (rand() * 2 - 1) * R), cy = Math.round(by + (rand() * 2 - 1) * R);
          if (cx < r || cy < r || cx >= w - r || cy >= h - r || !valid[cy * w + cx]) continue;
          const dd = d(tx, ty, cx, cy, bd); if (dd < bd) { bd = dd; bx = cx; by = cy; }
        }
        // 가끔 완전 무작위 후보
        { const s = randSrc(tx, ty), cx = s % w, cy = (s / w) | 0; const dd = d(tx, ty, cx, cy, bd); if (dd < bd) { bd = dd; bx = cx; by = cy; } }
        nnx[t] = bx; nny[t] = by; dist[t] = bd;
      }
      if (onTick) onTick();
    }
    // 투표: 겹치는 패치들의 가중 평균으로 구멍 픽셀 갱신
    const acc = new Float32Array(w * h * 3), wsum = new Float32Array(w * h);
    let ds = []; for (const t of targets) ds.push(dist[t]);
    ds.sort((a, b) => a - b);
    const sig2 = Math.max(1, ds[Math.floor(ds.length * 0.75)] || 1);
    for (const t of targets) {
      const tx = t % w, ty = (t / w) | 0, sx = nnx[t], sy = nny[t];
      const wt = Math.exp(-dist[t] / (2 * sig2)) + 1e-6;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const pi = (ty + dy) * w + tx + dx; if (!hole[pi]) continue;
        const si = ((sy + dy) * w + sx + dx) * 3;
        acc[pi * 3] += wt * img[si]; acc[pi * 3 + 1] += wt * img[si + 1]; acc[pi * 3 + 2] += wt * img[si + 2]; wsum[pi] += wt;
      }
    }
    for (let i = 0; i < w * h; i++) if (hole[i] && wsum[i] > 0) {
      img[i * 3] = acc[i * 3] / wsum[i]; img[i * 3 + 1] = acc[i * 3 + 1] / wsum[i]; img[i * 3 + 2] = acc[i * 3 + 2] / wsum[i];
    }
    return true;
  }

  // crop: {w,h,d RGBA}, hole: Uint8Array → 채워진 RGB Float32 (작업 해상도)와 크기 반환
  function inpaintCrop(crop, hole, opts) {
    opts = opts || {};
    const maxDim = opts.maxDim || 1400;
    const rand = rng(opts.seed || 12345);
    const progress = opts.progress || (() => {});
    const s = Math.min(1, maxDim / Math.max(crop.w, crop.h));
    const W = Math.max(8, Math.round(crop.w * s)), H = Math.max(8, Math.round(crop.h * s));
    let img0 = resizeRGB(crop.d, crop.w, crop.h, W, H);
    let hole0 = s < 1 ? resizeMaskAny(hole, crop.w, crop.h, W, H) : hole.slice();
    hole0 = dilate(hole0, W, H, 3);
    // 피라미드
    // 단계 수: 구멍의 가장 두꺼운 곳이 맨 위 단계에서 몇 픽셀 정도가 되도록만 줄임
    // (너무 줄이면 구멍이 사진을 뒤덮어 엉뚱한 색이 굳어버림)
    const thick = maxHoleRadius(hole0, W, H);
    const maxLevels = Math.max(1, Math.ceil(Math.log2(Math.max(1, thick / 3))) + 1);
    const pyr = [{ img: img0, hole: hole0, w: W, h: H }];
    while (pyr.length < maxLevels) {
      const top = pyr[pyr.length - 1];
      if (Math.max(top.w, top.h) <= 64 || Math.min(top.w, top.h) <= 24) break;
      pyr.push(down2(top.img, top.hole, top.w, top.h));
    }
    const nLev = pyr.length;
    let nnx = null, nny = null, prevW = 0, prevH = 0;
    let done = 0; const total = pyr.reduce((a, _, i) => a + (i === nLev - 1 ? 6 : i === 0 ? 3 : 4), 0);
    for (let li = nLev - 1; li >= 0; li--) {
      const L = pyr[li], { w, h } = L;
      const r = Math.min(3, Math.max(1, Math.floor(Math.min(w, h) / 8)));
      const NX = new Int32Array(w * h).fill(-1), NY = new Int32Array(w * h).fill(-1);
      if (li === nLev - 1) {
        pushPullFill(L.img, L.hole, w, h);
      } else {
        // 이전 단계 대응 관계를 2배 확대해서 초기값으로
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const px = Math.min(prevW - 1, x >> 1), py = Math.min(prevH - 1, y >> 1), pi = py * prevW + px;
          if (nnx[pi] >= 0) { NX[y * w + x] = Math.min(w - 1, nnx[pi] * 2 + (x & 1)); NY[y * w + x] = Math.min(h - 1, nny[pi] * 2 + (y & 1)); }
        }
        // 구멍 픽셀 초기값: 이전 단계 결과 확대
        const prev = pyr[li + 1], tmp = [0, 0, 0];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x; if (!L.hole[i]) continue;
          sampleRGB(prev.img, prev.w, prev.h, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5, tmp);
          L.img[i * 3] = tmp[0]; L.img[i * 3 + 1] = tmp[1]; L.img[i * 3 + 2] = tmp[2];
        }
      }
      const em = li === nLev - 1 ? 6 : li === 0 ? 3 : 4;
      for (let e = 0; e < em; e++) {
        const ok = patchMatchLevel(L, NX, NY, li === 0 ? 2 : 3, r, rand);
        if (!ok) break;
        done++; progress(done / total);
      }
      nnx = NX; nny = NY; prevW = w; prevH = h;
    }
    return { img: pyr[0].img, w: W, h: H };
  }

  // 전체 사진에서 마스크 영역 채우기 → 바뀐 영역의 RGBA 패치 반환
  function inpaint(image, mask, opts) {
    const bb = bbox(mask, image.w, image.h);
    if (!bb) return null;
    const pad = Math.round(Math.max(bb.w, bb.h) * 0.6) + 48;
    const x0 = Math.max(0, bb.x - pad), y0 = Math.max(0, bb.y - pad);
    const x1 = Math.min(image.w, bb.x + bb.w + pad), y1 = Math.min(image.h, bb.y + bb.h + pad);
    const cw = x1 - x0, ch = y1 - y0;
    const crop = { w: cw, h: ch, d: new Uint8ClampedArray(cw * ch * 4) }, hole = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      crop.d.set(image.d.subarray(((y + y0) * image.w + x0) * 4, ((y + y0) * image.w + x1) * 4), y * cw * 4);
      for (let x = 0; x < cw; x++) hole[y * cw + x] = mask[(y + y0) * image.w + x + x0] ? 1 : 0;
    }
    const res = inpaintCrop(crop, hole, opts);
    // 원본 해상도로 합성: 구멍(+1px)만 교체, 경계는 살짝 섞음
    const holeD = dilate(hole, cw, ch, 3);
    const soft = boxBlur(Float32Array.from(holeD), cw, ch, 1);
    const out = new Uint8ClampedArray(crop.d), tmp = [0, 0, 0];
    const sx = res.w / cw, sy = res.h / ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x; const a = hole[i] ? 1 : soft[i]; if (a <= 0.001) continue;
      sampleRGB(res.img, res.w, res.h, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, tmp);
      const o = i * 4;
      out[o] = out[o] * (1 - a) + tmp[0] * a; out[o + 1] = out[o + 1] * (1 - a) + tmp[1] * a; out[o + 2] = out[o + 2] * (1 - a) + tmp[2] * a;
    }
    // 작업 해상도가 낮았으면 같은 결의 노이즈를 살짝 더해 주변과 질감 맞춤
    if (sx < 0.95) addGrain(out, crop.d, hole, cw, ch, opts.seed || 7);
    return { x: x0, y: y0, w: cw, h: ch, d: out };
  }

  function addGrain(out, ref, hole, w, h, seed) {
    // 주변(구멍 아님) 고주파 잡음 세기 추정
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * ref[i * 4] + 0.587 * ref[i * 4 + 1] + 0.114 * ref[i * 4 + 2];
    const bl = boxBlur(g, w, h, 1);
    const diffs = [];
    for (let i = 0; i < w * h; i += 7) if (!hole[i]) diffs.push(Math.abs(g[i] - bl[i]));
    if (!diffs.length) return;
    diffs.sort((a, b) => a - b);
    const sd = Math.min(6, 1.4826 * diffs[diffs.length >> 1] * 1.2);
    if (sd < 0.3) return;
    const rand = rng(seed);
    for (let i = 0; i < w * h; i++) {
      if (!hole[i]) continue;
      const n = (rand() + rand() + rand() - 1.5) * 2 * sd;
      out[i * 4] += n; out[i * 4 + 1] += n; out[i * 4 + 2] += n;
    }
  }

  // ───────────── 2) 하늘 전선 자동 선택 ─────────────
  function srgbToLab8(r, g, b) {
    const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const R = f(r), G = f(g), B = f(b);
    let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const t = (v) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
    X = t(X); Y = t(Y); Z = t(Z);
    return [(116 * Y - 16) * 255 / 100, 500 * (X - Y) + 128, 200 * (Y - Z) + 128];
  }

  function detectWires(image, opts) {
    opts = opts || {};
    const sens = opts.sensitivity == null ? 1 : opts.sensitivity; // 0.5~1.5
    const s = Math.min(1, 1400 / Math.max(image.w, image.h));
    const w = Math.round(image.w * s), h = Math.round(image.h * s);
    const kk = w / 1500; // 작업 해상도 기준 커널 배율
    const rgb = resizeRGB(image.d, image.w, image.h, w, h);
    const L = new Float32Array(w * h), cand = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const [l, a, b] = srgbToLab8(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      L[i] = l; cand[i] = (l > 140 && b < 132) ? 1 : 0; // 밝고 푸른/보랏빛 계열 = 하늘 후보
    }
    // 하늘: 위에서부터 이어진 밝은 영역(전선 틈은 메움)
    const cc = close(cand, w, h, 27 * kk);
    const sky = new Uint8Array(w * h), gap = Math.round(20 * kk);
    for (let x = 0; x < w; x++) {
      let miss = 0, last = -1;
      for (let y = 0; y < h; y++) { if (cc[y * w + x]) { miss = 0; last = y; } else if (++miss > gap) break; }
      for (let y = 0; y <= last; y++) sky[y * w + x] = 1;
    }
    let skyM = open(sky, w, h, 5 * kk);
    skyM = erode(skyM, w, h, 3);
    // 블랙햇: 밝은 배경 위 가늘고 어두운 선
    const closed = morph(morph(L, w, h, odd(19 * kk), true), w, h, odd(19 * kk), false);
    const thr = 12 / sens;
    const line = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) line[i] = (skyM[i] && closed[i] - L[i] > thr) ? 1 : 0;
    // 굵은 덩어리(나뭇잎 뭉치 등) 제거: 열림 연산으로 남는 부분과 선이 빽빽한 곳은 제외
    const line0 = line.slice();
    const blob = dilate(open(line, w, h, Math.max(7, 12 * kk)), w, h, 5);
    const dens = boxBlur(Float32Array.from(line), w, h, Math.max(5, Math.round(12 * kk)));
    for (let i = 0; i < w * h; i++) if (blob[i] || dens[i] > 0.42) line[i] = 0;
    const { lab, comps } = components(line, w, h);
    const keep = new Uint8Array(comps.length);
    comps.forEach((c, i) => {
      const ext = Math.max(c.x1 - c.x0, c.y1 - c.y0) + 1;
      keep[i] = ext > 18 * kk ? 1 : 0; // 짧은 점·티끌 제외
    });
    let m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (lab[i] >= 0 && keep[lab[i]]) m[i] = 1;
    // 교차점 등에서 끊긴 부분 복원: 걸러지기 전 선 중 이어진 부분을 조금씩 다시 붙임
    for (let it = 0; it < 4; it++) {
      const g = dilate(m, w, h, 5);
      for (let i = 0; i < w * h; i++) if (g[i] && line0[i]) m[i] = 1;
    }
    m = close(m, w, h, Math.max(5, 9 * kk));
    for (let i = 0; i < w * h; i++) if (!skyM[i]) m[i] = 0;
    if (opts.debug) opts.debug({ w, h, sky: skyM, line, keep: m, cand });
    m = dilate(m, w, h, 3);
    let full = upMask(m, w, h, image.w, image.h);
    full = dilate(full, image.w, image.h, Math.max(3, Math.round(2 / s) | 1));
    return full;
  }

  // ───────────── 3) 보정본 합성 ─────────────
  // 두 사진 차이가 큰 곳(=보정본에서 지운 곳) 자동 선택
  function diffMask(a, b, opts) {
    opts = opts || {};
    const sens = opts.sensitivity == null ? 1 : opts.sensitivity;
    const s = Math.min(1, 1500 / Math.max(a.w, a.h));
    const w = Math.round(a.w * s), h = Math.round(a.h * s), kk = w / 1500;
    const A = resizeRGB(a.d, a.w, a.h, w, h), B = resizeRGB(b.d, b.w, b.h, w, h);
    const LA = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)], LB = LA.map(() => new Float32Array(w * h));
    for (let i = 0; i < w * h; i++) {
      const p = srgbToLab8(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]), q = srgbToLab8(B[i * 3], B[i * 3 + 1], B[i * 3 + 2]);
      for (let c = 0; c < 3; c++) { LA[c][i] = p[c]; LB[c][i] = q[c]; }
    }
    // (1) 덩어리 변화: 충분히 흐리게 한 색 차이(전구·잎 같은 잔무늬 차이는 무시)
    const r = Math.max(2, Math.round(5 * kk));
    const BA = LA.map((ch) => boxBlur(ch, w, h, r)), BB = LB.map((ch) => boxBlur(ch, w, h, r));
    const mean = [0, 0, 0]; for (let c = 0; c < 3; c++) { let t = 0; for (let i = 0; i < w * h; i++) t += BB[c][i] - BA[c][i]; mean[c] = t / (w * h); }
    const thr = 20 / sens;
    let m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const d0 = (BA[0][i] + mean[0] - BB[0][i]) * 0.39, d1 = BA[1][i] + mean[1] - BB[1][i], d2 = BA[2][i] + mean[2] - BB[2][i];
      m[i] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) > thr ? 1 : 0;
    }
    m = open(m, w, h, 3);
    { const { lab, comps } = components(m, w, h); const minA = 200 * kk * kk;
      for (let i = 0; i < w * h; i++) if (lab[i] >= 0 && comps[lab[i]].area < minA) m[i] = 0; }
    // (2) 가는 선 제거(전선·가지 등): 원본에만 있는 어두운 선
    const k = odd(13 * kk);
    const bhA = morph(morph(LA[0], w, h, k, true), w, h, k, false), bhB = morph(morph(LB[0], w, h, k, true), w, h, k, false);
    // 보정본에서 그 자리가 매끈해진 곳(하늘·벽)만 인정 → 트리 전구 같은 복잡한 무늬는 제외
    const mB = boxBlur(LB[0], w, h, Math.max(2, Math.round(4 * kk)));
    const sq = new Float32Array(w * h); for (let i = 0; i < w * h; i++) { const d = LB[0][i] - mB[i]; sq[i] = d * d; }
    const varB = boxBlur(sq, w, h, Math.max(2, Math.round(4 * kk)));
    const ln = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const ra = bhA[i] - LA[0][i], rb = bhB[i] - LB[0][i];
      ln[i] = (ra - rb > 14 / sens && ra > 16 / sens && varB[i] < 60) ? 1 : 0;
    }
    { const { lab, comps } = components(ln, w, h);
      for (let i = 0; i < w * h; i++) if (lab[i] >= 0) { const c = comps[lab[i]]; if (Math.max(c.x1 - c.x0, c.y1 - c.y0) < 15 * kk) ln[i] = 0; } }
    const lnD = dilate(ln, w, h, 3);
    for (let i = 0; i < w * h; i++) if (lnD[i]) m[i] = 1;
    m = close(m, w, h, 7 * kk);
    m = dilate(m, w, h, 5 * kk);
    return upMask(m, w, h, a.w, a.h);
  }

  // 보정본(b)에서 마스크 영역만 원본(a)에 합성 → 바뀐 영역 RGBA 패치
  function composite(a, b, mask) {
    const bb = bbox(mask, a.w, a.h); if (!bb) return null;
    const ring = Math.round(Math.max(a.w, a.h) / 120) + 8;
    const x0 = Math.max(0, bb.x - ring * 2), y0 = Math.max(0, bb.y - ring * 2);
    const x1 = Math.min(a.w, bb.x + bb.w + ring * 2), y1 = Math.min(a.h, bb.y + bb.h + ring * 2);
    const cw = x1 - x0, ch = y1 - y0;
    const m = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) m[y * cw + x] = mask[(y + y0) * a.w + x + x0] ? 1 : 0;
    const rd = dilate(m, cw, ch, ring);
    // 경계 바깥 띠에서 색 차이 평균 → 보정본 톤 보정
    const off = [0, 0, 0]; let n = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x; if (!rd[i] || m[i]) continue;
      const p = ((y + y0) * a.w + x + x0) * 4;
      off[0] += a.d[p] - b.d[p]; off[1] += a.d[p + 1] - b.d[p + 1]; off[2] += a.d[p + 2] - b.d[p + 2]; n++;
    }
    if (n) for (let c = 0; c < 3; c++) off[c] /= n;
    const soft = boxBlur(Float32Array.from(m), cw, ch, Math.max(2, ring / 3));
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x, p = ((y + y0) * a.w + x + x0) * 4, o = i * 4;
      const t = Math.min(1, soft[i] * 2);
      for (let c = 0; c < 3; c++) out[o + c] = a.d[p + c] * (1 - t) + (b.d[p + c] + off[c]) * t;
      out[o + 3] = 255;
    }
    return { x: x0, y: y0, w: cw, h: ch, d: out };
  }

  // ───────────── 4) 자동 지우기: 대상 모양에 따라 엔진 선택 ─────────────
  // 가는 선(전선 등) → PatchMatch(주변 무늬 복사), 덩어리(사람·물건) → AI(MI-GAN)
  // run(imgCHW Uint8Array, maskU8(255=유지,0=지움), w, h) → Promise<Uint8Array CHW>
  // 결과: 바뀐 영역 패치 배열 [{x,y,w,h,d}] — image.d 도 함께 갱신됨
  async function smartErase(image, mask, run, opts) {
    opts = opts || {};
    const progress = opts.progress || (() => {});
    const W = image.w, H = image.h;
    const thinR = Math.max(6, Math.round(Math.max(W, H) * (opts.thinRatio || 0.008)));
    // 굵은 부분(지름 2*thinR 원이 들어가는 곳)만 덩어리로, 나머지는 가는 선으로 분리
    let thick = run ? open(mask, W, H, 2 * thinR + 1) : new Uint8Array(W * H);
    thick = dilate(thick, W, H, 7);
    const blobMask = new Uint8Array(W * H), thinMask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (mask[i]) { if (thick[i]) blobMask[i] = 1; else thinMask[i] = 1; }
    // 가까운 덩어리는 하나로 묶어서 처리
    const grouped = dilate(blobMask, W, H, Math.max(9, Math.round(Math.max(W, H) * 0.006)));
    const { lab, comps } = components(grouped, W, H);
    const blobs = [];
    comps.forEach((c, id) => {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      const sub = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const i = (y + c.y0) * W + x + c.x0; if (lab[i] === id && blobMask[i]) sub[y * bw + x] = 1;
      }
      const rad = maxHoleRadius(sub, bw, bh);
      if (!run || rad <= thinR) {
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (sub[y * bw + x]) thinMask[(y + c.y0) * W + x + c.x0] = 1;
      } else blobs.push({ c, sub, bw, bh });
    });
    const patches = [];
    const steps = blobs.length + (bbox(thinMask, W, H) ? 1 : 0);
    let done = 0;
    for (const b of blobs) {
      patches.push(await aiFillOne(image, b, run, opts));
      done++; progress(done / steps);
    }
    if (bbox(thinMask, W, H)) {
      const p = inpaint(image, thinMask, { progress: (f) => progress((done + f) / steps) });
      if (p) { applyPatch(image, p); patches.push(p); }
    }
    return patches;
  }

  function applyPatch(image, p) {
    for (let y = 0; y < p.h; y++) image.d.set(p.d.subarray(y * p.w * 4, (y + 1) * p.w * 4), ((y + p.y) * image.w + p.x) * 4);
  }

  async function aiFillOne(image, b, run, opts) {
    const W = image.w, H = image.h, { c, sub, bw, bh } = b;
    const side = Math.max(bw, bh);
    const ctx = Math.max(48, Math.round(side * 0.75));
    const x0 = Math.max(0, c.x0 - ctx), y0 = Math.max(0, c.y0 - ctx);
    const x1 = Math.min(W, c.x1 + 1 + ctx), y1 = Math.min(H, c.y1 + 1 + ctx);
    const cw = x1 - x0, ch = y1 - y0;
    const hole = new Uint8Array(cw * ch);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (sub[y * bw + x]) hole[(y + c.y0 - y0) * cw + x + c.x0 - x0] = 1;
    const holeD = dilate(hole, cw, ch, 5);
    const crop = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) crop.set(image.d.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x1) * 4), y * cw * 4);
    const maxS = opts.aiSize || 768;
    const s = Math.min(1, maxS / Math.max(cw, ch));
    const sw = Math.max(16, Math.round(cw * s)), sh = Math.max(16, Math.round(ch * s));
    const rgb = resizeRGB(crop, cw, ch, sw, sh);
    const hs = s < 1 ? resizeMaskAny(holeD, cw, ch, sw, sh) : holeD;
    const chw = new Uint8Array(3 * sw * sh), mk = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      chw[i] = rgb[i * 3]; chw[sw * sh + i] = rgb[i * 3 + 1]; chw[2 * sw * sh + i] = rgb[i * 3 + 2];
      mk[i] = hs[i] ? 0 : 255;
    }
    const out = await run(chw, mk, sw, sh);
    const res = new Float32Array(sw * sh * 3);
    for (let i = 0; i < sw * sh; i++) { res[i * 3] = out[i]; res[i * 3 + 1] = out[sw * sh + i]; res[i * 3 + 2] = out[2 * sw * sh + i]; }
    // 원본 해상도로: 지운 곳만 교체, 가장자리는 부드럽게
    const soft = boxBlur(Float32Array.from(dilate(holeD, cw, ch, 3)), cw, ch, 2);
    const d = new Uint8ClampedArray(crop), tmp = [0, 0, 0];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x; const a = holeD[i] ? 1 : soft[i]; if (a <= 0.001) continue;
      sampleRGB(res, sw, sh, (x + 0.5) * s - 0.5, (y + 0.5) * s - 0.5, tmp);
      const o = i * 4;
      d[o] = d[o] * (1 - a) + tmp[0] * a; d[o + 1] = d[o + 1] * (1 - a) + tmp[1] * a; d[o + 2] = d[o + 2] * (1 - a) + tmp[2] * a;
    }
    if (s < 0.9) addGrain(d, crop, holeD, cw, ch, 11);
    const p = { x: x0, y: y0, w: cw, h: ch, d };
    applyPatch(image, p);
    return p;
  }

  const api = { inpaint, inpaintCrop, smartErase, applyPatch, detectWires, diffMask, composite, bbox, dilate, erode, components, maxHoleRadius };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this);
