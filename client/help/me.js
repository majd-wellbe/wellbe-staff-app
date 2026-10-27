/* Page: Me (tap the avatar). pageId: me
   One line per real control, verb first, under 12 words. sel uses data-help anchors from index.html.
   Clients see My sessions; new people have none, so they get the promise line instead. */
WBHelp.page('me', {
  title: 'Me',
  items: [
    { sel: '[data-help="profile-steps"]', title: 'Complete your profile',
      text: function () { return document.querySelector('.pf-done') ? 'Tap Edit to look over your profile steps again.' : 'Tap a step to finish it and complete your profile.'; },
      step: function () { return document.querySelector('.pf-done') ? 'Tap Edit to see your profile steps.' : 'Tap any step here to do it now.'; } },
    { sel: '[data-help="photo"]', title: 'Your photo', text: 'Tap your photo to add or change it.' },
    { sel: '[data-help="my-sessions"]', title: 'My sessions', text: 'Check your booked and past sessions here.', when: function () { return !D.guest; } },
    { sel: '[data-help="promise"]', title: 'My promise', text: 'Write or change the promise you make yourself.', when: function () { return !!D.guest; } },
    { sel: '[data-help="help-settings"]', title: 'Help', text: 'Turn tips on or off, or replay the welcome tour.' },
    { sel: '[data-help="settings"]', title: 'Settings', text: 'Change app color, hide from leaderboards, or sign out.' }
  ]
});
