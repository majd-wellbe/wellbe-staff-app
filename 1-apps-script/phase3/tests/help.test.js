#!/usr/bin/env node
// Help + profile steps server tests: Help.gs and the profClient_ router line (Profile.gs), in node with in memory sheets.
// Run: node 1-apps-script/phase3/tests/help.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const DIR = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('  FAIL: ' + msg + (extra !== undefined ? '\n        ' + JSON.stringify(extra).slice(0, 900) : '')); } }
function fnSrc(file, name) {
  const s = fs.readFileSync(path.join(DIR, file), 'utf8'), i = s.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error(name + ' not found in ' + file);
  let k = s.indexOf('{', i), depth = 0, q = null;
  for (; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '/' && s[k + 1] === '/') { k = s.indexOf('\n', k); continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(i + 1, k + 1);
  }
  throw new Error('no end for ' + name);
}
function makeWorld(withHelp) {
  const books = {};
  function Sheet(name) { this.name = name; this.rows = []; }
  Sheet.prototype.getLastRow = function () { let n = this.rows.length; while (n && !(this.rows[n - 1] || []).some(v => v !== '' && v !== undefined && v !== null)) n--; return n; };
  Sheet.prototype.appendRow = function (r) { this.rows[this.getLastRow()] = r.slice(); return this; };
  Sheet.prototype.setFrozenRows = function () {};
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    const sh = this; nr = nr || 1; nc = nc || 1;
    const vals = () => { const out = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v == null ? '' : v); } out.push(o); } return out; };
    const rg = {
      getValues: vals, getValue: () => vals()[0][0],
      setValues: (vs) => { vs.forEach((vr, i) => { const ri = r - 1 + i; while (sh.rows.length <= ri) sh.rows.push([]); sh.rows[ri] = sh.rows[ri] || []; vr.forEach((v, j) => { sh.rows[ri][c - 1 + j] = v; }); }); return rg; },
      setFontWeight: () => rg, setBackground: () => rg, setFontColor: () => rg
    };
    return rg;
  };
  function Book() { this.tabs = {}; }
  Book.prototype.getSheetByName = function (n) { return this.tabs[n] || null; };
  Book.prototype.insertSheet = function (n) { return (this.tabs[n] = new Sheet(n)); };
  const ctx = {
    JSON, Math, Date, String, Number, Array, Object, Error, RegExp, console,
    Logger: { log: () => {} },
    SpreadsheetApp: { openById: (id) => books[id] || (books[id] = new Book()) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 16) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
  };
  vm.createContext(ctx);
  const code = [
    "var CFG = { OPS_ID: 'OPS', TZ: 'UTC' }; var RO_ = false;",
    fnSrc('Code.gs', 'roGuard_'), fnSrc('Code.gs', 'roTry_'), fnSrc('App.gs', 'appTab_'),
    "function appClientInfo_(cid) { return { name: 'Name of ' + cid }; }",
    "function clean_(v, n) { return String(v || '').slice(0, n); } function clLog_() {}",
    fs.readFileSync(path.join(DIR, 'Profile.gs'), 'utf8'),
    withHelp ? fs.readFileSync(path.join(DIR, 'Help.gs'), 'utf8') : ''
  ].join('\n');
  vm.runInContext(code, ctx, { filename: 'gs.js' });
  ctx.ops = () => books.OPS;
  return ctx;
}
const call = (W, b) => W.profClient_(b, 'C001', { ids: ['C001'] });
const tab = (W) => W.ops().getSheetByName('CLIENT APP STATE');

