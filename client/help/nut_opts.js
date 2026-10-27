/* Page: Nutrition, all options of one eating time (breakfast or snack). pageId: nut_opts
   Opened with "All options" on a meal. The usual pick is what the grocery list buys. */
WBHelp.page('nut_opts', {
  title: 'Nutrition, all options',
  items: [
    { sel: '.nt-meal', title: 'Your options', text: 'Compare the options, all matched on calories and protein.' },
    { sel: '[data-npick]', title: 'Make it usual', text: 'Tap Make this my usual to change your pick.', step: 'Tap here to make this option your usual.' },
    { sel: '.rd-chip', title: 'Your usual', text: 'See your usual pick, the one your grocery list buys.' },
    { sel: '.nt-back', title: 'Full week', text: 'Go back to your full week of meals.' },
    { sel: '[data-help="lang"]', title: 'Language', text: 'Switch the options between English and Arabic.' }
  ]
});
