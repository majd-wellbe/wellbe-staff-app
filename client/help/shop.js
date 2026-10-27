/* Page: Shop (clients only, new people have no Shop tab). pageId: shop
   One line per real control, verb first, under 12 words. sel uses data-help anchors from index.html.
   text = line in the "On this page" sheet. step = coach mark tooltip (defaults to text). when = optional. */
WBHelp.page('shop', {
  title: 'Shop',
  items: [
    { sel: '[data-help="brand"]', title: 'Wellbe The Brand', text: 'Tap a product to buy it on our online store.' },
    { sel: '[data-help="supplements"]', title: 'Supplements', text: 'Tap Add, then pay and pick up at your next session.', step: 'Tap Add, then use + and − to change the amount.' },
    { sel: '[data-help="fuel"]', title: 'Fuel your training', text: 'Tap a pick to see what it is and add it.' },
    { sel: '[data-help="cart"].on', title: 'Your order', text: 'Send your order, we get it ready at the center.', step: 'Tap here to check your order and send it.' },
    { sel: '[data-help="ask-supplement"]', title: 'Something else', text: 'Ask for any supplement and we will get it for you.' }
  ]
});
