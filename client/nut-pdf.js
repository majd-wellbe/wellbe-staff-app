/* Wellbe nutrition plan as a PDF (v4 plans). Looks like the in-app plan: targets, breakfast and snack options, the week grid,
   lunch and dinner with portions and swaps, nights out, prep steps, weekly grocery lists, reminders, disclaimer. English or Arabic.
   WBNutPdf.html(o)     -> a standalone HTML page (also used by the tests)
   WBNutPdf.download(o) -> Promise; saves "Wellbe-nutrition-plan.pdf" with html2pdf (cdnjs, loaded on first use), else opens the print dialog
   o = {plan:{data, picks, macros, note}, cycle, start:'YYYY-MM-DD', calc, disclaimer, name, lang:'en'|'ar', today} */
(function (root) {
  'use strict';
  var H2P = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
  var DAYS = { en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ar: ['اثنين', 'ثلاثا', 'أربعا', 'خميس', 'جمعة', 'سبت', 'أحد'] };
  var DAYK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var SLOT = { breakfast: ['Breakfast', 'ترويقة'], lunch: ['Lunch', 'غدا'], dinner: ['Dinner', 'عشا'], snack: ['Snack', 'سناك'] };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function addDays(ymd, n) { var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function dow(ymd) { return (new Date(ymd + 'T12:00:00Z').getUTCDay() + 6) % 7; }
  function make(o) {
    var L = o.lang === 'ar' ? 'ar' : 'en', ar = L === 'ar';
    var t = function (x) { if (x == null) return ''; if (typeof x === 'string') return x; return x[L] || x.en || ''; };
    var l = function (en, a) { return ar ? a : en; };
    var slot = function (s) { var x = SLOT[s]; return x ? x[ar ? 1 : 0] : (s || ''); };
    var num = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
    var P = (o.plan || {}).data || {}, picks = (o.plan || {}).picks || {}, M = (o.plan || {}).macros || P.macros || {}, C = o.calc || {};
    var start = o.start || o.today || new Date().toISOString().slice(0, 10), blocks = P.blocks || [0, 0, 1, 1, 2, 2, 3];
    var items = function (its) { return '<table class="it">' + (its || []).map(function (x) { return '<tr><td>' + esc(t(x.food)) + '</td><td class="q">' + (x.g ? Math.round(x.g) + ' ' + esc(x.unit || 'g') + ' · ' : '') + esc(t(x.measure)) + '</td></tr>'; }).join('') + '</table>'; };
    var tot = function (x) { x = x || {}; return '<span class="k">' + num(x.kcal) + ' kcal · P ' + num(x.p) + ' · C ' + num(x.c) + ' · F ' + num(x.f) + '</span>'; };
    var h = '';
    // cover and targets
    var cy = o.cycle || {};
    h += '<header><div class="brand">Wellbe</div><h1>' + l('Your 3-week nutrition plan', 'خطة التغذية (3 أسابيع)') + '</h1><div class="sub">' + esc(o.name || '') +
      (cy.start ? ' · ' + esc(cy.start) + ' → ' + esc(cy.end || addDays(cy.start, 20)) : (P.stage === 'draft' ? ' · ' + l('Week 1 draft', 'مسودة الأسبوع الأول') : '')) + '</div></header>';
    h += '<section class="targets"><div class="big">' + num(M.kcal) + ' <small>kcal ' + l('a day', 'باليوم') + '</small></div><div class="mac"><b>' + num(M.p) + ' g</b> ' + l('protein', 'بروتين') + ' · <b>' + num(M.c) + ' g</b> ' + l('carbs', 'نشويات') + ' · <b>' + num(M.f) + ' g</b> ' + l('fat', 'دهون') + '</div>' +
      (C.water_l ? '<div class="mac">💧 ' + l('Water: at least ' + C.water_l + ' L a day', 'المي: أقله ' + C.water_l + ' ليتر باليوم') + '</div>' : '') + '</section>';
    if ((o.plan || {}).note) h += '<p class="note">' + esc(o.plan.note) + '</p>';
    // breakfast and snack options
    (P.fixed || []).forEach(function (f, fi) {
      var pk = +(picks[fi] || 0);
      h += '<h2>' + esc(slot(f.slot)) + ' · ' + esc(f.time || '') + ' — ' + l(f.options.length + ' options', f.options.length + ' خيارات') + '</h2><p class="hint">' + l('All options are matched on calories and protein: swap any option on any day.', 'كل الخيارات متقاربة بالسعرات والبروتين: بدّل أي خيار بأي يوم.') + '</p><div class="grid2">';
      f.options.forEach(function (op, i) { h += '<div class="card' + (i === pk ? ' pick' : '') + '"><div class="mh"><b>' + (i + 1) + '. ' + esc(t(op.name)) + '</b>' + (i === pk ? '<span class="tag">' + l('usual', 'المعتاد') + '</span>' : '') + '</div>' + tot(op.totals) + items(op.items) + '</div>'; });
      h += '</div>';
    });
    // the weeks
    (P.weeks || []).forEach(function (W, wi) {
      h += '<div class="pb"></div><h2 class="wk">' + l('Week ' + W.week, 'الأسبوع ' + W.week) + '</h2>';
      // grid: 7 days, lunch and dinner (nights out marked)
      h += '<table class="grid"><tr><th></th>';
      var cols = [0, 1, 2, 3, 4, 5, 6].map(function (j) { var ymd = addDays(start, wi * 7 + j), d = dow(ymd); return { ymd: ymd, d: d, c: (W.combos || [])[blocks[d]] || {} }; });
      cols.forEach(function (c) { h += '<th>' + DAYS[L][c.d] + '<br><small>' + c.ymd.slice(8) + '/' + c.ymd.slice(5, 7) + '</small></th>'; });
      h += '</tr>';
      ['lunch', 'dinner'].forEach(function (s) {
        h += '<tr><th>' + esc(slot(s)) + '</th>' + cols.map(function (c) {
          var so = (P.social || []).filter(function (x) { return x.dow === c.d && x.slot === s; })[0];
          return so ? '<td class="out">' + esc(t(so.label)) + '</td>' : '<td>' + esc(t((c.c[s] || {}).name)) + '</td>';
        }).join('') + '</tr>';
      });
      h += '</table>';
      // the pairs with portions and swaps
      (W.combos || []).forEach(function (cb, ci) {
        var days = DAYK.map(function (k, d) { return blocks[d] === ci ? DAYS[L][d] : null; }).filter(Boolean).join(' + ');
        h += '<div class="pair"><div class="ph">' + esc(cb.key) + ' · ' + esc(t(cb.name)) + ' <small>(' + days + ')</small></div><div class="grid2">';
        ['lunch', 'dinner'].forEach(function (s) {
          var m = cb[s]; if (!m) return;
          h += '<div class="card"><div class="slot">' + esc(slot(s)) + '</div><div class="mh"><b>' + esc(t(m.name)) + '</b></div>' + tot(m.totals) + items(m.items) +
            (m.swap && m.swap.items ? '<div class="sw">↺ ' + l('Swap: ', 'بديل: ') + esc(t(m.swap.name)) + '</div>' + items(m.swap.items) : '') + '</div>';
        });
        h += '</div></div>';
      });
      // prep
      var B = W.batch || {};
      ['main', 'topup'].forEach(function (k) {
        var b = B[k]; if (!b) return; var st = (b.steps || {})[L] || (b.steps || {}).en || [];
        h += '<div class="card prep"><div class="slot">' + (k === 'main' ? l('Main prep', 'التحضير الأساسي') : l('Mid-week top-up', 'تحضير نص الأسبوع')) + ' · ' + esc(DAYS[L][Math.max(0, DAYK.indexOf(b.day))]) + ' ' + esc(b.time || '') + (b.minutes ? ' · ~' + b.minutes + ' min' : '') + '</div>' +
          '<div>' + l('Proteins: ', 'بروتين: ') + esc((b.proteins || []).map(t).join(', ')) + ' · ' + l('Carbs: ', 'نشويات: ') + esc((b.carbs || []).map(t).join(', ')) + ((b.veg || []).length ? ' · ' + l('Raw veg: ', 'خضرة نية: ') + esc(b.veg.map(t).join(', ')) : '') + '</div>' +
          (st.length ? '<ol>' + st.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>' : '') + '</div>';
      });
      // grocery: lunch and dinner + the usual picks
      var list = function (G, title) {
        if (!G) return ''; var s = '<div class="gl"><div class="slot">' + esc(title) + '</div>';
        (G.aisles || []).forEach(function (a) { s += '<div class="ai">' + esc(t(a.aisle)) + '</div>' + a.items.map(function (x) { return '<div class="gi">☐ ' + esc(t(x)) + ' <span class="q">' + esc(t(x.qty)) + '</span></div>'; }).join(''); });
        if (G.pantry && G.pantry.items.length) s += '<div class="ai">' + esc(t(G.pantry.title)) + '</div>' + G.pantry.items.map(function (x) { return '<div class="gi">☐ ' + esc(t(x)) + '</div>'; }).join('');
        return s + '</div>';
      };
      h += '<h3>' + l('Grocery list · week ' + W.week, 'لائحة المشتريات · الأسبوع ' + W.week) + '</h3><p class="hint">' + l('Meals out are left off.', 'أكل برّا مش محسوب.') + '</p><div class="grid2">' + list(W.grocery, l('Lunch and dinner', 'الغدا والعشا'));
      (P.fixed || []).forEach(function (f, fi) { var oi = +(picks[fi] || 0); h += list(((P.options_grocery || [])[fi] || [])[oi], slot(f.slot) + ' · ' + t(f.options[oi].name) + ' (×7)'); });
      h += '</div>';
    });
    // nights out
    if ((P.social || []).length) {
      h += '<div class="pb"></div><h2>' + l('Nights out and family lunch', 'السهرات وغدا العيلة') + '</h2>';
      P.social.forEach(function (s) {
        var b = s.budget || {};
        h += '<div class="card out"><div class="mh"><b>' + esc(t(s.label)) + '</b><span class="k">' + l('up to ', 'لحد ') + num(b.kcal) + ' kcal</span></div>';
        if (s.guide) h += (s.guide.items || []).map(function (x) { return '<div class="gi">• ' + esc(t(x)) + ' <span class="q">~' + num(x.kcal) + ' kcal</span></div>'; }).join('');
        if (s.home) h += '<div class="sw">🏠 ' + l('No gathering? ', 'ما في عزيمة؟ ') + esc(t(s.home.name)) + '</div>' + items(s.home.items);
        (s.suggestions || []).forEach(function (x) { h += '<div class="gi">• ' + esc(x.restaurant) + ' · ' + esc(ar && x.dish_ar ? x.dish_ar : x.dish) + ' <span class="q">~' + num(x.kcal) + ' kcal · ' + l('estimate', 'تقدير') + '</span>' + (t(x.ask_for) ? '<br><small>' + l('Ask for: ', 'اطلب: ') + esc(t(x.ask_for)) + '</small>' : '') + '</div>'; });
        (s.not_found || []).forEach(function (x) { h += '<div class="gi">• ' + esc(x.restaurant) + ': ' + esc(t(x.msg)) + '</div>'; });
        if (s.drinks && s.drinks.n) h += '<div class="hint">🥂 ' + esc(t(s.drinks.note)) + '</div>';
        if (t(s.tip)) h += '<div class="hint">' + esc(t(s.tip)) + '</div>';
        h += '</div>';
      });
    }
    // reminders and notes
    var rem = (P.eating_times || []).map(function (e) { return esc(slot(e.slot)) + ' ' + esc(e.time); });
    var B1 = ((P.weeks || [])[0] || {}).batch || {};
    if (B1.main) rem.push(l('Main prep', 'التحضير الأساسي') + ' ' + esc(DAYS[L][Math.max(0, DAYK.indexOf(B1.main.day))]) + ' ' + esc(B1.main.time || ''));
    if (B1.topup) rem.push(l('Top-up', 'تحضير نص الأسبوع') + ' ' + esc(DAYS[L][Math.max(0, DAYK.indexOf(B1.topup.day))]) + ' ' + esc(B1.topup.time || ''));
    rem.push(l('Water every 2 hours', 'المي كل ساعتين'), l('Weigh-in once a week, same day, before breakfast', 'الوزن مرة بالأسبوع، نفس النهار، قبل الترويقة'));
    h += '<h2>' + l('Reminders', 'التذكيرات') + '</h2><div class="card">' + rem.join(' · ') + '</div>';
    var notes = (P.notes || {})[L] || (P.notes || {}).en || [];
    if (notes.length) h += '<h2>' + l('Tips from our team', 'نصايح من فريقنا') + '</h2><ul>' + notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    h += '<p class="disc">ⓘ ' + esc(t(o.disclaimer || P.disclaimer) || l('General guidance for healthy eating, not medical treatment.', 'إرشادات عامة للأكل الصحي، مش علاج طبي.')) + '</p>';
    return { lang: L, body: '<div class="wbpdf" dir="' + (ar ? 'rtl' : 'ltr') + '" lang="' + L + '">' + h + '</div>' };
  }
  var CSS = '.wbpdf{font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Arabic",Tahoma,sans-serif;color:#1d2a26;background:#fff;padding:8px 6px;width:186mm}' +
    '.wbpdf header{border-bottom:3px solid #2f9e7e;padding-bottom:8px;margin-bottom:10px}.wbpdf .brand{font-weight:800;letter-spacing:.06em;color:#2f9e7e;text-transform:uppercase;font-size:11px}' +
    '.wbpdf h1{font-size:22px;margin:2px 0}.wbpdf .sub{color:#5c6b66}.wbpdf h2{font-size:15px;margin:14px 0 6px;color:#1f6f58}.wbpdf h2.wk{font-size:18px;border-bottom:1px solid #d7e3de;padding-bottom:4px}.wbpdf h3{font-size:13px;margin:12px 0 4px}' +
    '.wbpdf .targets{background:#eef7f3;border-radius:10px;padding:10px 12px}.wbpdf .big{font-size:24px;font-weight:800}.wbpdf .big small{font-size:12px;font-weight:500}.wbpdf .mac{margin-top:2px}' +
    '.wbpdf .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}.wbpdf .card{border:1px solid #d7e3de;border-radius:9px;padding:8px 10px;margin:0 0 8px;break-inside:avoid;page-break-inside:avoid}.wbpdf .card.pick{border-color:#2f9e7e;box-shadow:inset 0 0 0 1px #2f9e7e}' +
    '.wbpdf .card.out{border-color:#e7b45a}.wbpdf .mh{display:flex;justify-content:space-between;gap:6px;align-items:baseline}.wbpdf .tag{background:#2f9e7e;color:#fff;border-radius:6px;padding:0 6px;font-size:10px}' +
    '.wbpdf .k{color:#5c6b66;font-size:10.5px}.wbpdf .slot{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#2f9e7e;font-weight:700}.wbpdf table.it{width:100%;border-collapse:collapse;margin-top:4px}' +
    '.wbpdf table.it td{padding:2px 0;border-bottom:1px dotted #e3ece8;vertical-align:top}.wbpdf .q{color:#5c6b66;text-align:end;font-size:11px}.wbpdf .sw{margin-top:5px;color:#1f6f58;font-weight:600;font-size:11px}' +
    '.wbpdf table.grid{width:100%;border-collapse:collapse;font-size:10.5px;margin-bottom:8px;table-layout:fixed}.wbpdf table.grid th,.wbpdf table.grid td{border:1px solid #d7e3de;padding:4px;vertical-align:top}.wbpdf table.grid td.out{background:#fdf3e1}' +
    '.wbpdf .pair{break-inside:avoid;page-break-inside:avoid}.wbpdf .ph{font-weight:700;margin:6px 0 4px}.wbpdf .ph small{font-weight:400;color:#5c6b66}.wbpdf .prep ol{margin:4px 0 0 18px;padding:0}' +
    '.wbpdf .gl{border:1px solid #d7e3de;border-radius:9px;padding:6px 10px;break-inside:avoid}.wbpdf .ai{font-weight:700;margin-top:5px;font-size:11px}.wbpdf .gi{padding:1px 0}' +
    '.wbpdf .hint{color:#5c6b66;font-size:11px;margin:2px 0 6px}.wbpdf .note{background:#fff8e8;border-radius:8px;padding:6px 10px}.wbpdf .disc{color:#5c6b66;font-size:10.5px;margin-top:14px;border-top:1px solid #d7e3de;padding-top:6px}' +
    '.wbpdf .pb{break-before:page;page-break-before:always}.wbpdf ul{margin:4px 0 0 18px;padding:0}.wbpdf[dir=rtl] ul,.wbpdf[dir=rtl] .prep ol{margin:4px 18px 0 0}';
  function html(o) {
    var m = make(o);
    return '<!doctype html><html lang="' + m.lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wellbe nutrition plan</title><style>@page{size:A4;margin:12mm}body{margin:0;background:#fff}' + CSS + '</style></head><body>' + m.body + '</body></html>';
  }
  var loading = null;
  function lib() {
    if (root.html2pdf) return Promise.resolve(root.html2pdf);
    if (!loading) loading = new Promise(function (res, rej) { var s = document.createElement('script'); s.src = H2P; s.async = true; s.onload = function () { root.html2pdf ? res(root.html2pdf) : rej(new Error('PDF library missing')); }; s.onerror = function () { loading = null; rej(new Error('PDF library not loaded')); }; document.head.appendChild(s); });
    return loading;
  }
  // fallback: the print dialog of a hidden frame ("Save as PDF")
  function printIt(o) {
    return new Promise(function (res) {
      var f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'; document.body.appendChild(f);
      var d = f.contentWindow.document; d.open(); d.write(html(o)); d.close();
      setTimeout(function () { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) {} setTimeout(function () { f.remove(); }, 60000); res('print'); }, 300);
    });
  }
  function download(o) {
    var m = make(o), name = 'Wellbe-nutrition-plan' + (m.lang === 'ar' ? '-ar' : '') + '.pdf';
    return lib().then(function (h2p) {
      var box = document.createElement('div'); box.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff';
      box.innerHTML = '<style>' + CSS + '</style>' + m.body; document.body.appendChild(box);
      return h2p().set({ margin: [10, 10, 12, 10], filename: name, image: { type: 'jpeg', quality: 0.95 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'], avoid: ['.card', '.pair', '.gl'] } })
        .from(box.firstChild.nextSibling).save().then(function () { box.remove(); return 'pdf'; }, function (e) { box.remove(); throw e; });
    }).catch(function () { return printIt(o); });
  }
  var api = { html: html, download: download, css: CSS };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WBNutPdf = api;
})(typeof window !== 'undefined' ? window : globalThis);
