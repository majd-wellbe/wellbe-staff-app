/* Page: Nutrition, reminders. pageId: nut_rem
   A form (no auto hints; ? and step by step still work). Shown while the 3 week plan runs; phone notifications come later. */
WBHelp.page('nut_rem', {
  title: 'Nutrition, reminders',
  items: [
    { sel: '#nrMeal', title: 'Meal times', text: 'Turn meal reminders on and set each time.', step: 'Switch it on, then change any meal time below.' },
    { sel: '[data-nrw]', title: 'Water', text: 'Pick how often to be reminded to drink water.' },
    { sel: '#nrPrep', title: 'Meal prep', text: 'Set the day and time of your main prep.' },
    { sel: '#nrSave', title: 'Save', text: 'Tap Save my reminders to keep your schedule.' },
    { sel: '[data-nrs]', title: 'Snooze', text: 'Snooze reminders for 1 hour, or mute them all.' }
  ]
});
