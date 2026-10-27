/* Page: My Plan, Nutrition (home). pageId: plan_nut
   Before a plan: questionnaire, daily target, plan lock (coming soon, start, or subscription), draft or "being prepared" card, weigh-in.
   With a running plan (today view): today's meals, all options, full week, grocery list, reminders.
   Items not on screen are skipped and only the first 5 shown are used, so order matters. */
WBHelp.page('plan_nut', {
  title: 'My Plan, Nutrition',
  items: [
    { sel: '[data-help="questionnaire"]', title: 'Your questionnaire', text: 'Answer a few questions so your plan fits your life.', step: 'Tap Start or Continue to answer the questions.' },
    { sel: '[data-help="calc"]', title: 'Daily target', text: 'See your daily calories, macros and expected timeline.' },
    { sel: '[data-help="plan-lock"]', title: 'Your full plan',
      text: function () { return document.querySelector('[data-help="plan-lock"] a') ? 'Message ' + DESK() + ' to start your full plan.' : 'See what your 3 week plan will bring.'; },
      step: function () { return document.querySelector('[data-help="plan-lock"] a') ? 'Tap here to message ' + DESK() + ' on WhatsApp.' : 'Read what comes with the plan, coming soon.'; } },
    { sel: '[data-help="plan-draft"]', title: 'Week 1 draft', text: 'Review your week 1 draft, then approve or ask for changes.', step: 'Tap Review my week 1 to check it.' },
    { sel: '[data-help="plan-wait"]', title: 'Plan in progress', text: 'Wait here, we tell you when your plan is ready.' },
    { sel: '.rd-meal', title: 'Today’s meals', text: 'Follow today’s meals with exact portions.', step: 'Eat these portions, or open the swap line.' },
    { sel: '.rd-meal [data-nopts]', title: 'All options', text: 'Compare every option and pick your usual one.', step: 'Tap All options to see the other choices.' },
    { sel: '.nt-two [data-nv="plan"]', title: 'Full week', text: 'Open your full plan, day by day.' },
    { sel: '.nt-two [data-nv="grocery"]', title: 'Grocery list', text: 'Open your shopping list for this week.' },
    { sel: '[data-nv="rem"]', title: 'Reminders', text: 'Set reminders for meals, water, prep and weigh-ins.' },
    { sel: '[data-help="weigh-in"]', title: 'Weekly weigh-in', text: 'Log your weight once a week, same morning.', step: 'Type your weight in kg, then tap Save.' },
    { sel: '[data-help="lang"]', title: 'Language', text: 'Switch your nutrition between English and Arabic.' },
    { sel: '[data-nv="body"]', title: 'Body and target', text: 'Update your weight, height and goal weight.' }
  ]
});
