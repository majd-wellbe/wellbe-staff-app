/* Page: Nutrition, body and target. pageId: nut_body
   A form (no auto hints; ? and step by step still work). Same for clients and new people.
   No data-help anchors on this view: uses the stable form ids from nBody() in index.html. */
WBHelp.page('nut_body', {
  title: 'Nutrition, body and target',
  items: [
    { sel: '#nbW', title: 'Your numbers', text: 'Type your weight, height and birth year.', step: 'Type your weight in kg, then height and birth year.' },
    { sel: '[data-nsx]', title: 'Sex', text: 'Pick female or male for a more accurate plan.', step: 'Tap Female or Male.' },
    { sel: '#nbT', title: 'Target weight', text: 'Set the weight you want to reach, in kg.' },
    { sel: '#nbSave', title: 'Save', text: 'Tap Confirm and continue to save your numbers.' },
    { sel: '.nt-back', title: 'Go back', text: 'Go back to your nutrition without saving.' }
  ]
});
