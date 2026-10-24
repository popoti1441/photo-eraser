// 원본 JPEG의 촬영 정보(EXIF)와 색 프로필(ICC)을 결과 JPEG에 옮겨 붙이기
(function (root) {
  'use strict';

  function segments(u8) {
    const out = [];
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return out;
    let p = 2;
    while (p + 4 <= u8.length) {
      if (u8[p] !== 0xff) break;
      const marker = u8[p + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
      if (marker === 0xda || marker === 0xd9) { out.push({ marker, start: p, end: u8.length }); break; }
      const len = (u8[p + 2] << 8) | u8[p + 3];
      out.push({ marker, start: p, end: p + 2 + len });
      p += 2 + len;
    }
    return out;
  }
  const isStr = (u8, at, s) => { for (let i = 0; i < s.length; i++) if (u8[at + i] !== s.charCodeAt(i)) return false; return true; };

  // 원본에서 EXIF·ICC 세그먼트 꺼내기
  function extract(buf) {
    const u8 = new Uint8Array(buf);
    const res = { exif: null, icc: [], iccIsP3: false };
    for (const s of segments(u8)) {
      if (s.marker === 0xe1 && isStr(u8, s.start + 4, 'Exif\0\0') && !res.exif) res.exif = u8.slice(s.start, s.end);
      if (s.marker === 0xe2 && isStr(u8, s.start + 4, 'ICC_PROFILE\0')) res.icc.push(u8.slice(s.start, s.end));
    }
    if (res.icc.length) {
      const txt = Array.from(res.icc[0].subarray(0, Math.min(res.icc[0].length, 4096))).filter((c) => c !== 0).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ' ')).join('');
      res.iccIsP3 = /P3/.test(txt);
    }
    return res;
  }

  // EXIF 고치기: 방향=1(이미 바로 세워서 저장), 썸네일 연결 끊기(옛 그림이 미리보기로 남지 않게), 가로·세로 크기 갱신
  function fixExif(seg, w, h) {
    const u8 = seg.slice();
    const t = 10; // APP1 헤더(4) + 'Exif\0\0'(6)
    const le = u8[t] === 0x49;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const g16 = (o) => dv.getUint16(t + o, le), g32 = (o) => dv.getUint32(t + o, le);
    const s16 = (o, v) => dv.setUint16(t + o, v, le), s32 = (o, v) => dv.setUint32(t + o, v, le);
    const ok = (o, n) => t + o + n <= u8.length;
    try {
      const ifd0 = g32(4);
      if (!ok(ifd0, 2)) return u8;
      const n = g16(ifd0);
      let exifIfd = 0;
      for (let i = 0; i < n; i++) {
        const e = ifd0 + 2 + i * 12; if (!ok(e, 12)) return u8;
        const tag = g16(e);
        if (tag === 0x0112) s16(e + 8, 1);
        if (tag === 0x8769) exifIfd = g32(e + 8);
      }
      const next = ifd0 + 2 + n * 12;
      if (ok(next, 4)) s32(next, 0);
      if (exifIfd && ok(exifIfd, 2)) {
        const m = g16(exifIfd);
        for (let i = 0; i < m; i++) {
          const e = exifIfd + 2 + i * 12; if (!ok(e, 12)) break;
          const tag = g16(e), type = g16(e + 2);
          if (tag === 0xa002 || tag === 0xa003) {
            const v = tag === 0xa002 ? w : h;
            if (type === 3) s16(e + 8, v); else if (type === 4) s32(e + 8, v);
          }
        }
      }
    } catch (_) { /* 이상한 EXIF면 그대로 */ }
    return u8;
  }

  // 새 JPEG(캔버스 출력)에 원본 메타데이터 끼워 넣기
  function inject(newBuf, meta, w, h) {
    const u8 = new Uint8Array(newBuf);
    const segs = segments(u8);
    const parts = [new Uint8Array([0xff, 0xd8])];
    if (meta.exif) parts.push(fixExif(meta.exif, w, h));
    for (const s of meta.icc) parts.push(s);
    for (const s of segs) {
      // 캔버스가 넣은 JFIF/EXIF/ICC는 빼고 나머지(양자화표·허프만표·이미지 데이터)는 그대로
      if (s.marker === 0xe0 || s.marker === 0xe1 || (s.marker === 0xe2 && meta.icc.length)) continue;
      parts.push(u8.subarray(s.start, s.end));
    }
    return new Blob(parts, { type: 'image/jpeg' });
  }

  const api = { extract, inject, fixExif, segments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JpegMeta = api;
})(typeof self !== 'undefined' ? self : this);
