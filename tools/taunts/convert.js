#!/usr/bin/env node
// Mixamo FBX (Without Skin, Y Bot) -> Corniche Run taunt clip (JSON) on the Quaternius runner skeleton.
// See README.md in this folder. Usage:
//   node tools/taunts/convert.js --three <three@0.128 package dir> --rig <a1.glb> --in <folder with the .fbx files> [--out client/models/taunts] [--only Salute]
// moves.json (this folder) lists every move: file, id, name, trim (from/to seconds), loop or once, in place rule.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const arg = k => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..', '..');
const THREE_DIR = arg('three') || path.join(ROOT, 'node_modules', 'three');
const RIG = arg('rig'), IN = arg('in'), OUT = arg('out') || path.join(ROOT, 'client', 'models', 'taunts'), ONLY = arg('only');
if (!RIG || !IN) { console.log('usage: node convert.js --three <three dir> --rig <a1.glb> --in <fbx folder> [--out dir] [--only name]'); process.exit(1); }
global.self = global; global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(THREE_DIR, 'build', 'three.min.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(THREE_DIR, 'examples', 'js', 'libs', 'fflate.min.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(THREE_DIR, 'examples', 'js', 'loaders', 'FBXLoader.js'), 'utf8'));
const T = global.THREE, V3 = T.Vector3, Q = T.Quaternion;
console.warn = () => {};

// Mixamo bone -> Quaternius bone (the animated bones of the runner clips; fingers stay at rest)
const MAP = { Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03', Neck: 'neck_01', Head: 'Head',
  LeftShoulder: 'clavicle_l', LeftArm: 'upperarm_l', LeftForeArm: 'lowerarm_l', LeftHand: 'hand_l',
  RightShoulder: 'clavicle_r', RightArm: 'upperarm_r', RightForeArm: 'lowerarm_r', RightHand: 'hand_r',
  LeftUpLeg: 'thigh_l', LeftLeg: 'calf_l', LeftFoot: 'foot_l', LeftToeBase: 'ball_l',
  RightUpLeg: 'thigh_r', RightLeg: 'calf_r', RightFoot: 'foot_r', RightToeBase: 'ball_r' };
// the child each bone points at (to line the rest poses up: Mixamo is a T pose, the runner is not)
const AIM = { pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'neck_01', neck_01: 'Head', clavicle_l: 'upperarm_l', upperarm_l: 'lowerarm_l', lowerarm_l: 'hand_l',
  clavicle_r: 'upperarm_r', upperarm_r: 'lowerarm_r', lowerarm_r: 'hand_r', thigh_l: 'calf_l', calf_l: 'foot_l', foot_l: 'ball_l', thigh_r: 'calf_r', calf_r: 'foot_r', foot_r: 'ball_r' };
const INV = {}; Object.keys(MAP).forEach(k => { INV[MAP[k]] = 'mixamorig' + k; });

// ---------- the runner skeleton from the GLB (nodes only, no textures needed) ----------
function readRig(file) {
  const b = fs.readFileSync(file), jl = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + jl).toString()), N = j.nodes, objs = N.map(n => { const o = new T.Bone(); o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation); if (n.rotation) o.quaternion.fromArray(n.rotation); if (n.scale) o.scale.fromArray(n.scale); return o; });
  N.forEach((n, i) => (n.children || []).forEach(c => objs[i].add(objs[c])));
  const top = new T.Group(); j.scenes[0].nodes.forEach(i => top.add(objs[i])); top.updateMatrixWorld(true);
  const by = {}; objs.forEach(o => { by[o.name] = o; }); return { top, by };
}
const wq = o => o.getWorldQuaternion(new Q()), wp = o => o.getWorldPosition(new V3());

