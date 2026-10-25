'use strict';
// 사진 지우개 — 화면/조작 담당. 계산은 worker.js, 알고리즘은 engine.js

const $ = (id) => document.getElementById(id);
const view = $('view'), vctx = view.getContext('2d');
const stage = $('stage');

const S = {
  file: null, name: '', meta: { exif: null, icc: [], iccIsP3: false },
  cs: 'srgb', w: 0, h: 0,
  img: null, ictx: null,        // 작업 중인 사진(원본 해상도)
  orig: null,                   // 비교용 원본
  mask: null, mctx: null,       // 칠한 영역(원본 해상도)
  hasMask: false, edited: false,
  s: 1, tx: 0, ty: 0, fit: 1,   // 화면 배율/위치
  tool: 'brush', brush: 36,
  undo: [], redo: [], showOrig: false, busy: false,
};
const MAX_UNDO = 6;
const MAX_PIXELS = 60e6;
const MASK_COLOR = 'rgba(255,45,85,1)';

// ───────────── 워커 ─────────────
const worker = new Worker('worker.js', { type: 'module' });
let reqId = 0; const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'status') { $('busyText').textContent = m.text; return; }
  if (m.type === 'progress') { $('busyBar').style.width = Math.round(m.value * 100) + '%'; return; }
  const p = pending.get(m.id);
  if (m.type === 'error') { if (p) { pending.delete(m.id); p.reject(new Error(m.text)); } else toast(m.text); return; }
  if (p) { pending.delete(m.id); p.resolve(m); }
};
worker.onerror = (e) => { toast('처리 엔진 오류: ' + (e.message || '알 수 없음')); setBusy(false); };
function call(type, data, transfer) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ type, id }, data), transfer || []);
  });
}
// load·loadEdited 는 응답 타입이 달라서 따로
function callLoad(type, data, transfer, doneType) {
  return new Promise((resolve) => {
    const h = (e) => { if (e.data.type === doneType) { worker.removeEventListener('message', h); resolve(); } };
    worker.addEventListener('message', h);
    worker.postMessage(Object.assign({ type }, data), transfer);
  });
}

// ───────────── 공통 UI ─────────────
let toastTimer = 0;
function toast(text, ms) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
}
function setBusy(on, text) {
  S.busy = on; $('busy').hidden = !on;
  if (text) $('busyText').textContent = text;
  $('busyBar').style.width = '0%';
  refreshButtons();
}
function refreshButtons() {
  const has = !!S.img;
  $('btnErase').disabled = !has || !S.hasMask || S.busy;
  $('btnFromEdited').hidden = !S.edited;
  $('btnFromEdited').disabled = !has || !S.hasMask || S.busy;
  $('btnFromEdited').classList.toggle('main', S.edited);
  $('btnFromEdited').textContent = S.mode === 'label' ? '✅ 표시 자리만 원본으로' : '✅ 칠한 곳만 원본에 합치기';
  $('btnLabel').hidden = !S.edited || S.mode === 'label';
  $('btnLabel').disabled = S.busy;
  $('btnErase').classList.toggle('minor', S.edited);
  $('btnUndo').disabled = !S.undo.length || S.busy;
  $('btnRedo').disabled = !S.redo.length || S.busy;
  $('btnSave').disabled = !has || S.busy;
  $('btnWires').disabled = !has || S.busy;
  $('btnEdited').disabled = !has || S.busy;
  $('btnClear').disabled = !S.hasMask || S.busy;
  $('btnCompare').hidden = !has;
  $('empty').hidden = has;
  $('dock').hidden = !has;
  $('btnEdited').textContent = S.edited ? '🔁 바뀐 곳 다시 찾기' : '🖼 보정본 추가';
}

// ───────────── 사진 열기 ─────────────
async function decodeTo(blob, cs, w, h) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  c.width = w || bmp.width; c.height = h || bmp.height;
  const ctx = c.getContext('2d', { colorSpace: cs });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return { c, ctx, bw: bmp.width, bh: bmp.height, bmp };
}

