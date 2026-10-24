// Writes every tab of the in-memory test sheets (Apps Script mock) as CSV, like Google Sheets "Download > CSV":
// dates as dd/MM/yyyy (with time when not midnight), everything else as text.
const fs = require('fs'), path = require('path');
function two(n) { return String(n).padStart(2, '0'); }
function disp(v) {
  if (v instanceof Date) {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(v);
    const o = {}; p.forEach(x => o[x.type] = x.value); if (o.hour === '24') o.hour = '00';
    const d = `${o.day}/${o.month}/${o.year}`, t = `${o.hour}:${o.minute}:${o.second}`;
    return t === '00:00:00' ? d : d + ' ' + t;
  }
  return v === null || v === undefined ? '' : String(v);
}
const cell = v => { const s = disp(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function exportBooks(books, dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  Object.keys(books).forEach(id => Object.keys(books[id].sheets).forEach(name => {
    const sh = books[id].sheets[name], w = Math.max(1, ...sh.d.map(r => (r || []).length));
    const txt = sh.d.map(r => { const row = []; for (let j = 0; j < w; j++) row.push(cell((r || [])[j])); return row.join(','); }).join('\n');
    fs.writeFileSync(path.join(dir, name.replace(/[\/:]/g, '_') + '.csv'), txt + '\n');
  }));
}
module.exports = { exportBooks, disp };
