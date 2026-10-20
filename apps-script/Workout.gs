// =====================================================================
// WORKOUTS: each client has their own program (phases > workouts),
// built by their trainers. Workouts follow the client's training sessions
// in order (W1, W2, W3, W1...). A missed session (late cancel / no show)
// keeps the plan; the trainer is asked if the next session should do the
// missed workout instead.
// Tabs: WORKOUT PROGRAMS, WORKOUT DECISIONS, WORKOUT LOG, CLIENT BODY, EXERCISES
// Staff actions (App.gs router): app_wo_list, app_wo_get, app_wo_save, app_wo_decide, app_wo_log, app_wo_ex
// Client action (Client.gs router): app_cl_wo  op: get | log | body
// The routers hold the script lock for writes. app_wo_list and app_wo_get only read: no lock, no cache reset.
// app_wo_list with full:1 also returns every visible client's program page, so the staff app opens any client instantly.
// =====================================================================
var WO = {
  PROG_HEAD: ['Client ID', 'Client', 'Program (JSON)', 'Updated', 'By', 'Version'],
  DEC_HEAD: ['Session ID', 'Client ID', 'Choice', 'Missed workout', 'Decided by', 'At'],
  LOG_HEAD: ['Logged at', 'Date', 'Client ID', 'Client', 'Session ID', 'Workout', 'Exercise', 'Sets (kg x reps)', 'By'],
  BODY_HEAD: ['Date', 'Client ID', 'Client', 'Weight (kg)', 'Height (cm)', 'Birth year', 'Sex', 'By'],
  EX_HEAD: ['Group', 'Exercise', 'Added by', 'Date'],
  TABS: { '1:1': 1, '1:2': 1, '1:3': 1 },        // training sessions only (not physio, osteo, madero)
  SEE_DAYS: 60, AHEAD: 35, CLIENT_LOG_DAYS: 7,
  LIB: {
    'Warm up': ['Jumping jacks', 'Bike', 'Rower', 'Treadmill walk', 'Arm circles', 'Leg swings', 'Hip circles', 'Cat cow', "World's greatest stretch", 'Inchworm', 'Glute bridge', 'Band pull apart', 'Bodyweight squat', 'Walking lunge', 'Thoracic rotation', 'Dead bug'],
    'Chest': ['Barbell bench press', 'Dumbbell bench press', 'Incline dumbbell press', 'Incline barbell press', 'Decline press', 'Machine chest press', 'Push up', 'Incline push up', 'Dumbbell fly', 'Cable fly', 'Pec deck', 'Dips (chest)'],
    'Back': ['Pull up', 'Assisted pull up', 'Lat pulldown', 'Close grip pulldown', 'Seated cable row', 'Bent over barbell row', 'One arm dumbbell row', 'Chest supported row', 'T bar row', 'Inverted row', 'Straight arm pulldown', 'Face pull', 'Back extension', 'Deadlift'],
    'Shoulders': ['Overhead barbell press', 'Seated dumbbell press', 'Arnold press', 'Landmine press', 'Lateral raise', 'Cable lateral raise', 'Front raise', 'Rear delt fly', 'Reverse pec deck', 'Upright row', 'Shrugs'],
    'Biceps': ['Barbell curl', 'Dumbbell curl', 'Hammer curl', 'Incline dumbbell curl', 'Preacher curl', 'Cable curl', 'Concentration curl'],
    'Triceps': ['Triceps pushdown', 'Overhead cable extension', 'Skull crusher', 'Close grip bench press', 'Dips (triceps)', 'Bench dips', 'Kickback'],
    'Quads': ['Back squat', 'Front squat', 'Goblet squat', 'Leg press', 'Hack squat', 'Bulgarian split squat', 'Reverse lunge', 'Walking lunge (loaded)', 'Step up', 'Leg extension', 'Wall sit', 'Sissy squat'],
    'Hamstrings': ['Romanian deadlift', 'Single leg RDL', 'Lying leg curl', 'Seated leg curl', 'Nordic curl', 'Good morning', 'Swiss ball leg curl', 'Kettlebell swing'],
    'Glutes': ['Hip thrust', 'Barbell glute bridge', 'Single leg hip thrust', 'Cable kickback', 'Hip abduction machine', 'Banded lateral walk', 'Sumo deadlift', 'Frog pump', 'Clamshell'],
    'Calves': ['Standing calf raise', 'Seated calf raise', 'Single leg calf raise', 'Tibialis raise'],
    'Abs': ['Plank', 'Side plank', 'Dead bug', 'Bird dog', 'Hollow hold', 'Crunch', 'Reverse crunch', 'Hanging knee raise', 'Hanging leg raise', 'Cable crunch', 'Pallof press', 'Russian twist', 'Ab wheel rollout', 'Mountain climbers', 'Bicycle crunch', 'Farmer carry', 'Suitcase carry'],
    'Conditioning': ['Burpees', 'Battle ropes', 'Sled push', 'Box jump', 'Jump squat', 'Skipping', 'Assault bike sprint', 'Rower sprint', 'Thrusters', 'Wall balls', 'Kettlebell clean'],
    'Stretching': ['Hamstring stretch', 'Quad stretch', 'Hip flexor stretch', 'Pigeon stretch', 'Glute stretch (figure 4)', 'Adductor stretch', 'Calf stretch', 'Chest doorway stretch', 'Lat stretch', 'Child pose', 'Cobra', 'Thread the needle', 'Neck stretch', 'Triceps stretch', 'Shoulder cross body stretch', '90/90 hip switch']
  }
};

