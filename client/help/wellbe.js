/* Page: Wellbe (home of a new person, not a client yet). pageId: wellbe
   One line per real control, verb first, under 12 words. sel uses data-help anchors from index.html.
   trial shows until the free trial is booked, trial-booked replaces it after. */
WBHelp.page('wellbe', {
  title: 'Wellbe (new to Wellbe)',
  items: [
    { sel: '[data-help="trial"]', title: 'Free trial', text: 'Book one free small group session, 60 minutes.', step: 'Tap here to pick a day and time.' },
    { sel: '[data-help="trial-booked"]', title: 'Your free trial', text: function () { return 'See your trial day and time. ' + DESK() + ' confirms on WhatsApp.'; } },
    { sel: '[data-help="nutrition"]', title: 'Nutrition', text: 'Open your nutrition plan to get your daily calories.', step: 'Tap Open to start or see your nutrition plan.' },
    { sel: '[data-help="ways"] [data-act="gcall"]', title: 'Coach call', text: 'Ask for a free 15 minute call with a coach.', step: 'Tap here to tell a coach your goal.' },
    { sel: '[data-help="all-prices"]', title: 'All prices', text: 'See every package and price. Pay at the center.' },
    { sel: '[data-help="questions"]', title: 'Questions', text: function () { return 'Message ' + DESK() + ' on WhatsApp with any question.'; } }
  ]
});
