// node backend.js : core/wb-backend.js with a fake browser (no network)
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('   FAIL: ' + m); } };
function boot(store, answers, search) {
  const calls = [], ls = Object.assign({}, store);
  const ctx = { window: {}, location: { search: search || '' }, console: { warn() {}, log: console.log }, setTimeout, clearTimeout, Promise, JSON, AbortController,
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; }, get length() { return Object.keys(ls).length; }, key: i => Object.keys(ls)[i] },
    fetch: async (url, init) => { const b = JSON.parse(init.body); calls.push({ url, b, h: init.headers }); const which = /supabase/.test(url) ? 'supa' : 'apps'; const a = answers(which, b); return { ok: true, status: 200, json: async () => a }; } };
  ctx.window = ctx; vm.createContext(ctx);
  for (const f of ['core/wb-core.js', 'core/wb-backend.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../..', f), 'utf8'), ctx);
  return { WB: ctx.WB, calls, ls };
}
const tick = () => new Promise(r => setTimeout(r, 20));
(async () => {
  let t = boot({}, () => ({ ok: true, x: 1 }));
  await t.WB.api('app_boot', {}, { key: 'k' });
  ok(t.calls.length === 1 && /script.google/.test(t.calls[0].url), 'default: Apps Script');
  t.WB.setCfg({ backend: { use: 'supabase' } });
  await t.WB.api('app_boot', {}, { key: 'k' });
  ok(/supabase.co\/functions\/v1\/api/.test(t.calls[1].url) && t.calls[1].h.apikey.startsWith('sb_publishable_') && t.calls[1].b.key === 'k' && t.calls[1].b.action === 'app_boot', 'settings flag: Supabase, same body + publishable key');
  t.WB.setBackend('apps'); await t.WB.api('app_boot', {}, { key: 'k' }); ok(/script.google/.test(t.calls[2].url), 'phone override wins');
  t = boot({ wb_backend: 'supabase' }, () => ({ ok: false, error: 'auth' }));
  let err = null; await t.WB.api('app_boot', {}, { key: 'bad' }).catch(e => { err = e; });
  ok(err && err.message === 'auth' && !err.net, 'errors keep today\'s shape');
  // shadow
  t = boot({ wb_shadow: '1' }, (w, b) => b.action === 'wb_shadow' ? { ok: true } : { ok: true, ts: Math.random(), list: w === 'apps' ? [1, 2, 3] : [1, 2, 4], n: 0.1 + 0.2 });
  const r = await t.WB.api('app_boot', { d: 1 }, { token: 't' }); await tick();
  const sh = t.calls.find(c => c.b.action === 'wb_shadow');
  ok(r.list.join() === '1,2,3', 'shadow: the app gets the main (Apps Script) answer');
  ok(t.calls.filter(c => c.b.action === 'app_boot').length === 2 && sh && sh.b.same === false && sh.b.of === 'app_boot' && sh.b.token === 't' && JSON.stringify(sh.b.diff) === '[{"p":"list.2","apps":"3","supa":"4"}]', 'shadow: difference reported ' + JSON.stringify(sh && sh.b));
  t.calls.length = 0; await t.WB.api('app_sell', { cid: 'C1' }, { key: 'k' }); await tick();
  ok(t.calls.length === 1, 'writes never go twice');
  t = boot({ wb_shadow: '1' }, (w, b) => b.action === 'wb_shadow' ? { ok: true } : { ok: true, ts: w, a: [1] });
  await t.WB.api('app_cl_boot', {}, { token: 't' }); await tick();
  ok(t.calls.find(c => c.b.action === 'wb_shadow').b.same === true, 'volatile fields ignored -> same');
  ok(t.WB.isRead('app_cl_run', { op: 'get' }) && !t.WB.isRead('app_cl_run', { op: 'save' }) && !t.WB.isRead('app_pay'), 'read list');
  // ?wb= on the address: remembered on this phone
  t = boot({}, () => ({ ok: true }), '?wb=supabase'); ok(t.ls.wb_backend === 'supabase' && t.WB.backend() === 'supabase', '?wb=supabase sets this phone');
  t = boot({ wb_backend: 'supabase' }, () => ({ ok: true }), '?x=1&wb=auto'); ok(!('wb_backend' in t.ls) && t.WB.backend() === 'apps', '?wb=auto follows the settings again');
  t = boot({}, () => ({ ok: true }), '?wb=shadow'); ok(t.ls.wb_shadow === '1' && t.WB.shadowOn(), '?wb=shadow');
  t = boot({ wb_shadow: '1' }, () => ({ ok: true }), '?wb=noshadow'); ok(!t.WB.shadowOn(), '?wb=noshadow');
  t = boot({}, () => ({ ok: true }), '?wb=evil'); ok(!('wb_backend' in t.ls) && !t.WB.shadowOn(), 'other values ignored');
  console.log(`backend: ${pass} checks passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