// ---------------------------------------------------------------------
// shared reading
// ---------------------------------------------------------------------
function woTab_(ops, name, head) { return appTab_(ops, name, head); }
function woProgs_(ops) {
  var sh = woTab_(ops, 'WORKOUT PROGRAMS', WO.PROG_HEAD), n = sh.getLastRow(), out = {};
  if (n < 2) return out;
  sh.getRange(2, 1, n - 1, WO.PROG_HEAD.length).getValues().forEach(function (r, i) {
    var cid = String(r[0]).trim().toUpperCase(); if (!cid) return;
    var p = null; try { p = JSON.parse(r[2] || 'null'); } catch (e) {}
    out[cid] = { row: i + 2, prog: p, updated: String(r[3]), by: String(r[4]), ver: Number(r[5]) || 0 };
  });
  return out;
}
function woDecisions_(ops) {
  var sh = woTab_(ops, 'WORKOUT DECISIONS', WO.DEC_HEAD), n = sh.getLastRow(), out = {};
  if (n < 2) return out;
  sh.getRange(2, 1, n - 1, 3).getValues().forEach(function (r) { if (r[0]) out[String(r[0]) + '|' + String(r[1]).toUpperCase()] = String(r[2]); });
  return out;
}
// packages and client names change rarely: kept 3 minutes in the script cache so opening a program is fast
function woCached_(key, build) {
  var c = CacheService.getScriptCache(), hit = c.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var out = build();
  try { c.put(key, JSON.stringify(out), 180); } catch (e) {}   // too big for the cache: just not cached
  return out;
}
function woPkgCid_(ops) {
  return woCached_('wo_pkgcid', function () {
    var v = ops.getSheetByName('PACKAGES').getDataRange().getValues(), out = {};
    for (var i = 2; i < v.length; i++) if (v[i][0]) out[String(v[i][0]).trim()] = String(v[i][1] || '').trim().toUpperCase();
    return out;
  });
}
function woNames_() {
  return woCached_('wo_names', function () {
    var v = SpreadsheetApp.openById(CFG.CLIENTS_ID).getSheetByName(CFG.CLIENTS_TAB).getDataRange().getDisplayValues(), out = {};
    for (var i = 1; i < v.length; i++) { var id = String(v[i][0] || '').trim().toUpperCase(); if (/^C\d+$/.test(id)) out[id] = String(v[i][1] || '').trim(); }
    return out;
  });
}
// training sessions per client: { cid: [ {sid, date, start, trainer, att, status} ] } sorted by time
function woSessByClient_(ops, from, to, pc) {
  var by = {};
  appSessions_(ops, from, to, null).forEach(function (s) {
    if (!WO.TABS[s.tab]) return;
    s.clients.forEach(function (c) {
      var cid = pc[c.pkg]; if (!cid) return;
      (by[cid] = by[cid] || []).push({ sid: s.id, date: s.date, start: s.start, trainer: s.trainer, att: c.att || '', status: s.status });
    });
  });
  Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return (a.date + a.start) < (b.date + b.start) ? -1 : 1; }); });
  return by;
}
// trainers see clients they trained in the last 60 days or have booked; owner and Romy see everyone
function woCanSee_(me, list, today) {
  if (me.role !== 'trainer') return true;
  var from = appShift_(today, -WO.SEE_DAYS);
  return (list || []).some(function (s) { return s.trainer === me.trainer && s.date >= from && s.status !== 'Cancelled'; });
}

