/* Page: Nutrition, full week. pageId: nut_plan
   Week 1 draft: approve or ask for changes (chips, up to 2 rounds), then the days. Running plan: 3 week tabs, 7 days,
   meals with all options and swaps, meal prep, PDF and grocery list. Old plans (Apps Script): days, swaps, grocery list.
   Items not on screen are skipped and only the first 5 shown are used, so order matters. */
WBHelp.page('nut_plan', {
  title: 'Nutrition, full week',
  items: [
    { sel: '[data-nappr]', title: 'Approve', text: 'Approve week 1 and we write all 3 weeks.', step: 'Tap Approve my plan when week 1 looks right.' },
    { sel: '.nt-rev .nt-chips', title: 'Ask for changes', text: 'Pick what to change, then tap Send my changes.', step: 'Tap the changes you want, then send them below.' },
    { sel: '[data-help="week-tabs"]', title: 'Pick a week', text: 'Tap Week 1, 2 or 3 to see that week.' },
    { sel: '[data-help="week-days"]', title: 'Pick a day', text: 'Tap a day to see its meals.', step: 'Tap any day of the week to switch.' },
    { sel: '.nt-meal [data-nopts]', title: 'All options', text: 'Compare every option and pick your usual one.', step: 'Tap All options to see the other choices.' },
    { sel: '.nt-sw',
      title: 'Swap a meal',
      text: function () { var e = document.querySelector('.nt-sw'); return e && e.tagName === 'DETAILS' ? 'Open the swap line to see another meal.' : 'Read the swap line for another meal option.'; },
      step: function () { var e = document.querySelector('.nt-sw'); return e && e.tagName === 'DETAILS' ? 'Tap Swap to see what to eat instead.' : 'Eat this swap instead if you prefer.'; } },
    { sel: '[data-npdf]', title: 'Download PDF', text: 'Save your plan as a PDF to print or share.' },
    { sel: '[data-nv="grocery"]', title: 'Grocery list', text: 'Open your shopping list for this week.' },
    { sel: '[data-help="day-totals"]', title: 'Day totals', text: 'Check the calories, protein, carbs and fat for this day.' },
    { sel: '[data-help="lang"]', title: 'Language', text: 'Switch the plan between English and Arabic.' }
  ]
});