async function openMain(file) {
  if (!file) return;
  setBusy(true, '사진 여는 중…');
  try {
    const buf = await file.arrayBuffer();
    const meta = JpegMeta.extract(buf);
    const cs = meta.iccIsP3 && supportsP3() ? 'display-p3' : 'srgb';
    const probe = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (probe.width * probe.height > MAX_PIXELS) { probe.close && probe.close(); throw new Error('사진이 너무 커요(6천만 화소 이하만 가능)'); }
    probe.close && probe.close();
    const d = await decodeTo(file, cs);
    Object.assign(S, { file, name: file.name || '사진.jpg', meta, cs, w: d.c.width, h: d.c.height, img: d.c, ictx: d.ctx, orig: d.bmp });
    S.mask = document.createElement('canvas'); S.mask.width = S.w; S.mask.height = S.h;
    S.mctx = S.mask.getContext('2d', { willReadFrequently: true });
    S.hasMask = false; S.edited = false; S.undo = []; S.redo = []; S.mode = 'merge';
    const data = S.ictx.getImageData(0, 0, S.w, S.h, { colorSpace: cs });
    await callLoad('load', { w: S.w, h: S.h, buf: data.data.buffer }, [data.data.buffer], 'loaded');
    $('title').textContent = S.name;
    $('subtitle').textContent = `${S.w}×${S.h} · ${(file.size / 1048576).toFixed(1)}MB · 원본 해상도로 작업`;
    fitView(); render();
  } catch (err) {
    toast(err.message || '사진을 열지 못했어요(HEIC는 갤럭시 설정에서 JPEG로 저장해 주세요)', 4000);
  } finally { setBusy(false); }
}

function supportsP3() {
  try { return !!document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' }).getContextAttributes().colorSpace; }
  catch (_) { return false; }
}

async function openEdited(file, opts) {
  opts = opts || {};
  if (!file || !S.img) return;
  setBusy(true, '보정본 여는 중…');
  try {
    const probe = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const ra = S.w / S.h, rb = probe.width / probe.height;
    probe.close && probe.close();
    if (Math.abs(ra - rb) / ra > 0.02) throw new Error('원본과 비율이 달라요. 같은 사진의 보정본인지 확인해 주세요');
    const d = await decodeTo(file, S.cs, S.w, S.h); // 같은 크기·같은 색공간으로 맞춤
    const data = d.ctx.getImageData(0, 0, S.w, S.h, { colorSpace: S.cs });
    await callLoad('loadEdited', { w: S.w, h: S.h, buf: data.data.buffer }, [data.data.buffer], 'editedLoaded');
    d.bmp.close && d.bmp.close();
    S.edited = true; S.editFile = file; S.pairOrig = S.file;
    if (opts.noDiff) return;
    setBusy(true, '보정본과 다른 곳 찾는 중…');
    const r = await call('diff', {});
    clearMask(); orMask(new Uint8Array(r.mask));
    render();
    if (!localStorageGet('seenHelp')) { $('dlgHelp').showModal(); localStorageSet('seenHelp', '1'); }
    else toast('보정본에서 바뀐 곳을 칠했어요. 필요하면 다듬고 ✅ 합치기', 3500);
  } catch (err) { toast(err.message || '보정본을 열지 못했어요', 4000); }
  finally { setBusy(false); }
}

function localStorageGet(k) { try { return localStorage.getItem('pe.' + k); } catch (_) { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('pe.' + k, v); } catch (_) { /* 무시 */ } }

// ───────────── 마스크 ─────────────
function readMask() {
  const a = S.mctx.getImageData(0, 0, S.w, S.h).data;
  const m = new Uint8Array(S.w * S.h);
  let any = 0;
  for (let i = 0, j = 3; i < m.length; i++, j += 4) if (a[j] > 40) { m[i] = 1; any = 1; }
  return any ? m : null;
}
function orMask(m) {
  const id = new ImageData(S.w, S.h);
  const d = id.data;
  let any = 0;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) if (m[i]) { d[j] = 255; d[j + 1] = 45; d[j + 2] = 85; d[j + 3] = 255; any = 1; }
  const t = document.createElement('canvas'); t.width = S.w; t.height = S.h;
  t.getContext('2d').putImageData(id, 0, 0);
  S.mctx.drawImage(t, 0, 0);
  if (any) S.hasMask = true;
  refreshButtons();
  return any;
}
function clearMask() { if (S.mctx) S.mctx.clearRect(0, 0, S.w, S.h); S.hasMask = false; refreshButtons(); }