// ---------------------------------------------------------------------
// phases and the session schedule
// ---------------------------------------------------------------------
function woAddLen_(ymd, n, u) {
  var d = new Date(ymd + 'T12:00:00Z');
  if (u === 'm') d.setUTCMonth(d.getUTCMonth() + n); else d.setUTCDate(d.getUTCDate() + n * (u === 'w' ? 7 : 1));
  return d.toISOString().slice(0, 10);
}
function woPhases_(prog) {
  var s = prog.start, out = [];
  (prog.phases || []).forEach(function (p, i) {
    var e = woAddLen_(s, Math.max(1, Number(p.len) || 1), p.unit);
    out.push({ i: i, name: p.name || ('Phase ' + (i + 1)), start: s, end: appShift_(e, -1), len: p.len, unit: p.unit, workouts: p.workouts || [] });
    s = e;
  });
  return out;
}
// replays the client's sessions since the program started:
//  attended or upcoming -> next workout in order; late cancel / no show -> that workout is missed, plan kept;
//  the next session after a miss asks the trainer: do the missed workout instead (catch), or keep the plan (keep)
function woPlan_(prog, list, dec, cid, today) {
  var ph = woPhases_(prog), cur = -1, ptr = 0, miss = null, items = [], asks = [];
  (list || []).forEach(function (s) {
    if (s.status === 'Cancelled' || /early/i.test(s.att)) return;            // rebooked, not a workout day
    var pi = -1; for (var k = 0; k < ph.length; k++) if (s.date >= ph[k].start && s.date <= ph[k].end) { pi = k; break; }
    if (pi < 0) return;
    if (pi !== cur) { cur = pi; ptr = 0; miss = null; }
    var n = ph[pi].workouts.length; if (!n) return;
    var missed = /late cancel|no show/i.test(s.att), choice = dec[s.sid + '|' + cid] || '', w, catchUp = false;
    if (miss && !missed && choice === 'catch') { w = miss.w; catchUp = true; miss = null; }
    else {
      if (miss && !missed && !choice && s.date >= today && !s.att) asks.push({ sid: s.sid, date: s.date, start: s.start, missed: { w: miss.w, name: woWName_(ph[pi], miss.w), date: miss.date }, now: { w: ptr % n, name: woWName_(ph[pi], ptr % n) } });
      if (!missed) miss = null;
      w = ptr % n; ptr++;
    }
    if (missed) miss = { w: w, date: s.date };
    var state = missed ? 'missed' : (s.att || s.date < today) ? 'done' : (s.date === today ? 'today' : 'planned');
    items.push({ sid: s.sid, date: s.date, start: s.start, trainer: s.trainer, phase: pi, w: w, name: woWName_(ph[pi], w), state: state, catchUp: catchUp });
  });
  return { phases: ph, items: items, asks: asks };
}
function woWName_(p, w) { var x = p.workouts[w]; return (x && x.name) || ('Workout ' + (w + 1)); }
function woCurPhase_(ph, today) { for (var i = 0; i < ph.length; i++) if (today >= ph[i].start && today <= ph[i].end) return i; return today < (ph[0] || {}).start ? 0 : -1; }

