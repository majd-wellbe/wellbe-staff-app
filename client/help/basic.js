/* Page: Center (client without a package). pageId: basic
   One line per real control, verb first, under 12 words. Reference: center.js */
WBHelp.page('basic', {
  title: 'Center (client without a package)',
  items: [
    { sel: '[data-help="book-with-us"]', title: 'Book with us', text: function () { return 'Tap physio, Madero or training to message ' + DESK() + ' on WhatsApp.'; }, step: function () { return 'Pick a card, ' + DESK() + ' replies with the times.'; } },
    { sel: '[data-help="promise"]', title: 'Daily habits', text: 'Tick your 3 habits each day to build your streak.', step: function () { return 'Tick all 3 for ' + (cfg('streak.days') || 30) + ' days to earn a free session.'; }, when: function () { var a = ACC(); return !!(a && a.goal); } },
    { sel: '[data-help="promise"]', title: 'Your promise', text: 'Write the promise you make to yourself.', step: 'Tap here to write your promise.', when: function () { var a = ACC(); return !(a && a.goal); } },
    { sel: '[data-help="past-packages"]', title: 'Previous packages', text: 'Check your past packages and how many sessions you did.' },
    { sel: '[data-help="invite"]', title: 'Invite a friend', text: 'Invite a friend to a free trial session.' },
    { sel: '[data-help="review"]', title: 'Review Wellbe', text: 'Leave a quick Google review to help others find us.' }
  ]
});
