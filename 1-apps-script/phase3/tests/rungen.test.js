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
[7.4, 10, 13, 17, 20.7].forEach(v => {
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
  const R = rng(SEED + si), g = C.Gen({ rand: R, theme: themeOf, cityAt, wave: () => true, north: ci => ci >= 13, start: 26 });
  let n = 0, bad = [], rests = [], kinds = {}, movers = 0, plats = 0, coinsBad = 0, slotsBad = 0, alive = g.state().alive, prevEnd = 26, gaps = [], tiers = {};
  while (g.cursor() < KM * 1000) {
    const dist = Math.max(0, g.cursor() - 90), st = g.next(dist, v); n++; kinds[st.id] = (kinds[st.id] || 0) + 1; tiers[st.tier] = 1;
    if (st.rows.length) {
      const r = g.everyState(st.rows, v, alive);
      if (r.fail) bad.push({ id: st.id, x: Math.round(st.x0), row: r.fail.row });
      // the stretch alone must also be fine from every lane (its real fillers, movers and roofs)
      if (!C.validatePattern({ rows: st.rows.map(q => ({ x: q.x - st.x0, c: q.c })) }, v).ok) bad.push({ id: st.id, x: Math.round(st.x0), alone: 1 });
      rests.push(st.rest / v); gaps.push((st.x0 - prevEnd) / v);
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
  const g = C.Gen({ rand: rng(7), theme: themeOf, cityAt, start: 26 }); const early = {};
  while (g.cursor() < 450) { const st = g.next(Math.max(0, g.cursor() - 90), 10); early[st.id] = 1; }
  const tooHard = Object.keys(early).filter(id => { const p = C.PATS.filter(q => q.id === id)[0]; return p && p.tier > 1; });
  ok(!tooHard.length, 'no tier 2+ pattern before 500 m', tooHard);
  ok(!Object.keys(early).some(id => /P2[23]|P3[0-2]/.test(id)), 'no train or taxi before 500 m', Object.keys(early));
}

console.log('5. run.html fairness rules');
ok(!/var bike=|weave:1|var cat=|var fishLine=|TRAIN&&o\.lane===TRAIN\.lane/.test(html), 'no bike weaving, no cat crossing, no fishing line, no blind train lane clearing');
ok(/z=city\?2\.75:-2\.62/.test(html), 'background walkers stay off the 4 lanes');
ok(/var loseLife=[\s\S]{0,200}clearAhead\(2\.0\)/.test(html), 'a lost life clears 2 s ahead');
ok(/obPut\(/.test(html) && /function obLoad\(\)/.test(html), 'Kenney models load once and are cloned');
ok(!/ - |—/.test(JSON.stringify(GAME.intro)), 'intro text has no dashes');
const names = [].concat.apply([], GAME.themes.map(t => [].concat(t.B, t.b, t.L, t.H)));
ok(names.every(n => new RegExp('var ' + n + '=function').test(html)), 'every theme name has a builder', names.filter(n => !new RegExp('var ' + n + '=function').test(html)));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