// ---------------------------------------------------------------------
// logs and body
// ---------------------------------------------------------------------
// latest log per session+exercise for one client: [{date, sid, ex, sets, by}] newest first
function woLogsOf_(ops, cid) { return woLogsAll_(ops)[cid] || []; }
// every client's logs in one read: { cid: [ {date, sid, w, ex, sets, by} ] } newest first, one entry per session and exercise
function woLogsAll_(ops) {
  var sh = woTab_(ops, 'WORKOUT LOG', WO.LOG_HEAD), n = sh.getLastRow(), all = {}; if (n < 2) return all;
  var v = sh.getRange(2, 1, n - 1, WO.LOG_HEAD.length).getValues(), seen = {};
  for (var i = v.length - 1; i >= 0; i--) {
    var r = v[i], cid = String(r[2]).toUpperCase(); if (!cid) continue;
    var k = cid + '|' + String(r[4]) + '|' + String(r[6]); if (seen[k]) continue; seen[k] = 1;
    (all[cid] = all[cid] || []).push({ date: appYmd_(r[1]), sid: String(r[4]), w: String(r[5]), ex: String(r[6]), sets: String(r[7]).replace(/^'/, ''), by: String(r[8]) });
  }
  Object.keys(all).forEach(function (c) { all[c].sort(function (a, b) { return a.date < b.date ? 1 : -1; }); });
  return all;
}
// { exercise: { last: '60x10, 60x8', date, history: [{date, top, sets}] } }
function woLogMap_(logs) {
  var m = {};
  logs.forEach(function (l) {
    if (!l.sets) return;
    var x = m[l.ex] = m[l.ex] || { last: l.sets, date: l.date, history: [] };
    if (x.history.length < 12) x.history.push({ date: l.date, sets: l.sets, top: woTop_(l.sets) });
  });
  return m;
}
function woTop_(sets) { var t = 0; String(sets).split(',').forEach(function (s) { var k = parseFloat(s); if (k > t) t = k; }); return t; }
function woSets_(sets) {
  return (sets || []).slice(0, 10).map(function (x) {
    var kg = Math.max(0, Math.min(500, Math.round((Number(x.kg) || 0) * 4) / 4)), reps = Math.max(0, Math.min(200, Math.round(Number(x.reps) || 0)));
    return kg + 'x' + reps;
  }).filter(function (s) { return s !== '0x0'; }).join(', ');
}
function woWriteLogs_(ops, cid, name, sid, date, wname, entries, by) {
  var sh = woTab_(ops, 'WORKOUT LOG', WO.LOG_HEAD), now = Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), rows = [];
  (entries || []).slice(0, 40).forEach(function (e) {
    var ex = clean_(e.ex, 80); if (!ex) return;
    rows.push([now, beirutDate_(date, 0), cid, name, clean_(sid, 20), clean_(wname, 60), ex, "'" + woSets_(e.sets), by]);
  });
  if (!rows.length) throw new Error('Nothing to save');
  var r0 = sh.getLastRow() + 1;
  sh.getRange(r0, 1, rows.length, WO.LOG_HEAD.length).setValues(rows);
  sh.getRange(r0, 2, rows.length, 1).setNumberFormat('dd/MM/yyyy');
  return rows.length;
}
function woBody_(ops, cid) { return woBodies_(ops)[cid] || woNoBody_(); }
function woNoBody_() { return { weight: 0, height: 0, birth: 0, sex: '', date: '', history: [] }; }
// every client's body entries in one read: { cid: {weight, height, birth, sex, date, history} }
function woBodies_(ops) {
  var sh = woTab_(ops, 'CLIENT BODY', WO.BODY_HEAD), n = sh.getLastRow(), all = {};
  if (n < 2) return all;
  sh.getRange(2, 1, n - 1, WO.BODY_HEAD.length).getValues().forEach(function (r) {
    var cid = String(r[1]).toUpperCase(); if (!cid) return;
    var b = all[cid] = all[cid] || woNoBody_();
    if (Number(r[3])) { b.weight = Number(r[3]); b.date = appYmd_(r[0]); b.history.push({ date: appYmd_(r[0]), kg: Number(r[3]) }); }
    if (Number(r[4])) b.height = Number(r[4]);
    if (Number(r[5])) b.birth = Number(r[5]);
    if (r[6]) b.sex = String(r[6]);
  });
  Object.keys(all).forEach(function (c) { all[c].history = all[c].history.slice(-20); });
  return all;
}
// Mifflin St Jeor; daily calories = BMR x activity from training sessions per week
function woBmr_(b, perWeek) {
  if (!b.weight || !b.height || !b.birth || !b.sex) return null;
  var age = Number(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy')) - b.birth;
  var bmr = Math.round(10 * b.weight + 6.25 * b.height - 5 * age + (b.sex === 'M' ? 5 : -161));
  var f = perWeek >= 5 ? 1.55 : perWeek >= 2 ? 1.465 : perWeek >= 1 ? 1.375 : 1.2;
  return { bmr: bmr, daily: Math.round(bmr * f), perWeek: Math.round(perWeek * 10) / 10, age: age };
}
function woPerWeek_(list, today) {
  var from = appShift_(today, -28);
  return (list || []).filter(function (s) { return s.date >= from && s.date <= today && /present|done/i.test(s.att || 'present') && s.status !== 'Cancelled' && !/cancel|no show/i.test(s.att); }).length / 4;
}
function woLib_(ops) {
  var lib = {}; Object.keys(WO.LIB).forEach(function (g) { lib[g] = WO.LIB[g].slice(); });
  var sh = woTab_(ops, 'EXERCISES', WO.EX_HEAD), n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, 2).getValues().forEach(function (r) {
    var g = String(r[0]).trim(), e = String(r[1]).trim(); if (!g || !e) return;
    (lib[g] = lib[g] || []); if (lib[g].indexOf(e) < 0) lib[g].push(e);
  });
  return lib;
}

// ---------------------------------------------------------------------
// program check: keeps only known fields and sane sizes
// ---------------------------------------------------------------------
function woClean_(p) {
  if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.start))) throw new Error('Pick the start date of the program');
  var T = function (v, n) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, n); };
  var mv = function (m, sets) { var o = { ex: T(m.ex, 80), reps: T(m.reps, 30), det: T(m.det, 200) }; if (sets) o.sets = T(m.sets, 10); return o; };
  var phases = (p.phases || []).slice(0, 20).map(function (ph, i) {
    var unit = ['d', 'w', 'm'].indexOf(ph.unit) > -1 ? ph.unit : 'w', len = Math.max(1, Math.min(unit === 'm' ? 24 : unit === 'w' ? 104 : 365, Math.round(Number(ph.len) || 1)));
    return { name: T(ph.name, 60) || ('Phase ' + (i + 1)), len: len, unit: unit, note: T(ph.note, 200),
      workouts: (ph.workouts || []).slice(0, 10).map(function (w, j) {
        return { name: T(w.name, 60) || ('Workout ' + (j + 1)),
          warm: (w.warm || []).slice(0, 30).map(function (m) { return mv(m); }).filter(function (m) { return m.ex; }),
          main: (w.main || []).slice(0, 30).map(function (b) {
            var type = ['single', 'superset', 'circuit'].indexOf(b.type) > -1 ? b.type : 'single', max = type === 'single' ? 1 : type === 'superset' ? 3 : 10;
            return { type: type, rounds: T(b.rounds, 10), rest: T(b.rest, 20), moves: (b.moves || []).slice(0, max).map(function (m) { return mv(m, true); }).filter(function (m) { return m.ex; }) };
          }).filter(function (b) { return b.moves.length; }),
          abs: (w.abs || []).slice(0, 20).map(function (m) { return mv(m, true); }).filter(function (m) { return m.ex; }),
          stretch: (w.stretch || []).slice(0, 20).map(function (m) { return { ex: T(m.ex, 80), det: T(m.det, 200) }; }).filter(function (m) { return m.ex; })
        };
      })
    };
  });
  if (!phases.length) throw new Error('Add at least one phase');
  return { start: String(p.start), goal: T(p.goal, 200), phases: phases };
}

