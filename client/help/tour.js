/* Welcome tour: 4 steps on the home page, asked once after sign in ("Want a quick tour?").
   client = Wellbe clients (home page: Center, or Center without a package), new = people new to Wellbe (home page: Wellbe).
   Contract and copy rules: see WBHelp in client/index.html and onb-pages.md. Same rules as page files. */
WBHelp.tour('client', {
  steps: [
    { sel: '[data-help="tabs"]', title: 'Find your way', step: 'Switch between Center, My Plan, Play, Shop and Me.' },
    { sel: '[data-help="book"],[data-help="book-with-us"]', title: 'Book in seconds',
      step: function () { return document.querySelector('[data-help="book"]') ? 'Book a session here, or tap one to change it.' : 'Tap a card, ' + DESK() + ' replies with the times.'; } },
    { sel: '[data-help="package"]', title: 'Track your progress', step: 'Check sessions done and left on your package.' },
    { sel: '[data-help="habits"],[data-help="promise"]', when: function () { return !document.querySelector('[data-help="package"]'); }, title: 'Track your progress',
      step: function () { var a = ACC(); return a && a.goal ? 'Tick your 3 daily habits to build your streak.' : 'Write your promise, then tick 3 daily habits.'; } },
    { sel: '[data-help="help"]', title: 'Help anytime', step: 'Tap ? on any page for quick tips.' }
  ]
});
WBHelp.tour('new', {
  steps: [
    { sel: '[data-help="tabs"]', title: 'Find your way', step: function () { return 'Switch between Wellbe, My Plan, Play, ' + DESK() + ' and Me.'; } },
    { sel: '[data-help="trial"],[data-help="trial-booked"]', title: 'Free trial',
      step: function () { return document.querySelector('[data-help="trial"]') ? 'Book your free trial session, it takes a minute.' : 'See your free trial day and time here.'; } },
    { sel: '[data-help="ways"]', title: 'How to start', step: 'Choose a way to start: trial, coach call or package.' },
    { sel: '[data-help="help"]', title: 'Help anytime', step: 'Tap ? on any page for quick tips.' }
  ]
});