// ───────────── 결과 적용 / 되돌리기 ─────────────
function applyPatches(patches) {
  if (!patches.length) return;
  const step = [];
  for (const p of patches) {
    const before = S.ictx.getImageData(p.x, p.y, p.w, p.h, { colorSpace: S.cs });
    const after = new ImageData(new Uint8ClampedArray(p.d), p.w, p.h, { colorSpace: S.cs });
    S.ictx.putImageData(after, p.x, p.y);
    step.push({ x: p.x, y: p.y, before, after });
  }
  S.undo.push(step); if (S.undo.length > MAX_UNDO) S.undo.shift();
  S.redo = [];
}
function swapStep(step, useBefore) {
  for (const s of (useBefore ? step.slice().reverse() : step)) {
    const id = useBefore ? s.before : s.after;
    S.ictx.putImageData(id, s.x, s.y);
    const copy = new Uint8ClampedArray(id.data);
    worker.postMessage({ type: 'setRegion', x: s.x, y: s.y, w: id.width, h: id.height, d: copy.buffer }, [copy.buffer]);
  }
}
function undo() { const s = S.undo.pop(); if (!s) return; swapStep(s, true); S.redo.push(s); render(); refreshButtons(); }
function redo() { const s = S.redo.pop(); if (!s) return; swapStep(s, false); S.undo.push(s); render(); refreshButtons(); }

async function doErase() {
  const m = readMask(); if (!m) return toast('지울 곳을 먼저 칠해 주세요');
  setBusy(true, '지우는 중…');
  try {
    const r = await call('erase', { mask: m.buffer }, [m.buffer]);
    applyPatches(r.patches);
    clearMask(); render();
    toast('지웠어요. 마음에 안 들면 ↶ 후 더 넓게/좁게 칠해 보세요', 3200);
  } catch (err) { toast('지우기 실패: ' + err.message, 4000); }
  finally { setBusy(false); }
}
async function doFromEdited() {
  const m = readMask(); if (!m) return toast('가져올 곳을 칠해 주세요');
  setBusy(true, '보정본에서 가져오는 중…');
  try {
    const label = S.mode === 'label';
    const r = await call(label ? 'composite' : 'hybrid', { mask: m.buffer }, [m.buffer]);
    applyPatches(r.patches);
    clearMask(); render();
    toast(label ? '표시 자리만 원본으로 바꿨어요. 나머지는 편집한 그대로예요' : '합쳤어요. 더 다듬을 곳은 저장 → 갤럭시 AI 지우개 → 두 장을 다시 넣으면 그 부분만 반영돼요', 5000);
  } catch (err) { toast('실패: ' + err.message, 4000); }
  finally { setBusy(false); }
}
// 편집본은 그대로 두고, 좌하단 'AI로 생성한 콘텐츠' 표시 자리만 원본으로
async function doLabelMode() {
  const orig = S.pairOrig, ed = S.editFile;
  if (!orig || !ed) return toast('원본과 편집본 2장을 먼저 넣어 주세요');
  await openMain(ed);
  if (!S.img) return;
  await openEdited(orig, { noDiff: true });
  S.pairOrig = orig; S.editFile = ed; S.mode = 'label';
  setBusy(true, '표시 위치 찾는 중…');
  try {
    const r = await call('labelMask', {});
    const any = orMask(new Uint8Array(r.mask));
    render();
    toast(any ? '표시 자리를 칠했어요. 확인 후 ✅ 표시 자리만 원본으로' : '표시를 못 찾았어요. 글씨 위를 직접 칠해 주세요', 4000);
  } catch (err) { toast(err.message, 4000); }
  finally { setBusy(false); }
}
async function doWires() {
  setBusy(true, '하늘의 전선 찾는 중…');
  try {
    const r = await call('wires', {});
    const any = orMask(new Uint8Array(r.mask));
    render();
    toast(any ? '전선을 칠했어요. 빠진 곳은 칠하고, 넘친 곳은 "빼기"로 다듬은 뒤 지우기' : '하늘에서 전선을 못 찾았어요. 직접 칠해 주세요', 4200);
  } catch (err) { toast(err.message, 4000); }
  finally { setBusy(false); }
}