function convert(mv, rig) {
  const buf = fs.readFileSync(path.join(IN, mv.file)), g = new T.FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '');
  g.updateMatrixWorld(true);
  const S = n => g.getObjectByName(n), R = rig.by, names = Object.keys(R).filter(n => INV[n] && S(INV[n]));
  // rest poses: the FBX as loaded is Mixamo's T pose; the runner's rest is the GLB
  const srcRest = {}, tgtRest = {}, tgtPos = {};
  names.forEach(n => { srcRest[n] = wq(S(INV[n])); tgtRest[n] = wq(R[n]); tgtPos[n] = wp(R[n]); });
  // both face +Z? (toe ahead of the foot)
  const fwdOf = (a, b) => { const d = b.clone().sub(a); d.y = 0; return d.normalize(); };
  const sF = fwdOf(wp(S('mixamorigLeftFoot')), wp(S('mixamorigLeftToeBase'))), tF = fwdOf(tgtPos.foot_l, tgtPos.ball_l);
  const yaw = new Q().setFromUnitVectors(sF, tF), yawI = yaw.clone().invert();
  // line the runner's rest bones up with the T pose: swing each bone so it points where the Mixamo bone points
  const tgtT = {};
  names.forEach(n => {
    let al = new Q();
    if (AIM[n] && R[AIM[n]] && S(INV[AIM[n]])) {
      const dT = tgtPos[AIM[n]].clone().sub(tgtPos[n]).normalize(), dS = wp(S(INV[AIM[n]])).sub(wp(S(INV[n]))).normalize().applyQuaternion(yaw);
      if (n !== 'pelvis') al = new Q().setFromUnitVectors(dT, dS);
    }
    tgtT[n] = al.multiply(tgtRest[n]);
  });
  const clip = g.animations[0], mixer = new T.AnimationMixer(g); mixer.clipAction(clip).play();
  const fps = mv.fps || 24, t0 = mv.from || 0, t1 = Math.min(clip.duration, mv.to || clip.duration), nF = Math.max(2, Math.round((t1 - t0) * fps) + 1);
  const hipsS = S('mixamorigHips'), hipsRest = wp(hipsS), scale = tgtPos.pelvis.y / hipsRest.y, pelPar = R.pelvis.parent;
  // the order to solve in: parents before children
  const order = []; rig.top.traverse(o => { if (names.indexOf(o.name) > -1) order.push(o.name); });
  const frames = [];
  for (let f = 0; f < nF; f++) {
    const t = t0 + (t1 - t0) * f / (nF - 1); mixer.setTime(t); g.updateMatrixWorld(true);
    const W = {};
    order.forEach(n => { const sw = wq(S(INV[n])); W[n] = yaw.clone().multiply(sw).multiply(srcRest[n].clone().invert()).multiply(yawI).multiply(tgtT[n]); });
    // hips: the move's own height and sway, scaled to the runner
    const d = wp(hipsS).sub(hipsRest).applyQuaternion(yaw).multiplyScalar(scale);
    frames.push({ W, d });
  }
  // stay on the start line: no travel. 'lock' takes all ground movement out, 'clamp' keeps a small sway around the middle
  const mean = new V3(); frames.forEach(fr => mean.add(fr.d)); mean.divideScalar(frames.length);
  frames.forEach(fr => { if (mv.place === 'lock') { fr.d.x = 0; fr.d.z = 0; } else { const lim = mv.sway || .12; fr.d.x = Math.max(-lim, Math.min(lim, fr.d.x - mean.x)); fr.d.z = Math.max(-lim, Math.min(lim, fr.d.z - mean.z)); } if (mv.dy) fr.d.y += mv.dy; });
  // to local rotations, then a floor check (feet and hands never below the floor)
  const out = { q: {}, p: [] }; names.forEach(n => { out.q[n] = []; });
  const floorPts = ['ball_l', 'ball_r', 'foot_l', 'foot_r', 'hand_l', 'hand_r', 'Head'].filter(n => R[n]);
  const restMin = Math.min.apply(null, ['ball_l', 'ball_r', 'foot_l', 'foot_r'].filter(n => R[n]).map(n => tgtPos[n].y));
  frames.forEach(fr => {
    order.forEach(n => { const pw = names.indexOf(R[n].parent.name) > -1 ? fr.W[R[n].parent.name] : wq(R[n].parent); R[n].quaternion.copy(pw.clone().invert().multiply(fr.W[n])); });
    const pp = tgtPos.pelvis.clone().add(fr.d); pelPar.updateMatrixWorld(true); R.pelvis.position.copy(pelPar.worldToLocal(pp.clone()));
    rig.top.updateMatrixWorld(true);
    let lo = Infinity; floorPts.forEach(n => { lo = Math.min(lo, wp(R[n]).y - (n === 'Head' ? .1 : n.indexOf('hand') === 0 ? .03 : n.indexOf('ball') === 0 ? 0 : restMin)); });
    if (lo < restMin - .005 && mv.floor !== false) { pp.y += restMin - lo; R.pelvis.position.copy(pelPar.worldToLocal(pp.clone())); }
    names.forEach(n => out.q[n].push(R[n].quaternion.clone()));
    out.p.push(R.pelvis.position.clone());
  });
  // keep quaternions on one side (no flips between frames), loop: ease the end into the start
  names.forEach(n => { const a = out.q[n]; for (let i = 1; i < a.length; i++) if (a[i].dot(a[i - 1]) < 0) a[i].set(-a[i].x, -a[i].y, -a[i].z, -a[i].w); });
  if (mv.loop) { const k = Math.min(Math.round(fps * (mv.blend || .3)), nF - 2); for (let i = 0; i < k; i++) { const w = (i + 1) / k, j = nF - k + i;
    names.forEach(n => { const a = out.q[n]; const b = a[0].clone(); if (b.dot(a[j]) < 0) b.set(-b.x, -b.y, -b.z, -b.w); a[j] = a[j].clone().slerp(b, w * w); }); out.p[j] = out.p[j].clone().lerp(out.p[0], w * w); } }
  const r4 = x => Math.round(x * 1e3) / 1e3;   // 3 decimals: under 0.1 degree, 1 mm
  const res = { v: 1, id: mv.id, n: mv.name, fps, dur: +((nF - 1) / fps).toFixed(3), loop: !!mv.loop, bones: names,
    q: names.map(n => [].concat.apply([], out.q[n].map(q => [r4(q.x), r4(q.y), r4(q.z), r4(q.w)]))), p: [].concat.apply([], out.p.map(p => [r4(p.x), r4(p.y), r4(p.z)])) };
  // bones that never move: one key is enough
  res.q = res.q.map(a => { for (let i = 4; i < a.length; i++) if (Math.abs(a[i] - a[i % 4]) > 1.5e-3) return a; return a.slice(0, 4); });
  return res;
}