console.log('Help.gs + Profile.gs router');
// 1. state on an empty sheet: nothing saved yet, no tab made, works without the lock
{
  const W = makeWorld(true);
  const rt = W.roTry_(() => call(W, { op: 'state' }));
  ok(rt && rt.v.help && rt.v.help.tips === null && rt.v.help.asked === 0 && JSON.stringify(rt.v.steps) === '{}', 'empty state', rt);
  ok(!W.ops() || !tab(W), 'state read makes no tab');
}
// 2. help save/load, reload from the sheet (another phone)
{
  const W = makeWorld(true);
  call(W, { op: 'help', help: { tips: true, asked: 1, tour: 'done', pages: { center: { s: 'done' }, play: { s: 'prog', n: 2 } } } });
  const r = call(W, { op: 'state' });
  ok(r.help.tips === true && r.help.asked === 1 && r.help.tour === 'done', 'help saved', r.help);
  ok(r.help.pages.center.s === 'done' && r.help.pages.play.s === 'prog' && r.help.pages.play.n === 2, 'pages saved', r.help.pages);
  ok(tab(W).getLastRow() === 2 && tab(W).rows[1][1] === 'Name of C001', 'one row with the name', tab(W).rows);
  // a stale phone sends older state: done stays done, asked never goes down, tour stays done
  const s = call(W, { op: 'help', help: { asked: 0, tour: 'skipped', pages: { center: { s: 'prog', n: 0 }, play: { s: 'done' } } } });
  ok(s.help.pages.center.s === 'done', 'done page never goes back to in progress', s.help.pages);
  ok(s.help.pages.play.s === 'done', 'in progress moves to done', s.help.pages);
  ok(s.help.asked === 1 && s.help.tour === 'done', 'asked and tour never go backwards', s.help);
  // tips switch: last choice wins
  ok(call(W, { op: 'help', help: { tips: false } }).help.tips === false, 'tips off saved');
  ok(call(W, { op: 'state' }).help.tips === false, 'tips off loads');
  // dismissed is final too
  call(W, { op: 'help', help: { pages: { shop: { s: 'dismissed' } } } });
  ok(call(W, { op: 'help', help: { pages: { shop: { s: 'prog', n: 1 } } } }).help.pages.shop.s === 'dismissed', 'dismissed stays');
  // reset all tips
  const z = call(W, { op: 'help_reset' });
  ok(JSON.stringify(z.help.pages) === '{}' && z.help.tips === true && z.help.tour === 'done' && z.help.asked === 1, 'reset clears pages only, tips on', z.help);
  ok(tab(W).getLastRow() === 2, 'still one row');
  // junk is dropped
  const j = call(W, { op: 'help', help: { asked: 99, pages: { 'Bad Key!': { s: 'done' }, me: { s: 'weird' }, x: { s: 'done' } } } });
  ok(j.help.asked === 9 && !j.help.pages['Bad Key!'] && !j.help.pages.me && !j.help.pages.x, 'bad input cleaned', j.help);
}
// 3. durable profile steps
{
  const W = makeWorld(true);
  const a = call(W, { op: 'steps', met: ['photo', 'body', 'hack'] });
  ok(a.steps.photo && a.steps.photo.doneAt && a.steps.body && !a.steps.hack, 'steps marked, unknown keys ignored', a.steps);
  const t0 = a.steps.photo.doneAt;
  // later loads: photo removed, body edited: the phone reports only what is met now; nothing unticks, doneAt kept
  const b = call(W, { op: 'steps', met: ['promise'] });
  ok(b.steps.photo && b.steps.photo.doneAt === t0 && b.steps.body && b.steps.promise, 'done stays done across edits', b.steps);
  const c = call(W, { op: 'steps', met: [] });
  ok(Object.keys(c.steps).length === 3, 'empty report never unticks', c.steps);
  // reload (another phone): same steps
  const d = call(W, { op: 'state' });
  ok(JSON.stringify(d.steps) === JSON.stringify(c.steps), 'reload keeps steps', d.steps);
  // help and steps live on the same row and do not overwrite each other
  call(W, { op: 'help', help: { tips: true } });
  ok(Object.keys(call(W, { op: 'state' }).steps).length === 3, 'help save keeps steps');
  call(W, { op: 'steps', met: ['run'] });
  ok(call(W, { op: 'state' }).help.tips === true, 'steps save keeps help');
  // migration: an existing user whose conditions are met gets all of them on first load
  const M = makeWorld(true);
  const m = call(M, { op: 'steps', met: ['photo', 'promise', 'body', 'intake', 'run', 'credit'] });
  ok(Object.keys(m.steps).length === 6, 'migration marks every met step', m.steps);
  // steps merge is pure and never removes
  ok(JSON.stringify(W.stepsMerge_({ photo: { doneAt: 'x' } }, [], 'y')) === '{"photo":{"doneAt":"x"}}', 'merge keeps old doneAt');
}
// 4. writes on the lock free path ask for the lock (router falls back), unknown ops stay unknown
{
  const W = makeWorld(true);
  ok(W.roTry_(() => call(W, { op: 'help', help: { tips: true } })) === null, 'a write without the lock asks for the lock');
  let e = ''; try { call(W, { op: 'nope' }); } catch (x) { e = x.message; }
  ok(e === 'unknown', 'unknown op', e);
}
// 5. old server (no Help.gs): the help ops answer "unknown" so the app falls back to the phone only
{
  const W = makeWorld(false);
  let e = ''; try { call(W, { op: 'state' }); } catch (x) { e = x.message; }
  ok(e === 'unknown', 'without Help.gs: unknown', e);
}
console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