// ───────────── 저장 ─────────────
async function buildJpeg() {
  const blob = await new Promise((res) => S.img.toBlob(res, 'image/jpeg', 0.95));
  const buf = await blob.arrayBuffer();
  return JpegMeta.inject(buf, S.meta, S.w, S.h);
}
function outName() {
  const base = (S.name || '사진').replace(/\.[^.]+$/, '');
  return base + '_지움.jpg';
}
async function save(act) {
  $('dlgSave').close();
  setBusy(true, '저장하는 중…');
  try {
    const blob = await buildJpeg();
    const name = outName();
    if (act === 'share') {
      const file = new File([blob], name, { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        setBusy(false);
        await navigator.share({ files: [file] });
        return;
      }
      toast('이 기기에서는 공유를 쓸 수 없어 저장으로 대신할게요');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`저장했어요 · ${name} (${(blob.size / 1048576).toFixed(1)}MB)`, 3500);
  } catch (err) { if (err && err.name !== 'AbortError') toast('저장 실패: ' + err.message, 4000); }
  finally { setBusy(false); }
}

// ───────────── 화면 그리기 / 확대 ─────────────
let dpr = 1, vw = 0, vh = 0, cursor = null, raf = 0;
function resize() {
  dpr = window.devicePixelRatio || 1;
  vw = stage.clientWidth; vh = stage.clientHeight;
  view.width = Math.round(vw * dpr); view.height = Math.round(vh * dpr);
  if (S.img) { const keep = S.s <= S.fit * 1.01; S.fit = Math.min(vw / S.w, vh / S.h); if (keep) fitView(); }
  render();
}
function fitView() {
  S.fit = Math.min(vw / S.w, vh / S.h);
  S.s = S.fit; S.tx = (vw - S.w * S.s) / 2; S.ty = (vh - S.h * S.s) / 2;
}
function render() { if (!raf) raf = requestAnimationFrame(draw); }
function draw() {
  raf = 0;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.fillStyle = '#08080c'; vctx.fillRect(0, 0, vw, vh);
  if (!S.img) return;
  vctx.imageSmoothingEnabled = S.s < 2;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(S.showOrig ? S.orig : S.img, S.tx, S.ty, S.w * S.s, S.h * S.s);
  if (!S.showOrig && S.hasMask) {
    vctx.globalAlpha = 0.5;
    vctx.drawImage(S.mask, S.tx, S.ty, S.w * S.s, S.h * S.s);
    vctx.globalAlpha = 1;
  }
  if (cursor && S.tool !== 'pan') {
    vctx.beginPath(); vctx.arc(cursor.x, cursor.y, S.brush / 2, 0, Math.PI * 2);
    vctx.strokeStyle = 'rgba(255,255,255,.9)'; vctx.lineWidth = 1.5; vctx.stroke();
    vctx.strokeStyle = 'rgba(0,0,0,.5)'; vctx.lineWidth = 1; vctx.beginPath(); vctx.arc(cursor.x, cursor.y, S.brush / 2 + 1.5, 0, Math.PI * 2); vctx.stroke();
  }
  const z = $('zoomBadge');
  const pct = Math.round(S.s * 100);
  z.hidden = S.s <= S.fit * 1.02; z.textContent = pct + '%';
}
function toImg(x, y) { return { x: (x - S.tx) / S.s, y: (y - S.ty) / S.s }; }
function clampView() {
  const W = S.w * S.s, H = S.h * S.s, m = 60;
  S.tx = W <= vw ? (vw - W) / 2 : Math.min(m, Math.max(vw - W - m, S.tx));
  S.ty = H <= vh ? (vh - H) / 2 : Math.min(m, Math.max(vh - H - m, S.ty));
}
function zoomAt(cx, cy, ns) {
  ns = Math.max(S.fit * 0.8, Math.min(8, ns));
  const p = toImg(cx, cy);
  S.s = ns; S.tx = cx - p.x * ns; S.ty = cy - p.y * ns;
  clampView();
}

// ───────────── 손가락 조작 ─────────────
const ptrs = new Map();
let stroke = null, pinch = null, pan = null;
function local(e) { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function paintSeg(a, b) {
  const ctx = S.mctx;
  ctx.save();
  ctx.globalCompositeOperation = S.tool === 'erase' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = MASK_COLOR; ctx.fillStyle = MASK_COLOR;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = S.brush / S.s;
  const p = toImg(a.x, a.y), q = toImg(b.x, b.y);
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x + 0.01, q.y); ctx.stroke();
  ctx.restore();
}
view.addEventListener('pointerdown', (e) => {
  if (!S.img || S.busy) return;
  view.setPointerCapture(e.pointerId);
  const pt = local(e);
  ptrs.set(e.pointerId, pt);
  if (ptrs.size === 2) {
    stroke = null; pan = null; cursor = null;
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: S.s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, img: toImg((a.x + b.x) / 2, (a.y + b.y) / 2) };
  } else if (ptrs.size === 1) {
    if (S.tool === 'pan') pan = { x: pt.x, y: pt.y, tx: S.tx, ty: S.ty };
    else {
      stroke = { last: pt, moved: false };
      // 손가락이 두 개가 될 수도 있으니 아주 짧게 기다렸다 그리기 시작
      stroke.timer = setTimeout(() => { if (stroke && !stroke.started) { stroke.started = true; paintSeg(pt, pt); if (S.tool === 'brush') S.hasMask = true; render(); } }, 60);
      cursor = pt;
    }
  }
  render();
});
view.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) {
    if (e.pointerType === 'mouse' && S.img) { cursor = local(e); render(); }
    return;
  }
  const pt = local(e); ptrs.set(e.pointerId, pt);
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ns = Math.max(S.fit * 0.8, Math.min(8, pinch.s * d / Math.max(1, pinch.d)));
    S.s = ns; S.tx = mid.x - pinch.img.x * ns; S.ty = mid.y - pinch.img.y * ns;
    clampView(); render();
  } else if (pan) {
    S.tx = pan.tx + pt.x - pan.x; S.ty = pan.ty + pt.y - pan.y; clampView(); render();
  } else if (stroke) {
    if (!stroke.started) { clearTimeout(stroke.timer); stroke.started = true; }
    paintSeg(stroke.last, pt); stroke.last = pt;
    if (S.tool === 'brush') S.hasMask = true;
    cursor = pt; render();
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size === 0) {
    if (stroke) {
      clearTimeout(stroke.timer);
      if (!stroke.started) { paintSeg(stroke.last, stroke.last); if (S.tool === 'brush') S.hasMask = true; }
      stroke = null;
      if (S.tool === 'erase') S.hasMask = !!readMaskQuick();
    }
    pan = null;
    if (e.pointerType !== 'mouse') cursor = null;
    refreshButtons(); render();
  }
}
// 빼기 후 남은 칠이 있는지 가볍게 확인(축소본으로)
function readMaskQuick() {
  const t = document.createElement('canvas'); const k = Math.min(1, 512 / Math.max(S.w, S.h));
  t.width = Math.max(1, Math.round(S.w * k)); t.height = Math.max(1, Math.round(S.h * k));
  const c = t.getContext('2d'); c.drawImage(S.mask, 0, 0, t.width, t.height);
  const d = c.getImageData(0, 0, t.width, t.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
  return false;
}
view.addEventListener('pointerup', endPtr);
view.addEventListener('pointercancel', endPtr);
view.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !ptrs.size) { cursor = null; render(); } });
view.addEventListener('wheel', (e) => { if (!S.img) return; e.preventDefault(); const p = local(e); zoomAt(p.x, p.y, S.s * Math.exp(-e.deltaY * 0.0015)); render(); }, { passive: false });
view.addEventListener('dblclick', (e) => { if (!S.img) return; const p = local(e); if (S.s > S.fit * 1.05) fitView(); else zoomAt(p.x, p.y, S.fit * 3); render(); });

