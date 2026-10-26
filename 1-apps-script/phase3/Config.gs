// =====================================================================
// SETTINGS: the one place for business values (staff, package types, prices,
// offers, hours, windows, game rules). Add as a NEW FILE called "Config".
//
//  CFG_DEFAULTS below = the values the code used before (fallback).
//  Three tabs in the Operations sheet override them (run cfgSetup() once to create them):
//    STAFF          one row per person (login, trainer name, capacity, pay rule)
//    PACKAGE TYPES  one row per package that can be sold
//    SETTINGS       Key | Value | Notes   (Key = a path like offers.m3Pct, Value = number, text or JSON)
//  Changes show in the apps within 10 minutes, or at once after running cfgBump().
//  A bad row is skipped (see Executions > Logs), it never stops the apps.
// Not settings: sheet IDs, column maps (AT, L, S13), secrets (Script Properties).
// =====================================================================

var CFG_DEFAULTS = {
  v: 1,
  center: {
    name: 'Wellbe Health Center', area: 'Beirut area', desk: 'romy', wa: '96176511048', country: '961', location: 'Bsalim',
    maps: 'https://maps.google.com/?q=Wellbe+Health+Center+Bsalim',
    review: 'https://search.google.com/local/writereview?placeid=ChIJ35Nmu5s_HxURBmvCuEEY8U0',
    friend: 'https://majd-wellbe.github.io/Wellbe-center-landingpage-womenAMsessions/?by=',
    staffSite: 'https://majd-wellbe.github.io/wellbe-staff-app/',
    clientSite: 'https://majd-wellbe.github.io/wellbe-staff-app/client/'
  },
  // the trainer who takes the free trials from the landing page and the client app
  trial: { trainer: 'joe' },
  // match = text looked for in the Trainer cell of the session tabs (old rows use full or short names)
  // cap = max clients in one hour across 1:1, 1:2 and 1:3 (empty = no limit)
  staff: [
    { id: 'majd', train: true, name: 'Majd Bou Habib', role: 'owner', trainer: 'Majd', match: 'majd', email: 'majdbouhabib@gmail.com', phone: '',
      pay: { rule: 'fixed', fixed: { training: 20, Physio: 38, PhysioIns: 28, Prehab: 38 } }, active: true },
    { id: 'romy', name: 'Romy', nameAr: 'رومي', role: 'assistant', trainer: '', match: '', email: 'wellbe002@gmail.com', phone: '', pay: { rule: '' }, active: true },
    { id: 'joe', train: true, name: 'Joe Al Hosny', role: 'trainer', trainer: 'Joe', match: 'joe', email: 'alhosnyjoe@gmail.com', phone: '', cap: 3, pay: { rule: 'tier', base: 0 }, active: true },
    { id: 'mikel', train: true, name: 'Mikel', role: 'trainer', trainer: 'Mikel', match: 'mik', email: 'zaarourmike@gmail.com', phone: '', pay: { rule: 'tier', base: 50 }, active: true },
    { id: 'melanie', train: true, name: 'Melanie', role: 'trainer', trainer: 'Melanie', match: 'mel', email: 'melaniebaraket@gmail.com', phone: '', pay: { rule: 'cut', cut: 4 }, active: true },
    { id: 'jad', name: 'Jad Barakat', role: 'trainer', trainer: 'Jad', match: 'jad', email: '', phone: '', pay: { rule: 'fixed', fixed: { Osteo: 140 } }, active: true },
    { id: 'nagi', name: 'Nagi', role: 'trainer', trainer: 'Nagi', match: 'nagi', email: '', phone: '', pay: { rule: '' }, active: false }
  ],
  pay: { tiers: [[40, 7], [80, 9], [null, 10.5]] },
  // days = valid this many days from the start; months = valid this many months (wins over days)
  // mel = sold for Melanie's own clients ("PT with Mel"); shop = listed in the client app
  types: [
    { name: '1:3 - 12x/month ($200pp)', passes: 12, price: 200, kind: '1:3', days: 30, shop: true },
    { name: '1:3 - 8x/month ($140pp)', passes: 8, price: 140, kind: '1:3', days: 30, shop: true },
    { name: '1:2 - 12x/month ($270pp)', passes: 12, price: 270, kind: '1:2', days: 30, shop: true },
    { name: '1:2 - 8x/month ($180pp)', passes: 8, price: 180, kind: '1:2', days: 30, shop: true },
    { name: '1:1 - 12x/month ($300)', passes: 12, price: 300, kind: '1:1', days: 30, shop: true },
    { name: '1:1 - 8x/month ($220)', passes: 8, price: 220, kind: '1:1', days: 30, shop: true },
    { name: '1:1 - 4x/month ($110)', passes: 4, price: 110, kind: '1:1', days: 30, shop: true },
    { name: 'PT with Mel 1:1 - 8 Sessions ($250)', passes: 8, price: 250, kind: '1:1', days: 30, mel: true },
    { name: 'PT with Mel 1:1 - 12 Sessions ($350)', passes: 12, price: 350, kind: '1:1', days: 30, mel: true },
    { name: 'Prehab - 10 Sessions ($400)', passes: 10, price: 400, kind: 'Prehab', months: 3, shop: true },
    { name: 'Physio - Single Session ($50)', passes: 1, price: 50, kind: 'Physio', days: 10, shop: true },
    { name: 'Osteo - Single Session ($150)', passes: 1, price: 150, kind: 'Osteo', days: 10, shop: true },
    { name: 'Madero - 6 Sessions ($270)', passes: 6, price: 270, kind: 'Madero', months: 2, shop: true },
    { name: 'Madero - 12 Sessions ($500)', passes: 12, price: 500, kind: 'Madero', months: 2, shop: true },
    { name: 'Stretching & Mobility - 4 Sessions ($140)', passes: 4, price: 140, kind: '1:1', days: 42, shop: true },
    { name: 'Trial Session - 1:3 (Free)', passes: 1, price: 0, kind: '1:3', days: 10, trial: true, free: true },
    { name: 'Assessment - Majd (Free)', passes: 1, price: 0, kind: 'Physio', days: 10, free: true }
  ],
  // fixed = staff ID who always gives this service
  services: {
    '1:1': { label: '1:1', room: 'Training Room', cap: 1 },
    '1:2': { label: '1:2', room: 'Training Room', cap: 2 },
    '1:3': { label: '1:3', room: 'Training Room', cap: 3 },
    Physio: { label: 'Physio', room: 'Physio Room', cap: 1, fixed: 'majd' },
    Prehab: { label: 'Prehab', room: 'Physio Room', cap: 1, fixed: 'majd' },
    Osteo: { label: 'Osteo', room: 'Osteo Room', cap: 1, fixed: 'jad' },
    Madero: { label: 'Madero', room: 'Madero Room', cap: 1, fixed: 'melanie' }
  },
  offers: { m3Pct: 7, m6Pct: 15, bundleDays: 70, physioPct: 20, physioPrice: 40, physioWas: 50, physioType: 'Physio - Single Session ($50)' },
  late: { limits: [[12, 3], [8, 2]], 'else': 1 },
  hours: {
    trial: [7, 8, 9, 10], trialDays: [1, 2, 3, 4, 5], blocked: [],
    open: 6, close: 20, step: 30, defaultStart: '07:00',
    // physio: day of week (0 Sunday) -> session start times, 60 minutes each
    physio: {
      '1': ['08:30', '09:30', '10:30', '11:30', '16:00', '17:00', '18:00', '19:00', '20:00'],
      '3': ['08:30', '09:30', '10:30', '11:30', '16:00', '17:00', '18:00', '19:00', '20:00'],
      '4': ['16:00', '17:00', '18:00', '19:00', '20:00'],
      '5': ['08:30', '09:30', '10:30', '11:30', '16:00', '17:00', '18:00', '19:00', '20:00']
    }
  },
  windows: {
    staffBack: 70, ownerBack: 800, ahead: 35, trainerSee: 60, clientBack: 45,
    trialAhead: 7, trialNoticeH: 12, trialExpiryDays: 30,
    physioDays: 14, physioNoticeH: 12, joinMinH: 48, joinDays: 10, freezeDays: 7,
    patternDays: 60, myClientsDays: 45, oldPkgDays: 45, renewDays: 21, expenseDueDays: 5, advisorDays: 30, packDays: 30, singleDays: 10, backfillDays: 14
  },
  streak: { days: 28, validDays: 90 },
  // ad leads that come in between quietFrom and quietTo (Beirut hours) wait until quietTo: no night calls
  leads: { quietFrom: 21, quietTo: 9 },
  insurance: { rate: 27 },
  game: {
    cash: { MIN_M: 2000, CENTS: 10, DAY_MAX: 50, REDEEM_MIN: 100, REDEEM_MAX: 2000, TRAINED_DAYS: 7 },
    upCost: [500, 1000, 2000, 4000, 8000], lifeCost: 1000, lifeMax: 3, levelMax: 50, badgeLv: 50,
    shop: {
      magnet: { n: 'Coin magnet', coins: 1500, lv: 2, kind: 'once' },
      shoes: { n: 'Super jump shoes', coins: 2500, lv: 4, kind: 'once' },
      jet: { n: 'Jetpack', coins: 4000, lv: 6, kind: 'once' },
      life2: { n: '2nd extra life slot', coins: 5000, lv: 8, kind: 'once' },
      t500: { n: '500 coin run ticket', coins: 800, lv: 10, kind: 'ticket' },
      t1500: { n: 'Start at 1,500 m ticket', coins: 1200, lv: 15, kind: 'ticket' },
      // prestige outfits: the level opens them, then they cost coins (kind 'prestige': never free by level)
      o1: { n: 'Tyrian Purple outfit', coins: 3000, lv: 20, kind: 'prestige' },
      o2: { n: 'Golden Cedar outfit', coins: 6000, lv: 30, kind: 'prestige' },
      o3: { n: 'Corniche Legend outfit', coins: 10000, lv: 40, kind: 'prestige' }
    },
    // runner outfits (RunGame.gs runOutfits_). coins = price; free: everyone; staff: free for staff; physio: free after a physio booking;
    // early: runs started before earlyHour (Beirut); km: total km run; shop: a prestige shop item (level + coins)
    outfits: {
      coach: { n: 'Wellbe Coach Kit', coins: 1500, staff: true },
      ramadan: { n: 'Ramadan Night Run', coins: 1000 },
      matchday: { n: 'Yalla Lebnan', coins: 0, free: true },
      street: { n: 'Mar Mikhael Street', coins: 2000 },
      modest: { n: 'Modest Mover', coins: 0, free: true },
      rehab: { n: 'Rehab Hero', coins: 1000, physio: true },
      am530: { n: '5:30 AM Club', coins: 0, early: 10 },
      race42: { n: 'Race Day 42K', coins: 0, km: 42 },
      tyrian: { n: 'Tyrian Purple', coins: 0, shop: 'o1' },
      cedar: { n: 'Golden Cedar', coins: 0, shop: 'o2' },
      legend: { n: 'Corniche Legend', coins: 0, shop: 'o3' }
    },
    earlyHour: 7, earlyMinM: 300,
    // client IDs that count as Wellbe staff in the game (Coach Kit free). Staff are also found by their email or phone in STAFF.
    staffClients: []
  },
  // Wellbe The Brand products shown in the client app Shop, in this order (Shopify product handles)
  shop: { brand: ['necklux-2-0-the-ultimate-neck-massager', 'backlux-lower-back-massager', 'hypro-massage-gun', 'aloe-vera-gel', 'wellbe-anti-shock-case', 'knee-patella-support', 'the-ultimate-foot-stretcher'] },
  lists: {
    methods: ['Cash', 'Whish', 'Neo'],
    expenseCats: ['Rent', 'Utilities', 'Salaries', 'Supplies', 'Equipment', 'Software', 'Marketing', 'Other'],
    repeats: ['Once', 'Weekly', 'Monthly', 'Every 3 months', 'Every 6 months', 'Yearly']
  },
  // which server the apps talk to (core/wb-backend.js): 'apps' = this Apps Script, 'supabase' = after the move.
  // Set it in SETTINGS (backend.use) AND in Supabase public.settings, see supabase/DEPLOY.md
  backend: { use: 'apps' }
};

