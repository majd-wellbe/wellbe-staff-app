#!/usr/bin/env node
// Checks import.sql against the sheet: lists every place where the stored value differs from the sheet cell,
// grouped by kind, with counts only (no client data printed). Run after import.js.
// Usage: node audit.js <csv folder> <import.sql>
// Expected (owner approved, 27 Oct 2026): phones normalised, emails lowercased/trimmed, trainer names matched to STAFF,
// attendance worked out for tabs with no attendance cell (Osteo, Madero, 1:1, 1:2, Physio), empty end time = start + 1h,
// the second CORNICHE RUN row for one client skipped. Anything else listed here needs a look.
const fs = require('fs'), path = require('path'), vm = require('vm');
require(path.join(__dirname, 'gs-mock.js'));
const G = process.env.WB_GS || path.join(__dirname, '../../../../1-apps-script/phase3');
const files = fs.readdirSync(G).filter(f => f.endsWith('.gs')).sort((a, b) => (a === 'Config.gs') - (b === 'Config.gs'));
vm.runInThisContext(files.map(f => fs.readFileSync(path.join(G, f), 'utf8')).join('\n;\n'));
const I = require(path.join(__dirname, '../import.js'));
const D = process.argv[2], SQL = fs.readFileSync(process.argv[3], 'utf8');
const norm = x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '');   // same file matching as import.js
const tab = n => { const f = fs.readdirSync(D).filter(x => /\.csv$/i.test(x) && norm(x.replace(/\.csv$/i, '')).endsWith(norm(n))).sort((a, b) => a.length - b.length)[0]; return f ? I.parseCsv(fs.readFileSync(path.join(D, f), 'utf8')) : null; };
const S = v => String(v == null ? '' : v).trim(), c = {}, inc = k => { c[k] = (c[k] || 0) + 1; };
const has = v => SQL.includes("'" + String(v).replace(/'/g, "''") + "'");

const cl = tab('CLIENTS'); cl.slice(1).forEach(r => { if (!S(r[0])) return;
  if (S(r[3]) && I.phone(r[3], '961') !== S(r[3])) inc('CLIENTS phone normalised (approved)');
  if (S(r[2]) && clEmail_(r[2]) !== S(r[2])) inc(clEmail_(r[2]) ? 'CLIENTS email lowercased/trimmed (approved)' : 'CLIENTS invalid email stored empty');
  [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].forEach(j => { if (S(r[j]) && !has(S(r[j]))) inc('CLIENTS column ' + cl[0][j] + ' not found in import.sql'); });
});
const pk = tab('PACKAGES'); pk.slice(2).forEach(r => { if (!S(r[0])) return;
  [14, 16, 17, 18, 20].forEach(j => { if (S(r[j]) && !has(S(r[j]))) inc('PACKAGES column ' + pk[1][j] + ' not found in import.sql'); });
  const d = S(r[19]); if (d && !/%/.test(d) && Number(d) > 0 && Number(d) <= 1) inc('PACKAGES discount <= 1 stored x100');
});
const vals = ['Scheduled', 'Done', 'Cancelled', 'Early Cancel', 'Late Cancel', 'No Show', ''];
Object.keys(AT).forEach(k => { const cfg = AT[k], t = tab(cfg.sheet); if (!t) return; t.slice(2).forEach((r, i) => { if (!S(r[0])) return;
  const d = r.slice(); while (d.length < cfg.width) d.push('');
  const st = S(d[cfg.status - 1]); if (vals.indexOf(st) < 0) inc('SESSIONS unknown status replaced');
  const s = appSessObj_(k, cfg, d, d, i + 3, appYmd_(d[1], d[1]));
  if (!s.end) inc('SESSIONS empty end time stored as start + 1h (approved)');
  if (!cfg.fixed && s.trainer !== S(d[cfg.trainer - 1])) inc('SESSIONS trainer name matched to STAFF (approved)');
  s.clients.forEach(x => { const sl = cfg.slots[x.slot]; if (!(sl.att && S(d[sl.att - 1])) && x.att) inc('SESSION seats attendance worked out (no attendance cell in ' + k + ')'); });
}); });
const ld = tab('LEADS W40'); ld.slice(1).forEach(r => { if (!S(r[L.ID])) return;
  if (S(r[L.PHONE]) && I.phone(r[L.PHONE], '961') !== S(r[L.PHONE])) inc('LEADS phone normalised (approved)');
  if (S(r[L.EMAIL]) && clEmail_(r[L.EMAIL]) !== S(r[L.EMAIL])) inc('LEADS email lowercased/emptied');
  const st = S(r[L.STATUS]); if (STATUSES.indexOf(st) < 0) inc('LEADS status not in the list, stored as No Booking');
});
const gr = tab('CORNICHE RUN'), gs = {}; gr.slice(1).forEach(r => { const k = S(r[0]).toUpperCase(); if (!k) return; if (gs[k]) inc('CORNICHE RUN second row for one client skipped (approved)'); gs[k] = 1; });
const ex = tab('EXERCISES'), es = {}; ex.slice(1).forEach(r => { const k = S(r[0]) + '|' + S(r[1]); if (es[k]) inc('EXERCISES duplicate skipped'); es[k] = 1; });
console.log(JSON.stringify(c, null, 1));
