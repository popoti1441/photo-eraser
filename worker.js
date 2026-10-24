// 무거운 계산은 전부 여기서 (화면이 멈추지 않도록)
import './engine.js';
import * as ort from './vendor/ort.wasm.min.mjs';

const E = self.Engine;
ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

let image = null;   // 작업 중인 사진 {w,h,d}
let edited = null;  // 갤럭시 보정본 {w,h,d}
let session = null;

async function getRun() {
  if (!session) {
    post({ type: 'status', text: 'AI 엔진 불러오는 중… (처음 한 번만, 약 30MB)' });
    const res = await fetch(new URL('./models/migan_pipeline_v2.onnx', import.meta.url));
    if (!res.ok) throw new Error('AI 모델을 받지 못했어요');
    const buf = await res.arrayBuffer();
    session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
  }
  return async (chw, mk, w, h) => {
    const r = await session.run({
      image: new ort.Tensor('uint8', chw, [1, 3, h, w]),
      mask: new ort.Tensor('uint8', mk, [1, 1, h, w]),
    });
    return r.result.data;
  };
}

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function patchMsg(p) { return { x: p.x, y: p.y, w: p.w, h: p.h, d: p.d.buffer }; }

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'load':
        image = { w: m.w, h: m.h, d: new Uint8ClampedArray(m.buf) };
        edited = null;
        post({ type: 'loaded' });
        break;
      case 'loadEdited':
        edited = { w: m.w, h: m.h, d: new Uint8ClampedArray(m.buf) };
        post({ type: 'editedLoaded' });
        break;
      case 'setRegion': {
        const p = { x: m.x, y: m.y, w: m.w, h: m.h, d: new Uint8ClampedArray(m.d) };
        E.applyPatch(image, p);
        break;
      }
      case 'erase': {
        const mask = new Uint8Array(m.mask);
        let run = null;
        try { run = await getRun(); } catch (err) { post({ type: 'status', text: 'AI 엔진 없이 진행해요(오프라인?)' }); }
        post({ type: 'status', text: '지우는 중…' });
        const patches = await E.smartErase(image, mask, run, {
          progress: (f) => post({ type: 'progress', value: f }),
        });
        const msgs = patches.map(patchMsg);
        post({ type: 'patches', id: m.id, patches: msgs }, msgs.map((p) => p.d));
        break;
      }
      case 'wires': {
        post({ type: 'status', text: '하늘의 전선 찾는 중…' });
        const mask = E.detectWires(image, { sensitivity: m.sensitivity || 1 });
        post({ type: 'mask', id: m.id, mask: mask.buffer }, [mask.buffer]);
        break;
      }
      case 'diff': {
        if (!edited) throw new Error('보정본이 없어요');
        post({ type: 'status', text: '보정본과 다른 곳 찾는 중…' });
        const mask = E.diffMask(image, edited, { sensitivity: m.sensitivity || 1 });
        post({ type: 'mask', id: m.id, mask: mask.buffer }, [mask.buffer]);
        break;
      }
      case 'composite': {
        if (!edited) throw new Error('보정본이 없어요');
        const mask = new Uint8Array(m.mask);
        const p = E.composite(image, edited, mask);
        if (p) E.applyPatch(image, p);
        const msgs = p ? [patchMsg(p)] : [];
        post({ type: 'patches', id: m.id, patches: msgs }, msgs.map((q) => q.d));
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: m.id, text: String(err && err.message || err) });
  }
};
