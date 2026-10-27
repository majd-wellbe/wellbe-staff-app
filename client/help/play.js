/* Page: Play (Corniche Run lobby). pageId: play
   One line per real control, verb first, under 12 words. sel uses data-help anchors from index.html.
   Missions, leaderboard, credit and power up show only after the game data loads (skipped until then).
   Wellbe Credit is used on a next package or online workout, so it is shown to clients; new people get the leaderboard instead. */
WBHelp.page('play', {
  title: 'Play',
  items: [
    { sel: '[data-help="run"]', title: 'Start a run', text: 'Run the Corniche, dodge obstacles and collect coins.', step: 'Tap here to start running.' },
    { sel: '[data-help="runner"]', title: 'Your runner', text: 'Pick and style the runner you play as.' },
    { sel: '[data-help="missions"]', title: 'Today’s missions', text: 'Finish all 3 missions today for bonus coins.', step: 'Fill these bars as you run today.' },
    { sel: '[data-help="leaderboard"]', title: 'Leaderboard', text: 'Switch Today, Week or All time to see the top runners.', when: function () { return !!D.guest; } },
    { sel: '[data-help="credit"]', title: 'Wellbe Credit', text: 'Earn credit on long runs, use it on your next package.', when: function () { return !D.guest; } },
    { sel: '[data-help="power-up"]', title: 'Power up', text: 'Spend coins on Super Powers and check your Badges.' }
  ]
});