// ---------------------------------------------------------------------
// STAFF ACTIONS
// ---------------------------------------------------------------------
// my clients: who has a program, who needs an answer, next workout
function woList_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  var progs = woProgs_(ops), dec = woDecisions_(ops), names = woNames_(), pc = woPkgCid_(ops);
  var from = appShift_(today, -WO.SEE_DAYS);
  Object.keys(progs).forEach(function (k) { var p = progs[k].prog; if (p && p.start && p.start < from) from = p.start; });
  if (from < appShift_(today, -400)) from = appShift_(today, -400);
  var by = woSessByClient_(ops, from, appShift_(today, WO.AHEAD), pc), out = [];
  var ids = {}; Object.keys(by).forEach(function (k) { ids[k] = 1; }); Object.keys(progs).forEach(function (k) { ids[k] = 1; });
  var full = b && b.full ? {} : null, bodies = full ? woBodies_(ops) : null, logs = full ? woLogsAll_(ops) : null;
  Object.keys(ids).forEach(function (cid) {
    var list = by[cid] || [], plan = null;
    if (!woCanSee_(me, list, today)) return;
    var recent = list.some(function (s) { return s.date >= appShift_(today, -WO.SEE_DAYS); });
    var pr = progs[cid], row = { cid: cid, name: names[cid] || cid, has: !!(pr && pr.prog), asks: 0, next: null, phase: '' };
    if (!recent && !row.has) return;
    if (row.has) {
      plan = woPlan_(pr.prog, list, dec, cid, today); var ci = woCurPhase_(plan.phases, today);
      row.asks = plan.asks.length; row.phase = ci > -1 ? plan.phases[ci].name : (today > plan.phases[plan.phases.length - 1].end ? 'Program ended' : '');
      row.ended = ci < 0 && today > plan.phases[plan.phases.length - 1].end;
      var nx = plan.items.filter(function (x) { return x.date >= today && (x.state === 'today' || x.state === 'planned'); })[0];
      if (nx) row.next = { date: nx.date, start: nx.start, name: nx.name };
      row.by = pr.by; row.updated = pr.updated;
    }
    if (full) full[cid] = woDetail_(cid, row.name, pr, list, plan, today, bodies, logs);
    var mine = list.filter(function (s) { return s.date >= appShift_(today, -WO.SEE_DAYS); });
    row.trainers = mine.map(function (s) { return s.trainer; }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
    out.push(row);
  });
  out.sort(function (a, b) { return (b.asks - a.asks) || (a.has === b.has ? (a.name < b.name ? -1 : 1) : (a.has ? 1 : -1)); });
  return { clients: out, lib: woLib_(ops), today: today, full: full };
}