const moves = JSON.parse(fs.readFileSync(path.join(__dirname, 'moves.json'), 'utf8'));
const rig = readRig(RIG); fs.mkdirSync(OUT, { recursive: true });
const man = [];
moves.forEach(mv => {
  if (!fs.existsSync(path.join(IN, mv.file))) { console.log('skip (no file) ' + mv.file); return; }
  if (!ONLY || ONLY === mv.id || ONLY === mv.file.replace(/\.fbx$/i, '')) {
    for (const k in rig.by) { rig.by[k].quaternion.copy(rig.by[k].userData.q0 || (rig.by[k].userData.q0 = rig.by[k].quaternion.clone())); rig.by[k].position.copy(rig.by[k].userData.p0 || (rig.by[k].userData.p0 = rig.by[k].position.clone())); }
    rig.top.updateMatrixWorld(true);
    const r = convert(mv, rig), f = mv.id + '.json', s = JSON.stringify(r);
    fs.writeFileSync(path.join(OUT, f), s); console.log(mv.id.padEnd(10), (s.length / 1024).toFixed(1) + ' KB', r.dur + ' s', r.loop ? 'loop' : 'once');
  }
  man.push({ id: mv.id, n: mv.name, f: mv.id + '.json', loop: !!mv.loop });
});
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ v: 1, taunts: man }, null, 1));
console.log('manifest: ' + man.length + ' taunts');
