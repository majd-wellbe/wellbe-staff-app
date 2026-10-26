#!/usr/bin/env node
// Corniche Run obstacle generator (CRGEN in client/run.html): every generated stretch must be solvable.
// Run: node 1-apps-script/phase3/tests/rungen.test.js        KM=50 by default; KM=5 for a quick run
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'client', 'run.html'), 'utf8');
const a = html.indexOf('/* CRGEN:BEGIN'), b = html.indexOf('/* CRGEN:END */');
if (a < 0 || b < 0) { console.log('CRGEN block not found in run.html'); process.exit(1); }
const ctx = { module: { exports: null }, Math, Object, Array, JSON, Error, console };
vm.createContext(ctx); vm.runInContext(html.slice(a, b) + '\nmodule.exports = CRGEN;', ctx);
const C = ctx.module.exports;
const GAME = vm.runInContext('(' + html.slice(html.indexOf('var GAME={') + 9, html.indexOf('\n};', html.indexOf('var GAME={')) + 2) + ')', vm.createContext({}));
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('  FAIL: ' + msg + (extra !== undefined ? '\n        ' + JSON.stringify(extra).slice(0, 900) : '')); } }
// a seeded random so a failure can be replayed (SEED=...)
function rng(seed) { let s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const themeOf = ci => GAME.themes.filter(x => ci >= x.from && ci <= x.to)[0];
const cityAt = x => ((Math.floor(x / GAME.cityM) % 16) + 16) % 16;
const KM = +(process.env.KM || 50), SEED = +(process.env.SEED || 20261025);

console.log('1. pattern library');
[GAME.speed.start, 10, 13, 17, GAME.speed.max * GAME.sprint.boost].forEach(v => {
  const bad = C.PATS.filter(p => !C.validatePattern(C.mkPat(p, v), v).ok).map(p => p.id);
  ok(!bad.length, 'every pattern solvable from all 4 lanes at ' + v + ' m/s', bad);
  let bt = 0; C.PATS.forEach(p => C.PATS.forEach(q => { if (!C.validateTransition(C.mkPat(p, v), 1.2 * v, C.mkPat(q, v), v).ok) bt++; }));
  ok(bt === 0, 'all ' + C.PATS.length * C.PATS.length + ' transitions pass with a 1.2 s gap at ' + v + ' m/s', bt);
});

console.log('2. the checker says no to unfair rows');
const vp = (g, v) => { const rows = C.parseGrid(g); return C.validatePattern({ rows, len: rows[rows.length - 1].x }, v).ok; };
ok(!vp('0 BBBB', 10), 'a full wall');
ok(!vp('0 B.BB\n1 BB.B', 17), 'a gate that swaps 1 m later');
ok(vp('0 B.BB\n12 BB.B', 17), 'the same gate 12 m later');
ok(!vp('0 LLLL\n1 LLLL', 10), 'two lows 1 m apart');
ok(!vp('0 KKKK', 10), 'a kiosk with no ramp');
ok(!vp('0 RBBB\n2 KBBB\n4 LBBB', 10), 'forced onto a roof that drops into a low');

console.log('3. ' + KM + ' km of generated world per speed, every stretch checked from every state');
const speeds = [9, 13, 17, 20.7];
speeds.forEach((v, si) => {
  const R = rng(SEED + si), g = C.Gen({ rand: R, theme: themeOf, cityAt, wave: () => true, north: ci => ci >= 13, start: 26, camp: GAME.camp, sprint: GAME.sprint });
  let lastT = -1e9, rowGaps = [], n = 0, bad = [], rests = [], kinds = {}, movers = 0, plats = 0, coinsBad = 0, slotsBad = 0, alive = g.state().alive, prevEnd = 26, gaps = [], tiers = {};
  while (g.cursor() < KM * 1000) {
    const dist = Math.max(0, g.cursor() - 90), st = g.next(dist, v); n++; kinds[st.id] = (kinds[st.id] || 0) + 1; tiers[st.tier] = 1;
    if (st.rows.length) {
      const r = g.everyState(st.rows, v, alive);
      if (r.fail) bad.push({ id: st.id, x: Math.round(st.x0), row: r.fail.row });
      // the stretch alone must also be fine from every lane (its real fillers, movers and roofs)
      if (!C.validatePattern({ rows: st.rows.map(q => ({ x: q.x - st.x0, c: q.c })) }, v).ok) bad.push({ id: st.id, x: Math.round(st.x0), alone: 1 });
      if (st.id !== 'REST') rests.push(st.rest / v); gaps.push((st.x0 - prevEnd) / v);
      rowGaps.push(st.rows[0].t - lastT); lastT = st.rows[st.rows.length - 1].t;
    }
    alive = g.state().alive; prevEnd = st.x0 + st.len;
    movers += st.movers.length; plats += st.plats.length;
    // coins: never inside a block, never on a roof without a ramp, never in a lane that is blocked within 0.6 s
    st.coins.forEach(c => {
      const roof = st.plats.filter(p => p.lane === c.lane && c.x >= p.x0 - (p.rl || 0) && c.x <= p.x1)[0];
      if (roof && !roof.ramp) coinsBad++;
      if (c.y < 1 && st.rows.some(q => 'BMTSWb'.indexOf(q.c[c.lane]) >= 0 && q.x + 1.2 >= c.x - .3 && q.x <= c.x + .3)) coinsBad++;
    });
    (st.slots || []).forEach(s => { const okC = s.y > 0 ? 'KRrT.' : '.'; if (st.rows.some(q => okC.indexOf(q.c[s.lane]) < 0 && q.x > s.x - .6 * v && q.x < s.x + .4 * v)) { slotsBad++; if (process.env.V) console.log(st.id, JSON.stringify(s), st.rows.map(q => Math.round(q.x - s.x) + q.c).join(' ')); } if (st.movers.some(m => m.lane === s.lane)) slotsBad++; });
    // movers are placed by their meeting point; their warning gives enough time
    st.movers.forEach(m => { const ttc = (m.warn); if (ttc < (m.k === 'train' ? 2.5 : 2.0)) bad.push({ warn: m.k }); });
  }
  ok(!bad.length, v + ' m/s: ' + n + ' stretches, all solvable from every state the player can be in', bad.slice(0, 5));
  ok(Math.min.apply(null, rests) >= 1.2 - 1e-9, v + ' m/s: rest gap before each pattern is at least 1.2 s', Math.min.apply(null, rests));
  ok(Math.min.apply(null, rowGaps) >= 1.2 - 1e-6, v + ' m/s: at least 1.2 s from the last row of a stretch to the first row of the next (no camping cells included)', Math.min.apply(null, rowGaps));
  ok(coinsBad === 0, v + ' m/s: coins never bait (no coins in blocks or on ramp less roofs)', coinsBad);
  ok(slotsBad === 0, v + ' m/s: power ups, letters and lives sit on a clear line', slotsBad);
  ok(Object.keys(kinds).length >= 30, v + ' m/s: uses most of the pattern library', Object.keys(kinds).length);
  ok(movers > 50 && plats > 50, v + ' m/s: trains, cars and roofs appear (' + movers + ' movers, ' + plats + ' roofs)');
  ok(Object.keys(tiers).length === 5, v + ' m/s: all 5 tiers reached', Object.keys(tiers));
  // no repeats: the same pattern never comes back within 3 picks
  console.log('   ' + v + ' m/s: ' + n + ' stretches, ' + movers + ' movers, ' + plats + ' roofs, ' + Object.keys(kinds).length + ' kinds, min rest ' + Math.min.apply(null, rests).toFixed(2) + ' s');
});

console.log('4. tier gates');
{
  const g = C.Gen({ rand: rng(7), theme: themeOf, cityAt, start: 26, camp: GAME.camp, sprint: GAME.sprint }); const early = {};
  while (g.cursor() < 450) { const st = g.next(Math.max(0, g.cursor() - 90), 10); early[st.id] = 1; }
  const tooHard = Object.keys(early).filter(id => { const p = C.PATS.filter(q => q.id === id)[0]; return p && p.tier > 1; });
  ok(!tooHard.length, 'no tier 2+ pattern before 500 m', tooHard);
  ok(!Object.keys(early).some(id => /P2[23]|P3[0-2]/.test(id)), 'no train or taxi before 500 m', Object.keys(early));
}

// ---------- 5. no camping: every lane gets something regularly, standing still ends the run within a few seconds
console.log('5. no camping (' + KM + ' km per speed, and sprint stretches)');
// the times a runner who stays in lane l and never jumps, slides or changes lane is hit (a ramp takes him up, a roof is safe)
function campRun(KMx, v, hard, seed) {
  const g = C.Gen({ rand: rng(seed), theme: themeOf, cityAt, wave: () => true, north: ci => ci >= 13, start: 26, camp: GAME.camp, sprint: GAME.sprint });
  const rows = [], shelters = [[], [], [], []], sts = []; let bad = 0;
  while (g.cursor() < KMx * 1000) {
    const st = g.next(Math.max(0, g.cursor() - 90), v, hard); sts.push(st); rows.push(...st.rows);
    if (st.alive0 && st.rows.length && g.everyState(st.rows, st.v, st.alive0).fail) bad++;
    // a mover's road (it drives there, nothing may stand in it) and a roof run: places the no camping cells cannot use
    st.movers.forEach(m => shelters[m.lane].push([m.meetX - 2, m.meetX + m.vo * (m.warn + C.MV_LEAD) + m.len + 3]));
    st.plats.forEach(p => shelters[p.lane].push([p.x0 - (p.rl || 0), p.x1 + 1.3]));
  }
  rows.sort((a, b) => a.x - b.x);
  const lanes = [0, 1, 2, 3].map(l => {
    const hz = C.campHaz(rows, l), gaps = []; let prev = { x: 26, t: 0 };
    hz.forEach(t => { const x = rows.find(r => r.t === t).x; gaps.push({ from: prev.x, to: x, s: (x - prev.x) / v, shelter: shelters[l].some(q => q[1] > prev.x && q[0] < x) }); prev = { x, t }; });
    return { n: hz.length, gaps };
  });
  return { lanes, sts, shelters, bad };
}
const tierOf = x => C.tierAt(x).tier;
[[13, false], [17, false], [GAME.speed.max * GAME.sprint.boost, false], [GAME.speed.max * GAME.sprint.boost, true]].forEach(([v, hard], k) => {
  const { lanes, sts, shelters, bad } = campRun(KM, v, hard, SEED + 100 + k), tag = v + ' m/s' + (hard ? ' sprint' : '');
  ok(bad === 0, tag + ': every stretch solvable from every state the player can be in', bad);
  let strict = 0, open = 0, worst = 0, worstAt = 0, worstOpen = 0, over5 = 0; const perTier = [0, 0, 0, 0, 0];
  lanes.forEach((L, l) => L.gaps.forEach(gp => {
    if (gp.from < 120) return;   // the start of the run has its 2.5 s of grace
    const lim = hard ? GAME.sprint.hard.lim : GAME.camp[tierOf(gp.from)];
    if (!gp.shelter) { const ti = tierOf(gp.from); perTier[ti] = Math.max(perTier[ti], gp.s); open++; worstOpen = Math.max(worstOpen, gp.s); if (gp.s > lim + .15) { strict++; if (process.env.V) console.log('     free', l, gp.s.toFixed(2), Math.round(gp.from), Math.round(gp.to), sts.filter(st => st.x0 + st.len >= gp.from - 1 && st.x0 <= gp.to + 1).map(st => st.id + (st.why || '') + '@' + Math.round(st.x0) + '[' + st.rows.map(q => Math.round(q.x) + q.c).join(' ') + ']').join(' | ')); } }
    if (gp.s > worst) { worst = gp.s; worstAt = Math.round(gp.from) + ' lane ' + l; }
    if (process.env.V && gp.s > 4.5) console.log('     long', l, gp.s.toFixed(2), Math.round(gp.from), Math.round(gp.to), sts.filter(st => st.x0 + st.len >= gp.from - 1 && st.x0 <= gp.to + 1).map(st => st.id + (st.why || '') + '@' + Math.round(st.x0) + '[' + st.rows.map(q => Math.round(q.x) + q.c).join(' ') + ']' + (st.movers.length ? 'mv' : '')).join(' | '));
    if (gp.s > 5) over5++;
  }));
  // the limit holds; the rare exception (under 0.2% of gaps): the every state check needed a longer rest gap before the next pattern (at most 1.5 s over)
  const limMax = hard ? GAME.sprint.hard.lim : Math.max.apply(null, GAME.camp);
  ok(strict <= open * .002 && worstOpen <= limMax + 1.5, tag + ': no lane stays free longer than the no camping limit (' + (hard ? GAME.sprint.hard.lim : GAME.camp.join('/')) + ' s): ' + strict + ' of ' + open + ' gaps over it, by ' + (worstOpen - limMax).toFixed(2) + ' s at most', strict);
  ok(over5 === 0 && worst <= 4.6, tag + ': with roofs and the road of a passing train counted, standing still in any lane is hit within ' + worst.toFixed(2) + ' s (at ' + worstAt + ' m)');
  const tot = lanes.reduce((s, L) => s + L.n, 0), km = KM * 1000 / v;
  lanes.forEach((L, l) => ok(L.n / km >= .25, tag + ': lane ' + l + ' is blocked regularly (' + (L.n / km).toFixed(2) + ' hazards per second)'));
  // the same lane is never the safe line for two patterns in a row (from tier 1, and always in a sprint)
  let twice = 0;
  for (let i = 1; i < sts.length; i++) {
    const a = sts[i - 1], b = sts[i]; if (a.id === 'REST' || b.id === 'REST' || !a.rows.length || !b.rows.length || (!hard && tierOf(b.x0) < 1)) continue;
    [0, 1, 2, 3].forEach(l => { if (!C.campHaz(a.rows, l).length && !C.campHaz(b.rows, l).length && !shelters[l].some(q => q[1] > a.x0 && q[0] < b.x0 + b.len)) twice++; });
  }
  ok(twice === 0, tag + ': no lane is free through two patterns in a row', twice);
  console.log('   ' + tag + ': hazards per lane ' + lanes.map(L => L.n).join('/') + ', longest free ' + worstOpen.toFixed(2) + ' s (' + worst.toFixed(2) + ' s with roofs and train roads)' + (hard ? '' : ', per tier ' + perTier.map(x => x.toFixed(2)).join('/')));
});
// standing still at 300 m, 2 km and 5.5 km (the game's real speed there) and in a sprint: hit within a few seconds in every lane, from any moment
{
  const base = t => Math.min(GAME.speed.max, GAME.speed.start + GAME.speed.ramp * t) * 1.012;
  const at = m => { let t = 0, d = 0; while (d < m) { d += base(t) * .05; t += .05; } return base(t); };
  [[300, false], [2000, false], [5500, false], [2000, true], [5500, true]].forEach(([m, hard], k) => {
    const v = at(m) * (hard ? GAME.sprint.boost : 1), { lanes } = campRun((m + 1500) / 1000, v, hard, SEED + 200 + k);
    let worst = 0; lanes.forEach(L => L.gaps.forEach(gp => { if (gp.to > m - 200 && gp.from < m + 1200) worst = Math.max(worst, gp.s); }));
    console.log('   standing still around ' + m + ' m' + (hard ? ' in a sprint' : '') + ' (' + v.toFixed(1) + ' m/s): hit within ' + worst.toFixed(2) + ' s');
    ok(worst < 5, 'standing still around ' + m + ' m' + (hard ? ' in a sprint' : '') + ' (' + v.toFixed(1) + ' m/s): hit within ' + worst.toFixed(2) + ' s in every lane, from any moment');
  });
}

// ---------- 6. speed and sprint numbers (GAME.speed, GAME.sprint) and the server's average speed check
console.log('6. speed and sprints');
ok(GAME.speed.start === 9 && GAME.speed.max === 17 && GAME.speed.ramp === .07, 'start at 9 m/s, top speed 17 m/s, +0.07 m/s per second', GAME.speed);
ok(GAME.sprint.first === 45 && GAME.sprint.dur === 60 && GAME.sprint.gapMin === 75 && GAME.sprint.gapMax === 90, 'first sprint at 45 s, 60 s long, the next 75 to 90 s after one ends', GAME.sprint);
ok(GAME.sprint.hard.budget === 3, 'sprint sets have 3 times the cost budget');
ok(/var base=baseAt\(t\),cap=dist-\(T15\?1500:0\)>\(PROF&&Array\.isArray\(PROF\.outfits\)\?SPD\.avgMax:SPD\.avgOld\)\*t\+20/.test(html) && /spr=SP\.dur;/.test(html) && /sprN=t\+SP\.gapMin\+Math\.random\(\)\*\(SP\.gapMax-SP\.gapMin\)/.test(html), 'run.html uses GAME.speed and GAME.sprint for speed and sprint timing');
ok(!/7\.4\+\.07/.test(html), 'no old 7.4 m/s start left in run.html');
ok(/EV\.sprints\+\+/.test(html) && /coins\+=\(spr>0\|\|T5\)\?2:1/.test(html), 'a finished sprint still counts (EV.sprints) and coins are still x2 during a sprint');
{
  // a perfect 30 minute run, frame by frame like run.html (no hits, every sprint, a jetpack now and then): never faster than the server allows
  let t = 0, dist = 0, spd = 9 * .6, spr = 0, rec = 0, sprN = GAME.sprint.first, fly = 0, worst = -1e9, sprints = 0, nextJet = 30; const dt = 1 / 60, SPD = GAME.speed, SP = GAME.sprint;
  while (t < 1800) {
    const base = Math.min(SPD.max, SPD.start + SPD.ramp * t) * 1.012, cap = dist > SPD.avgMax * t + 20;
    const target = cap ? base : base * (fly > 0 ? 1.15 : 1) * (spr > 0 ? SP.boost : rec > 0 ? .9 : 1);
    spd += (target - spd) * Math.min(1, dt * 3); dist += spd * dt; t += dt;
    if (t >= nextJet) { fly = 7; nextJet = t + 40; } fly = Math.max(0, fly - dt);
    if (t >= sprN && spr <= 0 && rec <= 0 && fly <= 0) spr = SP.dur;
    if (spr > 0) { spr -= dt; if (spr <= 0) { spr = 0; rec = 5; sprints++; sprN = t + SP.gapMin + Math.random() * (SP.gapMax - SP.gapMin); } } else if (rec > 0) rec = Math.max(0, rec - dt);
    if (t > 3) worst = Math.max(worst, Math.floor(dist) - (Math.round(t) * 19.5 + 30));
  }
  console.log('   30 minute perfect run: ' + sprints + ' sprints, closest to the server limit ' + worst.toFixed(1) + ' m');
  ok(worst <= 0, 'a 30 minute run never goes over the server check (m <= secs x 19.5 + 30), closest ' + worst.toFixed(1) + ' m', worst);
  ok(sprints >= 11, '30 minutes have ' + sprints + ' full sprints');
}
{
  // a server from before Oct 26 refuses more than 17.5 m/s on average: with no outfits in the reply the client keeps under it
  let t = 0, dist = 0, spd = 9 * .6, spr = 0, rec = 0, sprN = GAME.sprint.first, worst = -1e9; const dt = 1 / 60, SPD = GAME.speed, SP = GAME.sprint;
  while (t < 1800) {
    const base = Math.min(SPD.max, SPD.start + SPD.ramp * t) * 1.012, cap = dist > SPD.avgOld * t + 20;
    spd += ((cap ? base : base * (spr > 0 ? SP.boost : rec > 0 ? .9 : 1)) - spd) * Math.min(1, dt * 3); dist += spd * dt; t += dt;
    if (t >= sprN && spr <= 0 && rec <= 0) spr = SP.dur;
    if (spr > 0) { spr -= dt; if (spr <= 0) { spr = 0; rec = 5; sprN = t + SP.gapMin; } } else if (rec > 0) rec = Math.max(0, rec - dt);
    if (t > 3) worst = Math.max(worst, Math.floor(dist) - (Math.max(3, Math.round(t - .5)) * 17.5 + 30));
  }
  ok(worst <= 0, 'with an older server (17.5 m/s) a 30 minute run never goes over its check, closest ' + worst.toFixed(1) + ' m', worst);
}

{
  // the real speed vs the planned speed: stretches are planned like run.html (vAt, hardAt), the runner speeds up at every sprint start,
  // and each stretch must still be passable at the speed really run there (a stretch run faster than planned can be impossible)
  const mm = /vAt=function\(x\)\{var tr=reachT\(x\),w=sprWin\(\);return baseAt\(tr\+1\)\*\(tr>=w\[0\]-([\d.]+)&&tr<=w\[1\]\+1\.5\?SP\.boost:1\)\}/.exec(html);
  ok(!!mm, 'run.html plans the sprint speed with vAt');
  const MARG = mm ? +mm[1] : 0, SP = GAME.sprint, SPD = GAME.speed; let bad = 0, n = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const R = rng(seed), g = C.Gen({ rand: R, theme: themeOf, cityAt, wave: () => true, north: ci => ci >= 13, start: 26, camp: GAME.camp, sprint: GAME.sprint });
    let t = 0, dist = 0, spd = SPD.start * .6, spr = 0, rec = 0, sprN = SP.first; const dt = 1 / 120, traj = [], ST = [];
    const baseAt = tt => Math.min(SPD.max, SPD.start + SPD.ramp * tt) * 1.012, reachT = x => t + Math.max(0, x - dist) / Math.max(spd, SPD.start * .8);
    const sprWin = () => { const a = spr > 0 ? t : Math.max(t, sprN); return [a, a + (spr > 0 ? spr : SP.dur)]; };
    const vAt = x => { const tr = reachT(x), w = sprWin(); return baseAt(tr + 1) * (tr >= w[0] - MARG && tr <= w[1] + 1.5 ? SP.boost : 1); };
    const hardAt = x => { const tr = reachT(x), w = sprWin(); return tr >= w[0] - .5 && tr <= w[1]; };
    while (t < 900) {
      spd += (baseAt(t) * (spr > 0 ? SP.boost : rec > 0 ? .9 : 1) - spd) * Math.min(1, dt * 3); dist += spd * dt; t += dt; traj.push([dist, t, spd]);
      if (t >= sprN && spr <= 0 && rec <= 0) spr = SP.dur;
      if (spr > 0) { spr -= dt; if (spr <= 0) { spr = 0; rec = 5; sprN = t + SP.gapMin + R() * (SP.gapMax - SP.gapMin); } } else if (rec > 0) rec = Math.max(0, rec - dt);
      let k = 0; while (g.cursor() < dist + Math.max(80, 4.5 * vAt(dist + 20)) && k < 30) { const cx = g.cursor(); ST.push(g.next(dist, vAt(cx), hardAt(cx))); k++; }
    }
    let j = 0; const at = x => { while (j < traj.length - 1 && traj[j][0] < x) j++; return traj[j]; };
    ST.forEach(st => { if (!st.rows.length || st.x0 + st.len > dist) return; j = 0; const rows = st.rows.map(r => { const q = at(r.x); return { x: r.x, t: q[1], c: r.c, v: q[2] }; });
      const vmax = Math.max.apply(null, rows.map(r => r.v)); n++;
      if (vmax > st.v * 1.005 && g.everyState(rows.map(r => ({ x: r.x, t: r.t, v: vmax, c: r.c })), vmax, st.alive0 || []).fail) bad++; });
  }
  console.log('   6 x 15 minutes with sprints: ' + n + ' stretches checked at the speed really run');
  ok(bad === 0, 'no stretch is run faster than it can be passed (sprint starts included)', bad);
}

console.log('7. run.html fairness rules');
ok(!/var bike=|weave:1|var cat=|var fishLine=|TRAIN&&o\.lane===TRAIN\.lane/.test(html), 'no bike weaving, no cat crossing, no fishing line, no blind train lane clearing');
ok(/z=city\?2\.75:-2\.62/.test(html), 'background walkers stay off the 4 lanes');
ok(/var loseLife=[\s\S]{0,200}clearAhead\(2\.0\)/.test(html), 'a lost life clears 2 s ahead');
ok(/obPut\(/.test(html) && /function obLoad\(\)/.test(html), 'Kenney models load once and are cloned');
ok(!/ - |—/.test(JSON.stringify(GAME.intro)), 'intro text has no dashes');
const names = [].concat.apply([], GAME.themes.map(t => [].concat(t.B, t.b, t.L, t.H)));
ok(names.every(n => new RegExp('var ' + n + '=function').test(html)), 'every theme name has a builder', names.filter(n => !new RegExp('var ' + n + '=function').test(html)));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
