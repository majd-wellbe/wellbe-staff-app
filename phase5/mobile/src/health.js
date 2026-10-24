// Steps from Apple Health (iPhone) and Google Health Connect (Android) with @capgo/capacitor-health.
// Read only, steps only. The app asks once; the person can say no and keep using everything else.
// TODO(port): check the plugin's method names against the version installed (they changed between majors).
(function (w) {
  var H = w.Capacitor && w.Capacitor.Plugins && (w.Capacitor.Plugins.Health || w.Capacitor.Plugins.CapacitorHealth);
  w.WellbeHealth = {
    available: async function () { if (!H) return false; try { var a = await H.isAvailable(); return !!(a && a.available); } catch (e) { return false; } },
    ask: async function () { if (!H) return false; try { await H.requestAuthorization({ read: ['steps'] }); return true; } catch (e) { return false; } },
    stepsToday: async function () {
      if (!H) return null;
      var start = new Date(); start.setHours(0, 0, 0, 0);
      try { var r = await H.queryAggregated({ dataType: 'steps', startDate: start.toISOString(), endDate: new Date().toISOString(), bucket: 'day' });
        return (r && r.aggregatedData && r.aggregatedData[0] && Math.round(r.aggregatedData[0].value)) || 0; } catch (e) { return null; }
    }
  };
})(window);
