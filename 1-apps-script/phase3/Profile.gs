// =====================================================================
// CLIENT PROFILE (client app): profile photo, in-app rating, center price list,
// Wellbe The Brand catalog for the Shop tab.
// Add as a NEW FILE called "Profile" in the "Wellbe W40 Backend" project, then do the
// 3 edits in EDIT-Profile.txt (Client file), run profTest() once, and deploy a new version.
//
// Settings (Script Properties, optional):
//   BRAND_STORE  = https://shopwellbethebrand.com   (the Shopify store read for the Shop tab)
//   BRAND_COUNT  = 8                                (how many products to show)
// =====================================================================
var PROF = {
  TAB: 'CLIENT PROFILE',
  HEAD: ['Client ID', 'Name', 'Photo', 'Updated'],
  PHOTO_MAX: 45000,          // characters of the small JPEG data URL (about 192 px), safely under the 50,000 cell limit
  BRAND_TTL: 21600,          // catalog cache, seconds (6 hours)
  RATE_ALERT_MAX: 3          // ratings at or below this ping Romy
};
function profProp_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v == null || v === '' ? d : v; }
function profTab_(ops) { return appTab_(ops, PROF.TAB, PROF.HEAD); }
function profPhotos_(ops) {
  var sh = profTab_(ops), n = sh.getLastRow(), out = {};
  if (n < 2) return out;
  sh.getRange(2, 1, n - 1, 3).getValues().forEach(function (r) { var id = String(r[0]).trim().toUpperCase(); if (id && r[2]) out[id] = String(r[2]); });
  return out;
}
// photos of these clients only: the ID column is read, then only their photo cells (not every photo of every client)
function profPhotosFor_(ops, ids) {
  var want = {}, out = {}; (ids || []).forEach(function (x) { want[String(x).trim().toUpperCase()] = 1; });
  var sh = ops.getSheetByName(PROF.TAB), n = sh ? sh.getLastRow() : 0;
  if (n < 2) return out;
  var rows = {};
  sh.getRange(2, 1, n - 1, 1).getValues().forEach(function (r, i) { var id = String(r[0]).trim().toUpperCase(); if (id && want[id]) (rows[id] = rows[id] || []).push(i + 2); });
  Object.keys(rows).forEach(function (id) {   // like before: the last row with a photo wins
    for (var k = rows[id].length - 1; k >= 0; k--) { var p = sh.getRange(rows[id][k], 3).getValue(); if (p) { out[id] = String(p); break; } }
  });
  return out;
}
// center package types for "All Wellbe packages" (same list the guest page shows)
function profPackages_() {
  return cfgShopTypes_();
}
// Wellbe The Brand products from the Shopify store, cached
function profBrand_() {
  var want = ((cfg_().shop || {}).brand || []).map(function (h) { return String(h).trim().toLowerCase(); }).filter(String);
  var key = 'prof_brand|' + want.join(',').slice(0, 200), c = CacheService.getScriptCache(), hit = c.get(key);   // a new list in SETTINGS reloads at once
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var store = String(profProp_('BRAND_STORE', 'https://shopwellbethebrand.com')).replace(/\/+$/, ''), n = Number(profProp_('BRAND_COUNT', 8)) || 8, out = [];
  try {
    var r = UrlFetchApp.fetch(store + '/products.json?limit=250', { muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      var all = JSON.parse(r.getContentText()).products || [], by = {};
      all.forEach(function (p) { by[String(p.handle || '').toLowerCase()] = p; });
      // the chosen products in the chosen order; no list = the first n products, as before
      var pick = want.length ? want.map(function (h) { return by[h]; }).filter(Boolean) : all.slice(0, n);
      pick.forEach(function (p) {
        var v = (p.variants || [])[0] || {}, img = ((p.images || [])[0] || {}).src || '';
        if (img) img += (img.indexOf('?') > -1 ? '&' : '?') + 'width=480';
        out.push({ t: String(p.title || ''), d: String(p.product_type || ''), p: Number(v.price) || 0, was: Number(v.compare_at_price) || 0, img: img, url: store + '/products/' + p.handle, h: String(p.handle || '') });
      });
    }
  } catch (e) { Logger.log('Brand catalog failed: ' + e); }
  try { c.put(key, JSON.stringify(out), out.length ? PROF.BRAND_TTL : 600); } catch (e) {}
  return out;
}
// boot additions for every account: photo, price list, brand catalog
function profBoot_(d) {
  if (!d || !d.accounts) return d;
  try {
    var ops = SpreadsheetApp.openById(CFG.OPS_ID);
    if (!ops.getSheetByName(PROF.TAB)) profTab_(ops);   // same as before: the tab is made the first time
    var ph = profPhotosFor_(ops, d.accounts.map(function (a) { return a.cid; }));
    d.accounts.forEach(function (a) { var p = ph[String(a.cid).toUpperCase()]; if (p) a.photo = p; });
    if (!d.guest) d.packages = profPackages_();
    d.brand = profBrand_();
  } catch (e) { Logger.log('profBoot_: ' + e); }
  return d;
}
// action app_cl_profile  op: photo { photo: 'data:image/jpeg;base64,...' } | rate { stars 1-5, note }
function profClient_(b, cid, who) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), op = String(b.op || ''), name = (appClientInfo_(cid) || {}).name || cid;
  if (op === 'photo') {
    var p = String(b.photo || '');
    if (p && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(p)) throw new Error('Send a photo');
    if (p.length > PROF.PHOTO_MAX) throw new Error('Photo too big');
    var sh = profTab_(ops), n = sh.getLastRow(), ids = n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(function (r) { return String(r[0]).toUpperCase(); }) : [];
    var row = [cid, name, p, Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm')], at = ids.indexOf(cid);
    if (at < 0) sh.appendRow(row); else sh.getRange(at + 2, 1, 1, row.length).setValues([row]);
    return { photo: p };
  }
  if (op === 'rate') {
    var s = Math.max(1, Math.min(5, Math.round(Number(b.stars) || 0))), note = clean_(b.note, 400);
    clLog_(ops, cid, name, 'App rating', s + ' star' + (s > 1 ? 's' : '') + (note ? ' · ' + note : ''), '', '', s <= PROF.RATE_ALERT_MAX ? 'New' : 'Done', { stars: s });
    return { stars: s };
  }
  throw new Error('unknown');
}
// run once from the editor
function profTest() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID); profTab_(ops);
  Logger.log('CLIENT PROFILE tab ready. Packages: ' + profPackages_().length + '. Brand products: ' + profBrand_().length);
}
