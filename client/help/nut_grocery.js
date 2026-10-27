/* Page: Nutrition, grocery list. pageId: nut_grocery
   Running plan: one list a week (week tabs), lunch and dinner plus your usual breakfast and snack, ticks saved per week.
   Week 1 draft: same list, ticks open after approval. Old plans: one list, ticks on the phone.
   One line per real control, verb first, under 12 words. Contract: onb-pages.md. Reference: center.js */
WBHelp.page('nut_grocery', {
  title: 'Nutrition, grocery list',
  items: [
    { sel: '[data-help="week-tabs"]', title: 'Pick a week', text: 'Tap a week to see its shopping list.' },
    { sel: '.nt-aisle', title: 'By aisle', text: 'Shop aisle by aisle, added up from your portions.', step: 'Find each item grouped by aisle, like in the store.' },
    { sel: '.nt-gi',
      title: 'Tick items',
      text: function () { var e = document.querySelector('.nt-gi'); return e && e.disabled ? 'Tick items off once your plan is approved.' : 'Tap an item to tick it off as you shop.'; },
      step: function () { var e = document.querySelector('.nt-gi'); return e && e.disabled ? 'Approve your plan first, then tick items here.' : 'Tap an item once it is in your cart.'; } },
    { sel: '.nt-gi i', title: 'How much', text: 'Check how much to buy for the whole week.', step: 'See how much to buy for the week here.' },
    { sel: '.nt-back', title: 'Full week', text: 'Go back to your full week of meals.' },
    { sel: '[data-help="lang"]', title: 'Language', text: 'Switch the list between English and Arabic.' }
  ]
});
