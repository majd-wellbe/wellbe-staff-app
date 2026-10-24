// =====================================================================
// CORNICHE RUN LEVELS: XP, levels 1 to 50, gift chests, unlocks, coin shop
// Add as a NEW FILE called "Levels" in the "Wellbe W40 Backend" project.
// Saved in the CORNICHE RUN tab (columns T = XP, U = Owned), never on the phone.
// XP: 1 per 10 m run · 50 per daily mission done · 150 once a day for training at the center
//     (streak day 75 and 10,000 steps 50 come with the habit streak and Apple/Google Health)
// Unlocks are free at their level, or bought with coins at any level. The Gold Wellbe Runner badge is never sold.
// Levels never change Game Cash.
// =====================================================================
var LV = {
  get MAX() { return cfg_().game.levelMax; },
  XP: { PER_M: 0.1, MISSION: 50, TRAINED: 150, STREAK: 75, STEPS: 50 },
  // shop item -> coins, free level, kind ('once' = owned forever, 'ticket' = one run each)
  // the shop (settings: game.shop): item -> coins, free level, kind ('once' = owned forever, 'ticket' = one run each)
  get SHOP() { return cfg_().game.shop; },
  get BADGE_LV() { return cfg_().game.badgeLv; }
};
// XP needed to go from level n to n+1 (grows to level 12, then flat)
function lvNeed_(n) { return Math.round(330 * Math.pow(Math.min(n, 12), 0.9)); }
// { level, into, need, total } for a total XP
function lvOf_(xp) {
  var l = 1, left = Math.max(0, Math.floor(xp || 0));
  while (l < LV.MAX && left >= lvNeed_(l)) { left -= lvNeed_(l); l++; }
  return { level: l, into: l < LV.MAX ? left : 0, need: l < LV.MAX ? lvNeed_(l) : 0, total: Math.floor(xp || 0) };
}
// coins in the gift chest for reaching a level
function lvChest_(l) { return 100 + 25 * l; }
// has this power / item (free by level, or bought)
function lvHas_(owned, level, k) { var s = LV.SHOP[k]; return !!s && (level >= s.lv || Number(owned[k] || 0) > 0); }

// players who already bought an upgrade keep that power open
function lvMigrate_(owned, up) {
  if (owned._m) return owned;
  ['magnet', 'jet', 'shoes'].forEach(function (k) { if ((Number(up[k]) || 0) > 0) owned[k] = 1; });
  owned._m = 1; return owned;
}

// adds XP, opens chests and free unlocks for every level passed. Returns what happened.
function lvAdd_(rec, owned, xp) {
  var before = lvOf_(rec[19]).level;
  rec[19] = (Number(rec[19]) || 0) + Math.max(0, Math.round(xp));
  var after = lvOf_(rec[19]).level, ups = [];
  for (var l = before + 1; l <= after; l++) {
    var chest = lvChest_(l), got = [];
    rec[4] = (Number(rec[4]) || 0) + chest;
    Object.keys(LV.SHOP).forEach(function (k) {
      var s = LV.SHOP[k];
      if (s.kind === 'once' && s.lv === l) got.push(s.n);
      if (s.kind === 'ticket' && l >= s.lv) { owned[k] = (Number(owned[k]) || 0) + 1; got.push('1 ' + s.n); }   // 1 free ticket at the unlock level and every level after
    });
    if (l === LV.BADGE_LV) got.push('Gold Wellbe Runner badge');
    ups.push({ level: l, chest: chest, got: got });
  }
  return ups;
}

// coin shop: op 'shop' with item
function lvBuy_(rec, owned, item) {
  var s = LV.SHOP[item]; if (!s) throw new Error('Not in the shop');
  var level = lvOf_(rec[19]).level;
  if (s.kind === 'once' && lvHas_(owned, level, item)) throw new Error('You already have ' + s.n);
  if ((Number(rec[4]) || 0) < s.coins) throw new Error('Not enough coins');
  rec[4] = Number(rec[4]) - s.coins;
  owned[item] = (Number(owned[item]) || 0) + 1;
  return s.n;
}

// what the phone needs to draw the level bar, the shop and which powers can appear
function lvOut_(rec, owned) {
  var lv = lvOf_(rec[19]), have = {}, shop = [];
  Object.keys(LV.SHOP).forEach(function (k) {
    var s = LV.SHOP[k], h = lvHas_(owned, lv.level, k);
    have[k] = s.kind === 'ticket' ? (Number(owned[k]) || 0) : h;
    shop.push({ k: k, n: s.n, coins: s.coins, lv: s.lv, kind: s.kind, have: have[k] });
  });
  return { xp: lv.total, level: lv.level, into: lv.into, need: lv.need, max: LV.MAX, have: have, shop: shop, badge: lv.level >= LV.BADGE_LV };
}

// trained at the center TODAY (marked present) = +150 XP once a day
function lvTrainedToday_(ops, cid, today) {
  var cache = CacheService.getScriptCache(), key = 'lvtr|' + cid + '|' + today, c = cache.get(key);
  if (c) return c === '1';
  var ids = clPkgIds_(ops, cid), yes = false;
  appSessions_(ops, today, today, null).forEach(function (s) {
    if (s.status === 'Cancelled') return;
    s.clients.forEach(function (x) { if (ids[x.pkg] && /present|done/i.test(x.att || '')) yes = true; });
  });
  cache.put(key, yes ? '1' : '0', 900);
  return yes;
}

// run once from the editor: prints the level table
function lvTest() {
  var t = 0, out = [];
  for (var l = 1; l <= LV.MAX; l++) { out.push('L' + l + ' at ' + t + ' XP'); t += lvNeed_(l); }
  Logger.log(out.join('\n'));
}