// one client: program, schedule, questions, logs, body
function woGet_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), cid = String(b.cid || '').toUpperCase();
  var progs = woProgs_(ops), pr = progs[cid], pc = woPkgCid_(ops);
  var from = pr && pr.prog && pr.prog.start < appShift_(today, -WO.SEE_DAYS) ? pr.prog.start : appShift_(today, -WO.SEE_DAYS);
  var list = (woSessByClient_(ops, from, appShift_(today, WO.AHEAD), pc)[cid]) || [];
  if (!woCanSee_(me, list, today) && !(pr && b.copy)) throw new Error('This client is not one of yours');
  var out = { cid: cid, name: (woNames_()[cid] || cid), today: today, prog: pr ? pr.prog : null, ver: pr ? pr.ver : 0, by: pr ? pr.by : '', updated: pr ? pr.updated : '' };
  if (b.copy) return out;                                  // copying another client's program: the program only
  var plan = pr && pr.prog ? woPlan_(pr.prog, list, woDecisions_(ops), cid, today) : null;
  var bodies = {}, logs = {}; bodies[cid] = woBody_(ops, cid); logs[cid] = woLogsOf_(ops, cid);
  return woDetail_(cid, out.name, pr, list, plan, today, bodies, logs);
}
// one client's program page: program, schedule, questions, body, logs
function woDetail_(cid, name, pr, list, plan, today, bodies, logs) {
  var out = { cid: cid, name: name, today: today, prog: pr ? pr.prog : null, ver: pr ? pr.ver : 0, by: pr ? pr.by : '', updated: pr ? pr.updated : '' };
  if (plan) {
    out.phases = plan.phases.map(function (p) { return { name: p.name, start: p.start, end: p.end }; });
    out.items = plan.items.filter(function (x) { return x.date >= appShift_(today, -30); });
    out.asks = plan.asks;
  }
  var body = bodies[cid] || woNoBody_();
  out.body = body; out.bmr = woBmr_(body, woPerWeek_(list, today));
  out.logs = woLogMap_(logs[cid] || []);
  return out;
}

