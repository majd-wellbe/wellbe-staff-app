// Local reminders on the phone (no server, free): 8 water reminders, a midday "move more" nudge, the 10:00 quote.
// Loaded by the client app only inside the native app: if (window.Capacitor) WellbeReminders.plan(...)
// Times follow the client's own settings in the app (each water time can be turned off or moved).
(function (w) {
  var LN = w.Capacitor && w.Capacitor.Plugins && w.Capacitor.Plugins.LocalNotifications;
  var WATER = ['08:00', '09:30', '11:00', '12:30', '14:00', '15:30', '17:00', '19:00'];   // default 8 times, editable in the app
  function at(hm) { var p = hm.split(':'); return { hour: +p[0], minute: +p[1] }; }
  w.WellbeReminders = {
    // opts: { water: ['08:00', ...] (only the ones turned on), move: '13:00' or null, quote: '10:00' or null, quoteText: 'today's quote' }
    plan: async function (opts) {
      if (!LN) return false;
      var perm = await LN.requestPermissions(); if (perm.display !== 'granted') return false;
      var pending = await LN.getPending(); if (pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map(function (n) { return { id: n.id }; }) });
      var list = [], id = 100;
      (opts.water || WATER).forEach(function (hm, i) { list.push({ id: id++, title: 'Water ' + (i + 1) + ' of 8', body: 'A glass now. Tap to tick it in Wellbe.', schedule: { on: at(hm), repeats: true }, extra: { tick: 'water', n: i } }); });
      if (opts.move) list.push({ id: 200, title: 'Move a little', body: 'Under half your steps so far. A 10 minute walk does it.', schedule: { on: at(opts.move), repeats: true }, extra: { tick: 'move' } });
      if (opts.quote) list.push({ id: 300, title: 'Quote of the day', body: opts.quoteText || 'Open Wellbe for today\'s quote.', schedule: { on: at(opts.quote), repeats: true } });
      await LN.schedule({ notifications: list });
      return true;
    }
  };
})(window);
