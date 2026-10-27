#!/usr/bin/env node
// PDF smoke test for client/nut-pdf.js: builds the plan page (English and Arabic) from the sample plan that nutrition.js writes,
// checks every section is there, then prints it to a real PDF with headless Chromium (Playwright) when it is installed,
// and checks download() hands the page to html2pdf. Run after nutrition.js:  node nut_pdf.js
const fs = require('fs'), path = require('path');
const PDF = require('../../../client/nut-pdf.js');
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) pass++; else { fail++; console.log('   FAIL: ' + m + (x !== undefined ? '\n         ' + String(x).slice(0, 400) : '')); } };
const sampleFile = process.env.WB_SAMPLE_OUT || path.join(__dirname, '.out', 'sample-plan.json');
(async () => {
  if (!fs.existsSync(sampleFile)) { console.log('no sample plan: run node nutrition.js first'); process.exit(1); }
  const S = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
  const o = lang => ({ plan: { data: S.plan, picks: S.picks, macros: S.targets }, cycle: S.cycle, start: S.cycle.start, calc: S.calculator_now, disclaimer: S.disclaimer, name: 'Ziad', lang });
  const en = PDF.html(o('en')), ar = PDF.html(o('ar'));
  for (const [t, m] of [['3,120', 'targets'], ['Breakfast · 07:45', 'breakfast options'], ['Snack · 16:30', 'snack options'], ['Week 3', 'all 3 weeks'], ['class="grid"', 'week grid'],
    ['↺ Swap: ', 'swaps'], ['Main prep', 'main prep'], ['Mid-week top-up', 'top-up'], ['Grocery list · week 1', 'grocery lists'], ['Friday night out', 'night out'],
    ['Sunday family lunch', 'family lunch'], ['estimate', 'restaurant numbers marked as estimates'], ['Menu not found, coach will add it.', 'menu not found'], ['Reminders', 'reminders'],
    ['General guidance for healthy eating', 'disclaimer'], ['>usual<', 'the usual pick marked']]) ok(en.includes(t), 'English PDF page has: ' + m, t);
  ok(ar.includes('dir="rtl"') && ar.includes('الأسبوع 3') && ar.includes('لائحة المشتريات') && ar.includes('إرشادات عامة'), 'Arabic PDF page (right to left)');
  ok(!/undefined|NaN|\[object Object\]/.test(en + ar), 'no broken values', (en + ar).match(/.{60}(undefined|NaN|\[object Object\]).{20}/)?.[0]);
  // a real PDF
  let pw = null; for (const m of ['playwright', '/opt/npm-tools/node_modules/playwright']) { try { pw = require(m); break; } catch (e) {} }
  if (!pw) { console.log('   (Playwright not installed: PDF print skipped)'); }
  else {
    const exe = process.env.WB_CHROME || (fs.existsSync('/opt/pw-browsers/chromium-1243/chrome-linux64/chrome') ? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' : undefined);
    const browser = await pw.chromium.launch(exe ? { executablePath: exe } : {});
    const page = await browser.newPage();
    for (const [lang, html] of [['en', en], ['ar', ar]]) {
      await page.setContent(html, { waitUntil: 'load' });
      const buf = await page.pdf({ format: 'A4', printBackground: true });
      const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      ok(buf.slice(0, 5).toString() === '%PDF-' && buf.length > 30000 && pages >= 5, `real PDF (${lang}): ${Math.round(buf.length / 1024)} KB, ${pages} pages`, buf.length + ' bytes, ' + pages + ' pages');
      if (process.env.WB_PDF_OUT) fs.writeFileSync(process.env.WB_PDF_OUT.replace(/\.pdf$/, '') + '-' + lang + '.pdf', buf);
    }
    // download(): html2pdf gets the plan element and the file name (the library itself comes from cdnjs, stubbed here)
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../../client/nut-pdf.js'), 'utf8') });
    const got = await page.evaluate(async o => {
      let seen = null;
      window.html2pdf = () => { const c = { set(x) { seen = { name: x.filename }; return c; }, from(el) { seen.cls = el.className; seen.text = el.textContent.length; return c; }, save() { return Promise.resolve(); } }; return c; };
      const r = await WBNutPdf.download(o); return Object.assign({ r, left: document.querySelectorAll('.wbpdf').length }, seen);
    }, o('ar'));
    ok(got.r === 'pdf' && got.name === 'Wellbe-nutrition-plan-ar.pdf' && got.cls === 'wbpdf' && got.text > 5000 && got.left === 0, 'download() saves through html2pdf and cleans up', JSON.stringify(got));
    await browser.close();
  }
  console.log(`\nnut_pdf: ${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