function woSave_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), cid = String(b.cid || '').toUpperCase();
  if (!/^C\d+$/.test(cid)) throw new Error('Client missing');
  if (me.role === 'trainer') {
    var list = (woSessByClient_(ops, appShift_(today, -WO.SEE_DAYS), appShift_(today, WO.AHEAD), woPkgCid_(ops))[cid]) || [];
    if (!woCanSee_(me, list, today)) throw new Error('This client is not one of yours');
  }
  var progs = woProgs_(ops), pr = progs[cid], sh = woTab_(ops, 'WORKOUT PROGRAMS', WO.PROG_HEAD);
  if (pr && Number(b.ver || 0) !== pr.ver) throw new Error((pr.by || 'Someone') + ' changed this program at ' + pr.updated + '. Reload it, then make your change again.');
  if (b.remove) { if (pr) sh.deleteRow(pr.row); return { ver: 0 }; }
  var prog = woClean_(b.prog), txt = JSON.stringify(prog);
  if (txt.length > 48000) throw new Error('This program is too long. Split it, or remove some notes.');
  var row = [cid, (woNames_()[cid] || cid), txt, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'), me.name, (pr ? pr.ver : 0) + 1];
  if (pr) sh.getRange(pr.row, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
  return { ver: row[5], prog: prog };
}

// after a miss: 'catch' = this session does the missed workout, 'keep' = plan stays
function woDecide_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid || '').toUpperCase(), choice = b.choice === 'catch' ? 'catch' : 'keep';
  if (!b.sid) throw new Error('Session missing');
  var sh = woTab_(ops, 'WORKOUT DECISIONS', WO.DEC_HEAD), n = sh.getLastRow();
  var row = [String(b.sid), cid, choice, clean_(b.missed, 60), me.name, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm')];
  if (n > 1) {
    var v = sh.getRange(2, 1, n - 1, 2).getValues();
    for (var i = 0; i < v.length; i++) if (String(v[i][0]) === row[0] && String(v[i][1]).toUpperCase() === cid) { sh.getRange(i + 2, 1, 1, row.length).setValues([row]); return { choice: choice }; }
  }
  sh.appendRow(row);
  return { choice: choice };
}

function woLog_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid || '').toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) throw new Error('Date missing');
  var n = woWriteLogs_(ops, cid, clean_(b.name, 80), b.sid, b.date, b.wname, b.entries, me.trainer || me.name);
  return { saved: n, logs: woLogMap_(woLogsOf_(ops, cid)) };
}

