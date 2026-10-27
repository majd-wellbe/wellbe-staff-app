/* REFERENCE PAGE FILE. Page: Center (home of a Wellbe client with a package). pageId: center
   One line per real control, verb first, under 12 words. sel uses data-help anchors from index.html.
   text = line in the "On this page" sheet. step = coach mark tooltip (defaults to text). when = optional. */
WBHelp.page('center', {
  title: 'Center',
  items: [
    { sel: '[data-help="book"]', title: 'Book a session', text: function () { return 'Pick a day and time, ' + DESK() + ' confirms it.'; }, step: 'Tap here to ask for a new session time.' },
    { sel: '[data-help="sessions"]', title: 'Your sessions', text: 'Tap a session to cancel it or move it.' },
    { sel: '[data-help="habits"]', title: 'Daily habits', text: 'Tick your 3 habits each day to build your streak.' },
    { sel: '[data-help="package"]', title: 'Your package', text: 'Check how many sessions are done and left.' },
    { sel: '[data-help="nutrition"]', title: 'Nutrition', text: 'Open your nutrition plan, meals and water.', when: function () { return !document.querySelector('[data-help="package"]'); } },
    { sel: '[data-help="invite"]', title: 'Invite a friend', text: 'Invite a friend to a free trial session.' }
  ]
});