var CFG_KINDS = ['1:1', '1:2', '1:3', 'Physio', 'Prehab', 'Osteo', 'Madero'];
var CFG_ROLES = ['owner', 'assistant', 'trainer'];
var STAFF_HEAD = ['ID', 'Name', 'Role', 'Trainer name', 'Email', 'Phone', 'Max per hour', 'Pay rule', 'Pay base', 'Pay cut', 'Fixed pay (JSON)', 'Active', 'Match text', 'Trains in the gym (Y/N)', 'Arabic name'];
var TYPES_HEAD = ['Name', 'Passes', 'Price', 'Kind', 'Valid days', 'Valid months', 'Melanie (Y/N)', 'Trial (Y/N)', 'Free (Y/N)', 'Active', 'In client app (Y/N)'];
var SETTINGS_HEAD = ['Key', 'Value', 'Notes'];
var CFG_MEMO_ = null;            // one read per execution
var CFG_CACHE_KEY_ = 'cfg|v1';

// =====================================================================
// READ
// =====================================================================
function cfg_() {
  if (CFG_MEMO_) return CFG_MEMO_;
  var cache = null;
  try { cache = CacheService.getScriptCache(); var hit = cache.get(CFG_CACHE_KEY_); if (hit) { CFG_MEMO_ = JSON.parse(hit); return CFG_MEMO_; } } catch (e) {}
  var c = cfgCopy_(CFG_DEFAULTS);
  try {
    var ops = SpreadsheetApp.openById(CFG.OPS_ID);
    var staff = cfgReadStaff_(ops.getSheetByName('STAFF')); if (staff.length) c.staff = staff;
    var types = cfgReadTypes_(ops.getSheetByName('PACKAGE TYPES')); if (types.length) c.types = types;
    cfgReadSettings_(ops.getSheetByName('SETTINGS'), c);
  } catch (e) { Logger.log('Settings not read, using defaults: ' + e); }
  CFG_MEMO_ = c;
  try { if (cache) cache.put(CFG_CACHE_KEY_, JSON.stringify(c), 600); } catch (e) {}
  return c;
}
// after editing the STAFF / PACKAGE TYPES / SETTINGS tabs: run this to see the change at once
function cfgBump() { cfgBump_(); Logger.log('Settings reloaded. Staff: ' + cfg_().staff.length + ', package types: ' + cfg_().types.length); }
function cfgBump_() {
  CFG_MEMO_ = null;
  try { CacheService.getScriptCache().remove(CFG_CACHE_KEY_); } catch (e) {}
  try { appBump_(); } catch (e) {}      // cached app boots carry the settings too
}
function cfgCopy_(o) { return JSON.parse(JSON.stringify(o)); }
function cfgYes_(v, dflt) { var s = String(v == null ? '' : v).trim().toLowerCase(); if (!s) return dflt; return /^(y|yes|true|1|x)$/.test(s); }
function cfgNum_(v) { if (v === '' || v === null || v === undefined) return null; var n = Number(String(v).replace(/[$,\s]/g, '')); return isNaN(n) ? NaN : n; }