// ───────────── 버튼 ─────────────
$('btnOpen').onclick = () => $('pickBoth').click();
$('btnOpen2').onclick = () => $('pickMain').click();
$('btnPickBoth').onclick = () => $('pickBoth').click();
$('pickBoth').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; openFiles(fs); };
$('pickMain').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; openMain(f); };
$('btnEdited').onclick = () => {
  if (S.edited) { // 이미 불러온 보정본으로 다시 자동 선택
    setBusy(true, '보정본과 다른 곳 찾는 중…');
    call('diff', {}).then((r) => { clearMask(); orMask(new Uint8Array(r.mask)); render(); })
      .catch((err) => toast(err.message)).finally(() => setBusy(false));
  } else $('pickEdited').click();
};
$('btnEdited').addEventListener('contextmenu', (e) => { e.preventDefault(); $('pickEdited').click(); });
$('pickEdited').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; openEdited(f); };
$('btnErase').onclick = doErase;
$('btnFromEdited').onclick = doFromEdited;
$('btnWires').onclick = doWires;
$('btnLabel').onclick = doLabelMode;
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('btnClear').onclick = () => { clearMask(); render(); };
$('btnSave').onclick = () => {
  $('saveInfo').textContent = `${S.w}×${S.h} 원본 해상도 · 촬영 정보·색 프로필 유지 · 파일 이름: ${outName()}`;
  $('dlgSave').showModal();
};
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (e.target === d || act === 'close') d.close();
    else if (act === 'download' || act === 'share') save(act);
  });
});
document.querySelectorAll('.seg button').forEach((b) => b.onclick = () => {
  S.tool = b.dataset.tool;
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
});
const brushIn = $('brush');
function setBrush(v) { S.brush = +v; $('dotPrev').style.setProperty('--d', Math.min(40, S.brush) + 'px'); localStorageSet('brush', String(S.brush)); }
brushIn.oninput = () => setBrush(brushIn.value);
{ const b = localStorageGet('brush'); if (b) brushIn.value = b; setBrush(brushIn.value); }
const cmp = $('btnCompare');
const cmpOn = (e) => { e.preventDefault(); S.showOrig = true; cmp.classList.add('active'); render(); };
const cmpOff = () => { S.showOrig = false; cmp.classList.remove('active'); render(); };
cmp.addEventListener('pointerdown', cmpOn); cmp.addEventListener('pointerup', cmpOff);
cmp.addEventListener('pointerleave', cmpOff); cmp.addEventListener('pointercancel', cmpOff);
cmp.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(stage);

