// =====================================================================
// SUPABASE SYNC (Phase 5): the two things Supabase cannot read by itself, pushed from here.
//   sbPushCalendar()  busy times of the physio's Google Calendar for the next physioDays   (every 10 minutes)
//   sbPushBrand()     the Wellbe The Brand catalog, exactly what profBrand_() shows today      (every 6 hours)
// One time setup: Script Properties
//   SB_URL          https://lfpdcqtwwxkoxvbrlnep.supabase.co
//   SB_SYNC_SECRET  a long random text (at least 24 characters), the same one saved in Supabase app.secrets 'sync_secret'
//   SB_KEY          optional: the publishable key (the default below is the project's public key)
// Then run sbSetupTriggers() once from the editor. Nothing here changes the sheets or the apps.
// =====================================================================
var SB = {
  KEY: 'sb_publishable_DNy9ua9QayYLL4e_asTM7Q_idm7vlBW',      // public key (safe to share, the database rules decide what it can do)
  CAL_EVERY_MIN: 10, BRAND_EVERY_H: 6
};
function sbProp_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v == null || v === '' ? d : String(v); }

// one call to a Supabase function (PostgREST RPC). Throws with the database message when it refuses.
function sbRpc_(fn, body) {
  var url = String(sbProp_('SB_URL', '')).replace(/\/+$/, ''), key = sbProp_('SB_KEY', SB.KEY);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error('Set SB_URL in Script Properties (https://xxxx.supabase.co)');
  var r = UrlFetchApp.fetch(url + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', headers: { apikey: key },
    payload: JSON.stringify(body), muteHttpExceptions: true });
  var code = r.getResponseCode(), txt = r.getContentText(), j = null;
  try { j = JSON.parse(txt); } catch (e) {}
  if (code !== 200) throw new Error('Supabase ' + fn + ' ' + code + ': ' + ((j && (j.message || j.error)) || String(txt).slice(0, 200)));
  return j;
}
function sbSecret_() {
  var s = sbProp_('SB_SYNC_SECRET', '');
  if (s.length < 24) throw new Error('Set SB_SYNC_SECRET in Script Properties (at least 24 characters, same as in Supabase)');
  return s;
}

// physio calendar -> public.calendar_busy (the same window and the same calendar clSlots_ reads)
function sbPushCalendar() {
  var today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), until = appShift_(today, CL.PHYSIO_DAYS + 1);
  var cal = CalendarApp.getCalendarById(CL.CAL);
  if (!cal) { try { cal = CalendarApp.subscribeToCalendar(CL.CAL); } catch (x) {} }
  if (!cal) { Logger.log('sbPushCalendar: physio calendar not readable, nothing sent (Supabase keeps the last copy)'); return { ok: false, error: 'calendar' }; }
  var rows = cal.getEvents(beirutDate_(today, 0), beirutDate_(until, 0)).map(function (e) {
    return { id: String(e.getId()), s: e.getStartTime().getTime(), e: e.getEndTime().getTime(), allDay: !!e.isAllDayEvent() };
  });
  var out = sbRpc_('wb_sync_calendar', { secret: sbSecret_(), rows: rows });
  Logger.log('sbPushCalendar: ' + rows.length + ' events sent');
  return out;
}

// brand catalog -> public.brand_cache (an empty list keeps the last good one on the Supabase side)
function sbPushBrand() {
  var items = profBrand_();
  var out = sbRpc_('wb_sync_brand', { secret: sbSecret_(), items: items });
  Logger.log('sbPushBrand: ' + items.length + ' products sent');
  return out;
}

// run once from the editor: removes old copies of these two triggers, makes them again, sends both now
function sbSetupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction(); if (f === 'sbPushCalendar' || f === 'sbPushBrand') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sbPushCalendar').timeBased().everyMinutes(SB.CAL_EVERY_MIN).create();
  ScriptApp.newTrigger('sbPushBrand').timeBased().everyHours(SB.BRAND_EVERY_H).create();
  var a = sbPushCalendar(), b = sbPushBrand();
  Logger.log('Supabase sync ready: calendar ' + JSON.stringify(a) + ', brand ' + JSON.stringify(b));
  return { calendar: a, brand: b };
}