function cfgReadStaff_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var out = [], seen = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, STAFF_HEAD.length).getValues().forEach(function (r, i) {
    var id = String(r[0] || '').trim().toLowerCase(), name = String(r[1] || '').trim(), role = String(r[2] || '').trim().toLowerCase();
    if (!id && !name) return;
    if (!/^[a-z0-9_]+$/.test(id) || !name || CFG_ROLES.indexOf(role) < 0 || seen[id]) { Logger.log('STAFF row ' + (i + 2) + ' skipped: needs a unique ID (letters), a Name and a Role (owner, assistant or trainer)'); return; }
    seen[id] = 1;
    var trainer = String(r[3] || '').trim(), cap = cfgNum_(r[6]), fixed = {};
    if (String(r[10] || '').trim()) { try { fixed = JSON.parse(String(r[10])); } catch (e) { Logger.log('STAFF row ' + (i + 2) + ': Fixed pay is not valid JSON, ignored'); fixed = {}; } }
    var s = { id: id, name: name, role: role, trainer: trainer, match: String(r[12] || '').trim().toLowerCase() || trainer.toLowerCase(),
      email: String(r[4] || '').trim(), phone: String(r[5] || '').trim() };
    if (cap !== null && !isNaN(cap) && cap > 0) s.cap = cap;
    if (cfgYes_(r[13], false)) s.train = true;
    if (String(r[14] || '').trim()) s.nameAr = String(r[14]).trim();
    s.pay = { rule: String(r[7] || '').trim().toLowerCase() }; s.active = cfgYes_(r[11], true);
    var base = cfgNum_(r[8]), cut = cfgNum_(r[9]);
    if (base !== null && !isNaN(base)) s.pay.base = base;
    if (cut !== null && !isNaN(cut)) s.pay.cut = cut;
    if (Object.keys(fixed).length) s.pay.fixed = fixed;
    out.push(s);
  });
  return out;
}
function cfgReadTypes_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var out = [], seen = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, TYPES_HEAD.length).getValues().forEach(function (r, i) {
    var name = String(r[0] || '').trim(); if (!name) return;
    var passes = cfgNum_(r[1]), price = cfgNum_(r[2]), kind = String(r[3] || '').trim();
    if (seen[name] || passes === null || isNaN(passes) || passes < 0 || price === null || isNaN(price) || price < 0) { Logger.log('PACKAGE TYPES row ' + (i + 2) + ' skipped: needs a unique Name, Passes and Price (numbers)'); return; }
    if (CFG_KINDS.indexOf(kind) < 0) kind = appKind_(name);
    seen[name] = 1;
    var t = { name: name, passes: passes, price: price, kind: kind }, days = cfgNum_(r[4]), months = cfgNum_(r[5]);
    if (months !== null && !isNaN(months) && months > 0) t.months = months;
    if (days !== null && !isNaN(days) && days > 0) t.days = days;
    if (cfgYes_(r[6], false)) t.mel = true;
    if (cfgYes_(r[7], false)) t.trial = true;
    if (cfgYes_(r[8], false)) t.free = true;
    if (!cfgYes_(r[9], true)) t.active = false;
    if (cfgYes_(r[10], false)) t.shop = true;
    out.push(t);
  });
  return out;
}
// SETTINGS rows: only keys that exist in CFG_DEFAULTS (typos are skipped), same kind of value
function cfgReadSettings_(sh, c) {
  if (!sh || sh.getLastRow() < 2) return;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r, i) {
    var key = String(r[0] || '').trim(); if (!key) return;
    var path = key.split('.'), raw = r[1];
    if (path[0] === 'staff' || path[0] === 'types' || path[0] === 'v') { Logger.log('SETTINGS row ' + (i + 2) + ': ' + key + ' is set in its own tab'); return; }
    var d = CFG_DEFAULTS, o = c;
    for (var k = 0; k < path.length - 1; k++) {
      if (!d || typeof d !== 'object' || !(path[k] in d)) { d = undefined; break; }
      d = d[path[k]]; o = o && typeof o === 'object' ? o[path[k]] : undefined;
    }
    var last = path[path.length - 1], like = d && typeof d === 'object' ? d[last] : undefined;
    // a new entry in a list of the same things (a physio day, a service, a shop item) takes the shape of its neighbours
    if (like === undefined && d && typeof d === 'object' && !Array.isArray(d) && cfgSameShape_(d)) like = d[Object.keys(d)[0]];
    if (like === undefined || !o || typeof o !== 'object') { Logger.log('SETTINGS row ' + (i + 2) + ': unknown key ' + key + ', skipped'); return; }
    var v = cfgParse_(raw, like);
    if (v === undefined) { Logger.log('SETTINGS row ' + (i + 2) + ': value for ' + key + ' is not the right kind, skipped'); return; }
    o[last] = v;
  });
}
function cfgSameShape_(d) {
  var ks = Object.keys(d); if (ks.length < 2) return false;
  var sig = function (x) { return Array.isArray(x) ? 'a' : (x && typeof x === 'object' ? 'o' : 'x'); };
  return ks.every(function (k) { return sig(d[k]) !== 'x' && sig(d[k]) === sig(d[ks[0]]); });
}
function cfgParse_(raw, like) {
  if (typeof raw === 'number' || typeof raw === 'boolean') { if (typeof like === typeof raw) return raw; if (typeof like === 'string') return String(raw); return undefined; }
  var s = String(raw == null ? '' : raw).trim(), v;
  if (typeof like === 'string') return s;
  try { v = JSON.parse(s); } catch (e) { return undefined; }
  if (typeof like === 'number') return typeof v === 'number' ? v : undefined;
  if (typeof like === 'boolean') return typeof v === 'boolean' ? v : undefined;
  if (Array.isArray(like)) return Array.isArray(v) ? v : undefined;
  if (like && typeof like === 'object') return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  return v;
}

