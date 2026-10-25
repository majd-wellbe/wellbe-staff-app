#!/usr/bin/env node
// Google Sheets "Download > Microsoft Excel (.xlsx)" -> one CSV per tab, named like Google's own CSV download
// ("<file name> - <TAB>.csv"), with every cell as the sheet SHOWS it (same as the CSV download), for import.js.
// Usage: node xlsx2csv.js --out <folder> "Client Portal.xlsx" "Operations.xlsx"
// One xlsx per spreadsheet gives every tab at once (a CSV download gives only one tab per click).
const fs = require('fs'), path = require('path');
let XLSX; try { XLSX = require('xlsx'); } catch (e) { XLSX = require(path.join(__dirname, '../tests/node_modules/xlsx')); }

function convert(files, out) {
  fs.mkdirSync(out, { recursive: true });
  const made = [];
  files.forEach(f => {
    const wb = XLSX.readFile(f, { cellDates: false, cellNF: true, cellText: true });
    const base = path.basename(f).replace(/\.xlsx$/i, '');
    wb.SheetNames.forEach(tab => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[tab], { FS: ',', RS: '\n', blankrows: true, rawNumbers: false });
      const name = (base + ' - ' + tab).replace(/[\/\\:*?"<>|]/g, '_') + '.csv';
      fs.writeFileSync(path.join(out, name), csv + '\n'); made.push(name);
    });
  });
  return made;
}
if (require.main === module) {
  const a = process.argv.slice(2), i = a.indexOf('--out');
  if (i < 0 || !a[i + 1]) { console.error('Usage: node xlsx2csv.js --out <folder> <file.xlsx> [...]'); process.exit(1); }
  const out = a[i + 1], files = a.filter((x, j) => j !== i && j !== i + 1);
  console.log(convert(files, out).length + ' tabs written to ' + out);
}
module.exports = { convert };
