/* Page: My Plan, Workouts. pageId: plan_wo
   Clients: next workout, save weights (session day only), past workouts, phase. New people: coach builds your plan.
   Items not on screen are skipped; the first 5 shown are used, in this order. */
WBHelp.page('plan_wo', {
  title: 'My Plan, Workouts',
  items: [
    { sel: '[data-help="workout"]', title: 'Your next workout', text: 'See the exercises your coach set for your next session.', step: 'Follow these exercises, sets and reps at your session.' },
    { sel: '[data-help="save-weights"]', title: 'Save your weights', text: 'Type your kg and reps, then save them today.', step: 'Tap here to save the weights you lifted today.' },
    { sel: '[data-help="no-workout"]', title: 'No workout yet', text: 'Wait for your coach to build your program here.' },
    { sel: '[data-help="coach-builds"]', title: 'Your program', text: function () { return D.guest && D.guest.trial ? 'Come to your free trial, then your program shows here.' : 'Book your free trial so your coach builds your program.'; }, step: function () { return D.guest && D.guest.trial ? 'Your program shows here after your first session.' : 'Tap Book my free trial to get started.'; } },
    { sel: '[data-help="past-workouts"]', title: 'Past workouts', text: 'Tap a session from the last 7 days to log it.' },
    { sel: '[data-help="phase"]', title: 'Your phase', text: 'Check your current phase and the workouts in it.' },
    { sel: '[data-help="body-numbers"]', title: 'Your body numbers', text: 'Tap Edit to update your weight, height and goal.', step: 'Tap Edit when your weight changes, your coach uses it.' },
    { sel: '[data-help="plan-tabs"]', title: 'Workouts and Nutrition', text: 'Switch between your workouts and your nutrition plan.' }
  ]
});