function woEx_(b, me) {
  var g = clean_(b.group, 40), e = clean_(b.name, 80);
  if (!g || !e) throw new Error('Group and exercise name needed');
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), lib = woLib_(ops);
  if ((lib[g] || []).some(function (x) { return x.toLowerCase() === e.toLowerCase(); })) return { lib: lib };
  woTab_(ops, 'EXERCISES', WO.EX_HEAD).appendRow([g, e, me.name, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy')]);
  return { lib: woLib_(ops) };
}

// ---------------------------------------------------------------------
// CLIENT ACTION: app_cl_wo  op: get | log | body
// ---------------------------------------------------------------------
function clWo_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), op = String(b.op || 'get');
  if (op === 'body') {
    var w = Number(b.weight) || 0, h = Number(b.height) || 0, y = Number(b.birth) || 0, sx = b.sex === 'M' || b.sex === 'F' ? b.sex : '';
    var yr = Number(today.slice(0, 4));
    if (w && (w < 25 || w > 300)) throw new Error('Check your weight (kg)');
    if (h && (h < 100 || h > 230)) throw new Error('Check your height (cm)');
    if (y && (y < 1920 || y > yr - 10)) throw new Error('Check your birth year');
    if (!w && !h && !y && !sx) throw new Error('Nothing to save');
    woTab_(ops, 'CLIENT BODY', WO.BODY_HEAD).appendRow([beirutDate_(today, 0), cid, (appClientInfo_(cid) || {}).name, w || '', h || '', y || '', sx, 'client app']);
  }
  var progs = woProgs_(ops), pr = progs[cid], from = pr && pr.prog ? pr.prog.start : appShift_(today, -30);
  if (from > appShift_(today, -30)) from = appShift_(today, -30);
  var list = (woSessByClient_(ops, from, appShift_(today, WO.AHEAD), woPkgCid_(ops))[cid]) || [];
  var body = woBody_(ops, cid), out = { today: today, body: { weight: body.weight, height: body.height, birth: body.birth, sex: body.sex, date: body.date, history: body.history }, bmr: woBmr_(body, woPerWeek_(list, today)) };
  if (!pr || !pr.prog) { out.has = false; return out; }
  var plan = woPlan_(pr.prog, list, woDecisions_(ops), cid, today), ph = plan.phases;
  var cur = plan.items.filter(function (x) { return x.date === today && x.state !== 'missed'; })[0] || plan.items.filter(function (x) { return x.date > today && x.state === 'planned'; })[0] || null;
  if (op === 'log') {
    var it = plan.items.filter(function (x) { return x.sid === String(b.sid); })[0];
    if (!it) throw new Error('This session is not in your program');
    if (it.date > today || it.date < appShift_(today, -WO.CLIENT_LOG_DAYS)) throw new Error('You can log a workout on its day, up to 7 days after');
    woWriteLogs_(ops, cid, (appClientInfo_(cid) || {}).name, it.sid, it.date, it.name, b.entries, 'client');
  }
  out.has = true;
  var ci = woCurPhase_(ph, today), P = ci > -1 ? ph[ci] : null;
  if (P) out.phase = { name: P.name, start: P.start, end: P.end, n: ci + 1, of: ph.length, note: (pr.prog.phases[ci] || {}).note || '',
    workouts: P.workouts.map(function (w) { return w.name; }), done: plan.items.filter(function (x) { return x.phase === ci && x.state === 'done'; }).length };
  else out.ended = today > ph[ph.length - 1].end;
  if (cur) {
    var wk = ph[cur.phase].workouts[cur.w];
    out.workout = { sid: cur.sid, date: cur.date, start: cur.start, trainer: cur.trainer, name: cur.name, n: cur.w + 1, catchUp: cur.catchUp, w: wk };
  }
  // the last 7 days of sessions in the program, so a client can still log after the session
  out.recent = plan.items.filter(function (x) { return x.date < today && x.date >= appShift_(today, -WO.CLIENT_LOG_DAYS) && x.state === 'done'; })
    .map(function (x) { return { sid: x.sid, date: x.date, name: x.name, w: ph[x.phase].workouts[x.w] }; }).reverse();
  var logs = woLogsOf_(ops, cid);
  out.logs = woLogMap_(logs);
  out.logged = {}; logs.forEach(function (l) { if (l.date >= appShift_(today, -WO.CLIENT_LOG_DAYS)) out.logged[l.sid + '|' + l.ex] = l.sets; });
  return out;
}

// run once from the editor: creates the tabs
function woTest() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  ['WORKOUT PROGRAMS', 'WORKOUT DECISIONS', 'WORKOUT LOG', 'CLIENT BODY', 'EXERCISES'].forEach(function (t, i) { woTab_(ops, t, [WO.PROG_HEAD, WO.DEC_HEAD, WO.LOG_HEAD, WO.BODY_HEAD, WO.EX_HEAD][i]); });
  var lib = woLib_(ops), n = 0; Object.keys(lib).forEach(function (g) { n += lib[g].length; });
  Logger.log('Workout tabs ready. Exercise library: ' + n + ' exercises in ' + Object.keys(lib).length + ' groups. Programs: ' + Object.keys(woProgs_(ops)).length);
}