// =====================================================================
// HELPERS used by the rest of the code
// =====================================================================
// people who can sign in (active rows)
function cfgStaff_() { return cfg_().staff.filter(function (s) { return s.active !== false; }); }
function cfgStaffById_(id) { id = String(id || '').toLowerCase(); return cfg_().staff.filter(function (s) { return s.id === id; })[0] || null; }
function cfgStaffByTrainer_(t) { return cfg_().staff.filter(function (s) { return s.trainer && s.trainer === t; })[0] || null; }
// the front desk person (requests, WhatsApp) and the owner(s): staff IDs
function cfgDeskId_() { var d = cfgStaffById_(cfg_().center.desk); return d ? d.id : ((cfgStaff_().filter(function (s) { return s.role === 'assistant'; })[0] || {}).id || ''); }
function cfgDeskName_() { var d = cfgStaffById_(cfgDeskId_()); return d ? String(d.name).split(' ')[0] : 'the front desk'; }
function cfgOwnerIds_() { return cfgStaff_().filter(function (s) { return s.role === 'owner'; }).map(function (s) { return s.id; }); }
// raw Trainer cell ('Joe Al Hosny', 'mel') -> trainer name ('Joe'). Trainers first, then the others, in tab order.
function cfgTrainerName_(v) {
  var s = String(v || '').trim(), l = s.toLowerCase(), list = cfg_().staff.filter(function (x) { return x.trainer && x.match; });
  list = list.filter(function (x) { return x.role === 'trainer'; }).concat(list.filter(function (x) { return x.role !== 'trainer'; }));
  for (var i = 0; i < list.length; i++) if (l.indexOf(list[i].match) > -1) return list[i].trainer;
  return s;
}
// max clients in one hour for this trainer name (0 = no limit)
function cfgCap_(trainer) { var s = cfgStaffByTrainer_(trainer); return s && s.cap ? Number(s.cap) : 0; }
// the trainer who takes free trials
function cfgTrialStaff_() { return cfgStaffById_(cfg_().trial.trainer) || { id: '', trainer: '', match: '\u0000', cap: 0 }; }
// package type by its exact name (null for old labels not in the list)
function cfgType_(name) { return cfg_().types.filter(function (t) { return t.name === name; })[0] || null; }
function cfgTypes_() { return cfg_().types.filter(function (t) { return t.active !== false; }); }
function cfgTrialType_() { var t = cfg_().types.filter(function (x) { return x.trial; })[0]; return t ? t.name : 'Trial Session - 1:3 (Free)'; }
// kind of a package label: the list first, the old name rules for older labels
function cfgKind_(name) { var t = cfgType_(name); return t ? t.kind : appKind_(name); }
// "All Wellbe packages" in the client and guest app
function cfgShopTypes_() {
  return cfgTypes_().filter(function (t) { return t.shop && t.price > 0; })
    .map(function (t) { return { name: t.name, label: String(t.name).replace(/\s*\(\$[^)]*\)/, ''), n: t.passes, price: t.price, kind: t.kind }; });
}
// service settings by kind or session tab key ('PP' = Physio and Prehab tab)
function cfgService_(k) { var s = cfg_().services; return s[k === 'PP' ? 'Physio' : k] || {}; }
function cfgRoom_(k) { return cfgService_(k).room || ''; }
// trainer name of the person who always gives a service ('' when any trainer can)
function cfgFixed_(k) { var id = cfgService_(k).fixed; if (!id) return ''; var s = cfgStaffById_(id); return s ? s.trainer : ''; }
// default expiry rule of a type: { months } or { days }
function cfgValid_(t) {
  if (t && t.months) return { months: Number(t.months) };
  if (t && t.days) return { days: Number(t.days) };
  return { days: t && Number(t.passes) === 1 ? 10 : 30 };
}