// ───────────── 사진 1~2장 열기(원본/보정본 자동 구분) ─────────────
async function openFiles(files) {
  if (!files.length) return;
  if (files.length >= 2) {
    // 촬영 정보(EXIF)가 더 많은 쪽이 원본. 갤럭시 편집본은 촬영 정보가 대부분 빠져 있음
    const score = async (f) => { const m = JpegMeta.extract(await f.arrayBuffer()); return m.exif ? m.exif.length : 0; };
    const [s0, s1] = await Promise.all([score(files[0]), score(files[1])]);
    const [main, ed] = s0 >= s1 ? [files[0], files[1]] : [files[1], files[0]];
    await openMain(main);
    if (S.img) await openEdited(ed);
  } else {
    await openMain(files[0]);
    if (S.img) toast('갤럭시로 지운 사진도 있으면 "🖼 보정본 추가"를 눌러 주세요', 3500);
  }
}

// ───────────── 공유로 받은 사진 ─────────────
async function takeShared() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('share-inbox');
    const keys = await cache.keys();
    const files = [];
    for (const k of keys) {
      const r = await cache.match(k);
      const b = await r.blob();
      files.push(new File([b], decodeURIComponent(r.headers.get('x-name') || '사진.jpg'), { type: b.type || 'image/jpeg' }));
      await cache.delete(k);
    }
    await openFiles(files);
  } catch (err) { toast('공유 받은 사진을 열지 못했어요'); }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || S.img) return; reloaded = true; location.reload();
  });
}
resize(); refreshButtons(); takeShared();
