#!/usr/bin/env node
// Same as phase5/supabase/import/xlsx2csv.js, plus one fix: a cell that holds a real date/time (number with a date format)
// is written as dd/MM/yyyy [HH:mm:ss] whatever its display format (mm/dd/yyyy, m/d/yy, d/m without year, mmmm yyyy).
// The live Apps Script reads these cells as Date objects (appYmd_ first branch), so this gives the same meaning.
const fs = require('fs'), path = require('path');
let XLSX; try { XLSX = require(process.env.WB_XLSX_MOD || 'xlsx'); } catch (e) { XLSX = require(path.join(__dirname, '../../tests/node_modules/xlsx')); }
const a = process.argv.slice(2), i = a.indexOf('--out'), out = a[i + 1], files = a.filter((x, j) => j !== i && j !== i + 1);
fs.mkdirSync(out, { recursive: true }); let n = 0, fixed = 0;
files.forEach(f => {
  const wb = XLSX.readFile(f, { cellDates: false, cellNF: true, cellText: true }), base = path.basename(f).replace(/\.xlsx$/i, '');
  wb.SheetNames.forEach(tab => {
    const ws = wb.Sheets[tab];
    Object.keys(ws).forEach(k => {
      if (k[0] === '!') return; const c = ws[k];
      if (c.t !== 'n' || !c.z || !XLSX.SSF.is_date(c.z)) return;
      const z = String(c.z).replace(/"[^"]*"|\[[^\]]*\]/g, '');
      if (!/[dy]/i.test(z)) return;                       // time-only (hh:mm, h:mm am/pm): keep as shown
      const w = XLSX.SSF.format(/h/i.test(z) ? 'dd/mm/yyyy hh:mm:ss' : 'dd/mm/yyyy', c.v);
      if (w !== c.w) fixed++; c.w = w;
    });
    const csv = XLSX.utils.sheet_to_csv(ws, { FS: ',', RS: '\n', blankrows: true, rawNumbers: false });
    fs.writeFileSync(path.join(out, (base + ' - ' + tab).replace(/[\/\\:*?"<>|]/g, '_') + '.csv'), csv + '\n'); n++;
  });
});
console.log(n + ' tabs written to ' + out + ', ' + fixed + ' date cells rewritten as dd/MM/yyyy');