// =====================================================================
// WHAT THE APPS RECEIVE (boot d.cfg)
//  'staff' + owner: everything. 'staff' others: no emails or phones.
//  'client': no emails, phones, pay, lists or insurance; only active staff.
// =====================================================================
function cfgPublic_(audience, role, me) {
  var c = cfgCopy_(cfg_()), client = audience === 'client', owner = !client && role === 'owner';
  c.staff = c.staff.filter(function (s) { return s.active !== false; }).map(function (s) {
    var o = { id: s.id, name: s.name, role: s.role, trainer: s.trainer };
    if (s.cap) o.cap = s.cap;
    if (s.train) o.train = true;
    if (s.nameAr) o.nameAr = s.nameAr;
    if (!client && (owner || role === 'assistant' || s.id === me)) o.pay = s.pay || {};
    if (owner) { o.email = s.email || ''; o.phone = s.phone || ''; }
    return o;
  });
  c.types = c.types.filter(function (t) { return t.active !== false; });
  if (c.services && c.services['1:3'] && c.trial && c.trial.trainer) c.services['1:3'].trainer = c.trial.trainer;   // who runs the 1:3 trials
  delete c.trial;
  if (client) { delete c.pay; delete c.lists; delete c.insurance; if (c.game) delete c.game.staffClients; }
  return c;
}

// =====================================================================
// SETUP: creates the 3 tabs with today's values (existing rows are kept)
// =====================================================================
function cfgSetup() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  var st = appTab_(ops, 'STAFF', STAFF_HEAD);
  if (st.getLastRow() < 2) {
    var rows = CFG_DEFAULTS.staff.map(function (s) {
      var p = s.pay || {};
      return [s.id, s.name, s.role, s.trainer, s.email, s.phone || '', s.cap || '', p.rule || '', p.base === undefined ? '' : p.base, p.cut === undefined ? '' : p.cut,
        p.fixed ? JSON.stringify(p.fixed) : '', s.active === false ? 'N' : 'Y', s.match || '', s.train ? 'Y' : 'N', s.nameAr || ''];
    });
    st.getRange(2, 1, rows.length, STAFF_HEAD.length).setValues(rows);
  }
  var ty = appTab_(ops, 'PACKAGE TYPES', TYPES_HEAD);
  if (ty.getLastRow() < 2) {
    var trows = CFG_DEFAULTS.types.map(function (t) {
      return [t.name, t.passes, t.price, t.kind, t.days || '', t.months || '', t.mel ? 'Y' : 'N', t.trial ? 'Y' : 'N', t.free ? 'Y' : 'N', t.active === false ? 'N' : 'Y', t.shop ? 'Y' : 'N'];
    });
    ty.getRange(2, 1, trows.length, TYPES_HEAD.length).setValues(trows);
  }
  var se = appTab_(ops, 'SETTINGS', SETTINGS_HEAD), have = {};
  if (se.getLastRow() > 1) se.getRange(2, 1, se.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0]).trim()] = 1; });
  var add = [];
  cfgLeaves_(CFG_DEFAULTS, '', add);
  add = add.filter(function (x) { return !have[x[0]]; });
  if (add.length) se.getRange(se.getLastRow() + 1, 1, add.length, 3).setValues(add);
  cfgBump_();
  Logger.log('Settings tabs ready: STAFF, PACKAGE TYPES, SETTINGS (' + add.length + ' new keys). Edit them, then run cfgBump() or wait 10 minutes.');
}
// every leaf of the defaults as [key, value, note]; lists are written as JSON
function cfgLeaves_(o, pre, out) {
  Object.keys(o).forEach(function (k) {
    var key = pre ? pre + '.' + k : k, v = o[k];
    if (!pre && (k === 'staff' || k === 'types' || k === 'v')) return;
    if (v && typeof v === 'object' && !Array.isArray(v)) cfgLeaves_(v, key, out);
    else out.push([key, typeof v === 'string' ? "'" + v : (Array.isArray(v) ? JSON.stringify(v) : v), '']);
  });
}
