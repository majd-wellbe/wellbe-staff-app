// =====================================================================
// NUTRITION PLANS (client app + staff app)
// Add as a NEW FILE called "Nutrition" in the "Wellbe W40 Backend" project.
//
// INSTALL (one time):
//  1. Paste this file. Make the small edits in EDIT-Nutrition.txt (Client and App files).
//  2. Project Settings > Script Properties: ANTHROPIC_KEY (already there for the promise keys).
//     Optional: NUTRITION_MODEL (default claude-sonnet-5-5).
//  3. Run nutSetup() once: creates the 3 tabs and the 1 minute worker that writes plans.
//  4. Deploy > Manage deployments > Edit > Version: New version > Deploy.
//  Test from the editor: nutTest()  (macro math on example profiles, no AI call)
//
// HOW IT WORKS
//  - The client fills a 5 minute questionnaire (EN + AR), body numbers, a target weight,
//    and can upload an InBody / body composition report (AI reads the numbers, client confirms).
//  - Calories and macros are calculated HERE in code (never by the AI):
//      BMR Mifflin St Jeor (Katch-McArdle when body fat % is known) x activity (job + training days)
//      protein 2 g per kg of GOAL weight · fat 28% of calories · carbs the rest
//      pace: loss 0.5% of body weight per week (0.75% max), gain 0.25% (0.5% max)
//      floor: 1,200 kcal women / 1,500 men, never under BMR
//  - Projection is a RANGE and a date window, never a promise.
//  - FREE for everyone (guests too): the macro calculator. PAID (active package = subscription):
//    the full plan. The AI only turns the macros into Lebanese meals with portions, swaps and notes;
//    the grocery list is added up here from the portions.
//  - Every plan waits for a coach (Pending -> Approved) before the client sees it.
//  - Safety flags (under 18, pregnant / breastfeeding, eating disorder history, kidney) never get
//    automatic numbers or plans: they go to a coach. Diabetes, thyroid, liver, appetite medication:
//    plan is made but the coach must check it.
//  - A weigh-in updates the projection with no AI call. More than 2 kg change or a new target = new plan.
// Tabs: NUTRITION INTAKE · NUTRITION PLANS · NUTRITION WEIGHINS
// Client action app_cl_nut (op): intake_get | intake_save | body | upload | calc | generate | get | weigh
// Staff actions: app_nut_list | app_nut_get | app_nut_decide (act: approve | note | regen | decline)
// Who checks plans: Majd, Romy AND the client's trainers. The staff app loads app_nut_list for every role
// (trainers only get their own clients) and shows them in To do; the CLIENT REQUESTS row is closed on decide.
// Full plan = a current PAID package only (trial, assessment and free packages get the free calculator).
// =====================================================================
var NUT = {
  INTAKE_HEAD: ['Client ID', 'Client', 'Answers (JSON)', 'Step', 'Done', 'Version', 'Target kg', 'Body comp (JSON)', 'Flags', 'Updated'],
  PLAN_HEAD: ['Plan ID', 'Client ID', 'Client', 'Created', 'Status', 'Macros (JSON)', 'Plan (JSON 1)', 'Plan (JSON 2)', 'Plan (JSON 3)', 'Intake version', 'Weight at plan', 'Target', 'By', 'Decided at', 'Coach note', 'Error'],
  WEIGH_HEAD: ['Date', 'Client ID', 'Client', 'Weight kg', 'By'],
  CELL: 45000,                      // Sheets cell limit is 50,000 characters
  PROTEIN_PER_KG_GOAL: 2, FAT_PCT: 0.28,
  LOSS: { slow: 0.005, fast: 0.0075 }, GAIN: { slow: 0.0025, fast: 0.005 },
  FLOOR: { F: 1200, M: 1500 }, FLOOR_BMR: 1.0,     // never under BMR (a coach can go lower with a regen override)
  KCAL_PER_KG: 7700,
  REPLAN_KG: 2,
  TOL: { kcal: 0.05, p: 0.05, c: 0.10, f: 0.10 },
  STOP: ['minor', 'pregnant', 'ed', 'kidney'],            // coach builds it, no automatic numbers
  CHECK: ['diabetes', 'thyroid', 'liver', 'meds'],          // plan is made, coach must check
  WEEK: [0, 1, 2, 3, 0, 1, 2]                               // day templates A B C D A B C over 7 days
};

// ---------------------------------------------------------------------
// QUESTIONNAIRE (sent to the phone, so it can change without an app update)
// type: one (single chip) | many (chips) | text | num | time
// ---------------------------------------------------------------------
function nutO_(list) { return list.map(function (x) { return { v: x[0], en: x[1], ar: x[2] }; }); }
function nutQuestions_() {
  return [
    { step: 1, t: { en: 'Your goal', ar: 'هدفك' }, q: [
      { k: 'goal', type: 'one', t: { en: 'What do you want most?', ar: 'شو بدك أكتر شي؟' }, opts: nutO_([['lose', 'Lose fat', 'خسارة دهون'], ['tone', 'Tone up and keep my weight', 'شد الجسم مع الحفاظ على الوزن'], ['gain', 'Build muscle and gain weight', 'بناء عضل وزيادة وزن'], ['health', 'Eat healthier, feel better', 'أكل صحي أكتر']]) },
      { k: 'why', type: 'text', max: 200, t: { en: 'Why now? (one sentence)', ar: 'ليش هلق؟ (جملة وحدة)' } },
      { k: 'pace', type: 'one', t: { en: 'Which pace suits you?', ar: 'أي سرعة بتناسبك؟' }, opts: nutO_([['slow', 'Steady and easy to keep', 'ثابتة وسهلة'], ['fast', 'Faster, I am very motivated', 'أسرع، أنا متحمس كتير']]) },
      { k: 'event', type: 'text', max: 80, t: { en: 'Any date you are aiming for? (wedding, summer, trip)', ar: 'في تاريخ معين؟ (عرس، صيف، سفر)' } }
    ]},
    { step: 2, t: { en: 'Your day', ar: 'نهارك' }, q: [
      { k: 'job', type: 'one', t: { en: 'Your work day is mostly', ar: 'شغلك بالنهار' }, opts: nutO_([['desk', 'Sitting (desk, car)', 'قاعد (مكتب، سيارة)'], ['mixed', 'On my feet part of the day', 'واقف جزء من النهار'], ['active', 'Physical work, moving all day', 'شغل جسدي طول النهار']]) },
      { k: 'train_days', type: 'one', t: { en: 'Training days per week (Wellbe + other)', ar: 'كم يوم تمرين بالأسبوع' }, opts: nutO_([['1', '1', '1'], ['2', '2', '2'], ['3', '3', '3'], ['4', '4', '4'], ['5', '5+', '5+']]) },
      { k: 'train_time', type: 'one', t: { en: 'You usually train', ar: 'عادة بتتمرن' }, opts: nutO_([['am', 'Morning', 'الصبح'], ['mid', 'Midday', 'الضهر'], ['pm', 'Evening', 'المسا']]) },
      { k: 'wake', type: 'time', t: { en: 'You wake up at', ar: 'بتفيق الساعة' } },
      { k: 'sleep', type: 'one', t: { en: 'Hours of sleep', ar: 'ساعات النوم' }, opts: nutO_([['5', 'Under 6', 'أقل من 6'], ['6', '6 to 7', '6 لـ 7'], ['8', '7 to 8+', '7 لـ 8+']]) }
    ]},
    { step: 3, t: { en: 'How you eat', ar: 'كيف بتاكل' }, q: [
      { k: 'meals', type: 'one', t: { en: 'Meals per day that suit you', ar: 'كم وجبة بالنهار بتناسبك' }, opts: nutO_([['2', '2 meals', 'وجبتين'], ['3', '3 meals', '3 وجبات'], ['3s', '3 meals + 1 snack', '3 وجبات + سناك'], ['4s', '3 meals + 2 snacks', '3 وجبات + سناكين']]) },
      { k: 'breakfast', type: 'one', t: { en: 'Breakfast', ar: 'الترويقة' }, opts: nutO_([['yes', 'I eat breakfast', 'بترويق'], ['late', 'Late, around noon', 'متأخر، عالضهر'], ['no', 'I skip it', 'ما بترويق']]) },
      { k: 'cook', type: 'one', t: { en: 'Who cooks your food?', ar: 'مين بيطبخ أكلك؟' }, opts: nutO_([['me', 'Me', 'أنا'], ['family', 'Family / home cooking', 'البيت / العيلة'], ['out', 'Mostly delivery or eating out', 'دليفري أو برا']]) },
      { k: 'cook_time', type: 'one', t: { en: 'Time to prepare food per day', ar: 'وقت التحضير باليوم' }, opts: nutO_([['10', '10 min or less', '10 دقايق أو أقل'], ['30', 'About 30 min', 'حوالي نص ساعة'], ['60', 'I like cooking', 'بحب الطبخ']]) },
      { k: 'out', type: 'one', t: { en: 'Delivery / eating out per week', ar: 'دليفري أو أكل برا بالأسبوع' }, opts: nutO_([['0', 'Rarely', 'نادراً'], ['2', '1 to 2 times', 'مرة لمرتين'], ['4', '3 to 5 times', '3 لـ 5 مرات'], ['7', 'Almost daily', 'تقريباً كل يوم']]) },
      { k: 'budget', type: 'one', t: { en: 'Food budget', ar: 'ميزانية الأكل' }, opts: nutO_([['low', 'Tight, keep it cheap', 'محدودة'], ['mid', 'Normal', 'عادية'], ['high', 'Not an issue', 'مش مشكلة']]) }
    ]},
    { step: 4, t: { en: 'What you eat now', ar: 'شو بتاكل هلق' }, q: [
      { k: 'now_day', type: 'text', max: 400, t: { en: 'Describe a normal day of eating (what and roughly when)', ar: 'خبرنا عن نهار عادي من الأكل' } },
      { k: 'often', type: 'many', t: { en: 'Things you eat a lot of', ar: 'أكلات بتاكلها كتير' }, opts: nutO_([['bread', 'Bread / man2oushe', 'خبز / منقوشة'], ['rice', 'Rice', 'رز'], ['pasta', 'Pasta', 'معكرونة'], ['sweets', 'Sweets / chocolate', 'حلو / شوكولا'], ['chips', 'Chips / snacks', 'شيبس / سناكات'], ['fastfood', 'Fast food', 'فاست فود'], ['fruit', 'Fruit', 'فواكه'], ['dairy', 'Labneh / cheese / laban', 'لبنة / جبنة / لبن'], ['chicken', 'Chicken', 'دجاج'], ['meat', 'Red meat', 'لحمة'], ['fish', 'Fish', 'سمك'], ['eggs', 'Eggs', 'بيض']]) },
      { k: 'love', type: 'many', t: { en: 'Lebanese dishes you love', ar: 'أكلات لبنانية بتحبها' }, opts: nutO_([['tabbouleh', 'Tabbouleh / fattoush', 'تبولة / فتوش'], ['mjadra', 'Mjadra', 'مجدرة'], ['loubieh', 'Loubieh / bamieh / fasoulia', 'لوبية / بامية / فاصوليا'], ['kibbeh', 'Kibbeh', 'كبة'], ['shawarma', 'Shawarma / taouk', 'شاورما / طاووق'], ['grills', 'Mashawi', 'مشاوي'], ['foul', 'Foul / hummus / balila', 'فول / حمص / بليلة'], ['mloukhieh', 'Mloukhieh', 'ملوخية'], ['mehshi', 'Mehshi / warak enab', 'محشي / ورق عنب'], ['manakish', 'Manakish', 'مناقيش'], ['fatteh', 'Fatteh', 'فتة'], ['samke', 'Samke harra / sayadieh', 'سمكة حرة / صيادية']]) },
      { k: 'love_other', type: 'text', max: 150, t: { en: 'Other foods you love', ar: 'أكلات تانية بتحبها' } },
      { k: 'dislike', type: 'text', max: 150, t: { en: 'Foods you do not eat or dislike', ar: 'أكلات ما بتاكلها أو ما بتحبها' } }
    ]},
    { step: 5, t: { en: 'Allergies and rules', ar: 'حساسية وقواعد' }, q: [
      { k: 'allergy', type: 'many', t: { en: 'Allergies or intolerances', ar: 'حساسية أو عدم تحمل' }, opts: nutO_([['none', 'None', 'ولا شي'], ['lactose', 'Lactose', 'لاكتوز'], ['gluten', 'Gluten', 'غلوتين'], ['nuts', 'Nuts', 'مكسرات'], ['peanut', 'Peanuts', 'فول سوداني'], ['eggs', 'Eggs', 'بيض'], ['seafood', 'Fish / seafood', 'سمك / بحريات'], ['sesame', 'Sesame / tahini', 'سمسم / طحينة'], ['soy', 'Soy', 'صويا']]) },
      { k: 'allergy_other', type: 'text', max: 100, t: { en: 'Other allergy', ar: 'حساسية تانية' } },
      { k: 'rules', type: 'many', t: { en: 'Food rules you follow', ar: 'قواعد بتتبعها' }, opts: nutO_([['halal', 'Halal', 'حلال'], ['nopork', 'No pork', 'بلا خنزير'], ['vegetarian', 'Vegetarian', 'نباتي'], ['vegan', 'Vegan', 'نباتي صرف'], ['ramadan', 'I fast in Ramadan', 'بصوم رمضان'], ['lent', 'I fast in Lent', 'بصوم الصوم الكبير']]) },
      { k: 'digest', type: 'many', t: { en: 'Digestion', ar: 'الهضم' }, opts: nutO_([['ok', 'All good', 'تمام'], ['bloat', 'Bloating', 'نفخة'], ['reflux', 'Reflux / heartburn', 'حرقة'], ['ibs', 'IBS / sensitive stomach', 'قولون حساس'], ['const', 'Constipation', 'إمساك']]) }
    ]},
    { step: 6, t: { en: 'Drinks and habits', ar: 'مشروبات وعادات' }, q: [
      { k: 'coffee', type: 'one', t: { en: 'Coffee per day', ar: 'قهوة باليوم' }, opts: nutO_([['0', 'None', 'ولا شي'], ['2', '1 to 2', '1 لـ 2'], ['4', '3+', '3+']]) },
      { k: 'sugar_drinks', type: 'one', t: { en: 'Soft drinks / juice / sweet coffee', ar: 'مشروبات غازية / عصير / قهوة محلاية' }, opts: nutO_([['0', 'Rarely', 'نادراً'], ['1', 'Once a day', 'مرة باليوم'], ['3', 'Several a day', 'كذا مرة']]) },
      { k: 'alcohol', type: 'one', t: { en: 'Alcohol', ar: 'كحول' }, opts: nutO_([['0', 'Never', 'أبداً'], ['1', 'Weekends', 'ويكند'], ['3', 'Several times a week', 'كذا مرة بالأسبوع']]) },
      { k: 'water', type: 'one', t: { en: 'Water per day', ar: 'مي باليوم' }, opts: nutO_([['1', 'Under 1 L', 'أقل من ليتر'], ['2', '1 to 2 L', '1 لـ 2 ليتر'], ['3', '2 L+', 'أكتر من 2']]) },
      { k: 'cravings', type: 'one', t: { en: 'When do cravings hit?', ar: 'إيمتى بتجيك الشهوة للأكل؟' }, opts: nutO_([['none', 'Not really', 'مش كتير'], ['afternoon', 'Afternoon', 'بعد الضهر'], ['night', 'Late night', 'آخر الليل'], ['stress', 'When stressed', 'لما كون متوتر']]) },
      { k: 'weekend', type: 'one', t: { en: 'Weekends', ar: 'الويكند' }, opts: nutO_([['same', 'Same as weekdays', 'متل باقي الأيام'], ['family', 'Big family lunches', 'غدا عيلة كبير'], ['out', 'Out with friends', 'طلعات مع رفقات']]) },
      { k: 'supps', type: 'many', t: { en: 'Supplements you take', ar: 'مكملات بتاخدها' }, opts: nutO_([['none', 'None', 'ولا شي'], ['whey', 'Whey protein', 'بروتين واي'], ['creatine', 'Creatine', 'كرياتين'], ['multi', 'Multivitamin', 'فيتامينات'], ['omega', 'Omega 3', 'أوميغا 3'], ['vitd', 'Vitamin D', 'فيتامين د']]) }
    ]},
    { step: 7, t: { en: 'Your health', ar: 'صحتك' }, note: { en: 'This keeps you safe. A coach will look at your plan personally if any of these apply.', ar: 'هيدا لسلامتك. إذا شي من هول بينطبق عليك، المدرب رح يشوف خطتك شخصياً.' }, q: [
      { k: 'health', type: 'many', t: { en: 'Does any of this apply to you?', ar: 'شي من هول بينطبق عليك؟' }, opts: nutO_([['none', 'None of these', 'ولا شي'], ['pregnant', 'Pregnant or breastfeeding', 'حامل أو عم رضع'], ['diabetes', 'Diabetes or pre-diabetes', 'سكري'], ['kidney', 'Kidney problems', 'مشاكل كلى'], ['liver', 'Liver problems', 'مشاكل كبد'], ['thyroid', 'Thyroid problems', 'مشاكل غدة'], ['meds', 'Medication that changes appetite', 'دوا بيغير الشهية'], ['ed', 'Past eating disorder', 'اضطراب أكل سابقاً']]) }
    ]}
  ];
}
function nutKeys_() { var k = {}; nutQuestions_().forEach(function (s) { s.q.forEach(function (q) { k[q.k] = q; }); }); return k; }

// ---------------------------------------------------------------------
// SHEETS
// ---------------------------------------------------------------------
function nutTabs_(ops) {
  return { intake: appTab_(ops, 'NUTRITION INTAKE', NUT.INTAKE_HEAD), plans: appTab_(ops, 'NUTRITION PLANS', NUT.PLAN_HEAD), weigh: appTab_(ops, 'NUTRITION WEIGHINS', NUT.WEIGH_HEAD) };
}
function nutJ_(s, d) { try { var o = JSON.parse(s || ''); return o == null ? d : o; } catch (e) { return d; } }
function nutNow_() { return Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm'); }
function nutToday_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
function nutRows_(sh, width) { var n = sh.getLastRow(); return n > 1 ? sh.getRange(2, 1, n - 1, width).getValues() : []; }

function nutIntake_(ops, cid) {
  var sh = nutTabs_(ops).intake, v = nutRows_(sh, NUT.INTAKE_HEAD.length);
  for (var i = 0; i < v.length; i++) if (String(v[i][0]).toUpperCase() === cid) {
    return { row: i + 2, answers: nutJ_(v[i][2], {}), step: Number(v[i][3]) || 0, done: String(v[i][4]) === 'Y', ver: Number(v[i][5]) || 0, target: Number(v[i][6]) || 0, comp: nutJ_(v[i][7], {}), flags: String(v[i][8] || '').split(',').filter(String), updated: String(v[i][9]) };
  }
  return { row: 0, answers: {}, step: 0, done: false, ver: 0, target: 0, comp: {}, flags: [], updated: '' };
}
function nutSaveIntake_(ops, cid, it) {
  var sh = nutTabs_(ops).intake, name = (appClientInfo_(cid) || {}).name || cid;
  var row = [cid, name, JSON.stringify(it.answers).slice(0, NUT.CELL), it.step, it.done ? 'Y' : '', it.ver, it.target || '', JSON.stringify(it.comp || {}).slice(0, 2000), (it.flags || []).join(','), nutNow_()];
  if (it.row) sh.getRange(it.row, 1, 1, row.length).setValues([row]); else { sh.appendRow(row); it.row = sh.getLastRow(); }
}

// plan JSON is split over 3 cells (Sheets limit 50,000 characters per cell)
function nutPlanRow_(r, i) {
  return { row: i + 2, id: String(r[0]), cid: String(r[1]).toUpperCase(), name: String(r[2]), created: String(r[3]), status: String(r[4]),
    macros: nutJ_(r[5], null), plan: nutJ_(String(r[6] || '') + String(r[7] || '') + String(r[8] || ''), null), ver: Number(r[9]) || 0,
    weight: Number(r[10]) || 0, target: Number(r[11]) || 0, by: String(r[12] || ''), decided: String(r[13] || ''), note: String(r[14] || ''), error: String(r[15] || '') };
}
function nutPlans_(ops, cid) {
  var all = nutRows_(nutTabs_(ops).plans, NUT.PLAN_HEAD.length).map(nutPlanRow_).filter(function (p) { return p.id; });
  return cid ? all.filter(function (p) { return p.cid === cid; }) : all;
}
function nutSetPlan_(ops, p, fields) {
  var sh = nutTabs_(ops).plans, H = NUT.PLAN_HEAD;
  Object.keys(fields).forEach(function (k) {
    var v = fields[k];
    if (k === 'plan') { var t = JSON.stringify(v || {}); sh.getRange(p.row, 7, 1, 3).setValues([[t.slice(0, NUT.CELL), t.slice(NUT.CELL, NUT.CELL * 2), t.slice(NUT.CELL * 2, NUT.CELL * 3)]]); if (t.length > NUT.CELL * 3) throw new Error('Plan too long'); return; }
    var col = { status: 5, macros: 6, by: 13, decided: 14, note: 15, error: 16 }[k]; if (!col) return;
    sh.getRange(p.row, col).setValue(k === 'macros' ? JSON.stringify(v) : String(v == null ? '' : v).slice(0, 2000));
    p[k] = v;
  });
}
function nutNewPlan_(ops, cid, status, macros, it, weight, by) {
  var sh = nutTabs_(ops).plans, n = Math.max(1, sh.getLastRow()), id = 'NP-' + String(n).padStart(4, '0');
  // older open plans of this client are replaced
  nutPlans_(ops, cid).forEach(function (p) { if (/Queued|Writing|Pending|Coach review|Failed/.test(p.status)) nutSetPlan_(ops, p, { status: 'Replaced' }); });
  sh.appendRow([id, cid, (appClientInfo_(cid) || {}).name || cid, nutNow_(), status, JSON.stringify(macros || {}), '', '', '', it.ver, weight || '', it.target || '', by || '', '', '', '']);
  return nutPlans_(ops, cid).filter(function (p) { return p.id === id; })[0];
}

// ---------------------------------------------------------------------
// THE NUMBERS (code, not AI)
// ---------------------------------------------------------------------
function nutFlags_(age, ans) {
  var f = [], h = ans.health || [];
  if (age && age < 18) f.push('minor');
  ['pregnant', 'ed', 'kidney', 'diabetes', 'thyroid', 'liver', 'meds'].forEach(function (k) { if (h.indexOf(k) > -1) f.push(k); });
  return f;
}
function nutFactor_(ans) {
  var base = { desk: 1.2, mixed: 1.35, active: 1.5 }[ans.job] || 1.25, td = Math.min(5, Number(ans.train_days) || 0);
  return Math.round((base + td * 0.045) * 1000) / 1000;
}
function nutAddDays_(ymd, n) { var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + Math.round(n)); return d.toISOString().slice(0, 10); }
function nutR_(x, k) { k = k || 1; return Math.round(x / k) * k; }

// p: { weight, height, age, sex 'M'|'F', bf (optional %), target, pace 'slow'|'fast', ans }
// returns { ok, blocked, coach, flags, bmr, tdee, kcal, p, c, f, dir, rateKg, projection }
function nutCalc_(p, today) {
  var ans = p.ans || {}, out = { ok: false, flags: nutFlags_(p.age, ans) };
  if (!(p.weight > 25) || !(p.height > 100) || !(p.age > 0) || !p.sex) { out.missing = true; out.msg = 'Add your weight, height, birth year and sex first.'; return out; }
  out.coach = out.flags.some(function (x) { return NUT.STOP.indexOf(x) > -1; });
  if (out.coach) { out.msg = 'A Wellbe coach will set your numbers with you personally.'; return out; }   // no automatic numbers
  var hm = p.height / 100, bmi = p.weight / (hm * hm), target = Number(p.target) || p.weight;
  out.bmi = Math.round(bmi * 10) / 10;
  if (target / (hm * hm) < 18.5) { out.blocked = true; out.msg = 'This target is under a healthy weight for your height. Your coach will set a safe target with you.'; out.safeMin = Math.ceil(18.5 * hm * hm); return out; }
  var lbm = p.bf > 3 && p.bf < 60 ? p.weight * (1 - p.bf / 100) : 0;
  var bmr = lbm ? 370 + 21.6 * lbm : 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'M' ? 5 : -161);
  var tdee = bmr * nutFactor_(ans);
  var diff = target - p.weight, dir = diff < -0.5 ? 'lose' : diff > 0.5 ? 'gain' : 'keep';
  var pace = p.pace === 'fast' ? 'fast' : 'slow';
  var rate = dir === 'lose' ? NUT.LOSS[pace] * p.weight : dir === 'gain' ? NUT.GAIN[pace] * p.weight : 0;   // kg per week
  var kcal = tdee + (dir === 'lose' ? -1 : 1) * rate * NUT.KCAL_PER_KG / 7;
  var floor = Math.max(NUT.FLOOR[p.sex === 'M' ? 'M' : 'F'], bmr * NUT.FLOOR_BMR);
  if (dir === 'lose' && kcal < floor) { kcal = floor; rate = Math.max(0, (tdee - kcal) * 7 / NUT.KCAL_PER_KG); out.floorHit = true; }
  kcal = nutR_(kcal, 10);
  var prot = nutR_(NUT.PROTEIN_PER_KG_GOAL * target, 5), fat = nutR_(kcal * NUT.FAT_PCT / 9, 1), carb = nutR_((kcal - prot * 4 - fat * 9) / 4, 5);
  if (carb < 60) { fat = nutR_(kcal * 0.25 / 9, 1); carb = Math.max(40, nutR_((kcal - prot * 4 - fat * 9) / 4, 5)); }
  out.ok = true; out.dir = dir; out.bmr = Math.round(bmr); out.tdee = Math.round(tdee); out.kcal = kcal; out.p = prot; out.f = fat; out.c = carb;
  out.rateKg = Math.round(rate * 100) / 100; out.method = lbm ? 'Katch-McArdle' : 'Mifflin St Jeor';
  out.weight = p.weight; out.target = target; out.check = out.flags.some(function (x) { return NUT.CHECK.indexOf(x) > -1; });
  out.projection = nutProject_(p.weight, target, rate, dir, today || nutToday_(), Number(ans.train_days) || 3);
  return out;
}
// a RANGE and a date window, never a promise
function nutProject_(w, target, rate, dir, today, td) {
  if (dir === 'keep' || !(rate > 0)) return { dir: 'keep', text: { en: 'Keep your weight and build a stronger shape: follow the plan and train ' + td + ' times a week.', ar: 'حافظ عوزنك وابني جسم أقوى: اتبع الخطة وتمرن ' + td + ' مرات بالأسبوع.' } };
  var gap = Math.abs(target - w), fast = rate * 1.15, slow = rate * 0.8, mid = rate;
  var wk = gap / mid, early = nutAddDays_(today, gap / fast * 7), late = nutAddDays_(today, gap / slow * 7), at = nutAddDays_(today, wk * 7);
  var sign = dir === 'lose' ? -1 : 1, lo = w + sign * wk * slow, hi = w + sign * wk * fast;
  var a = Math.round(Math.min(lo, hi) * 2) / 2, b = Math.round(Math.max(lo, hi) * 2) / 2;
  if (dir === 'lose') a = Math.max(a, target); else b = Math.min(b, target);
  var in4 = Math.round((w + sign * 4 * mid) * 2) / 2, in12 = Math.round((w + sign * Math.min(12 * mid, gap)) * 2) / 2;
  return { dir: dir, weeks: Math.round(wk), at: at, early: early, late: late, low: a, high: b, in4: in4, in12: in12, perWeek: Math.round(mid * 100) / 100,
    text: { en: 'Train ' + td + ' times a week and follow this plan: about ' + a + ' to ' + b + ' kg around ' + nutDay_(at) + '. Most people like you reach ' + target + ' kg between ' + nutDay_(early) + ' and ' + nutDay_(late) + '.',
            ar: 'تمرن ' + td + ' مرات بالأسبوع واتبع الخطة: حوالي ' + a + ' لـ ' + b + ' كيلو تقريباً بـ ' + nutDay_(at, 1) + '. معظم الناس متلك بيوصلوا لـ ' + target + ' كيلو بين ' + nutDay_(early, 1) + ' و ' + nutDay_(late, 1) + '.' } };
}
// '2027-05-03' -> '3 May 2027' / '3 أيار 2027'
function nutDay_(ymd, ar) {
  var m = ar ? ['كانون التاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين التاني', 'كانون الأول'] : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var p = String(ymd).split('-'); return Number(p[2]) + ' ' + m[Number(p[1]) - 1] + ' ' + p[0];
}
function nutProfile_(ops, cid, it, today) {
  var body = typeof woBody_ === 'function' ? woBody_(ops, cid) : { weight: 0, height: 0, birth: 0, sex: '' };
  var yr = Number(String(today || nutToday_()).slice(0, 4));
  var last = nutWeighins_(ops, cid).slice(-1)[0];
  var w = last && (!body.date || last.date >= body.date) ? last.kg : body.weight;
  return { weight: Number(w) || 0, height: body.height, age: body.birth ? yr - body.birth : 0, sex: body.sex, bf: Number((it.comp || {}).bf) || 0, target: it.target, pace: it.answers.pace, ans: it.answers };
}
function nutWeighins_(ops, cid) {
  return nutRows_(nutTabs_(ops).weigh, NUT.WEIGH_HEAD.length).filter(function (r) { return String(r[1]).toUpperCase() === cid; })
    .map(function (r) { return { date: r[0] instanceof Date ? Utilities.formatDate(r[0], CFG.TZ, 'yyyy-MM-dd') : String(r[0]), kg: Number(r[3]) || 0 }; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

// full plan = part of the subscription: a current package (online workout subscriptions join here when they exist)
function nutPaid_(ops, cid) {
  if (!/^C\d+$/.test(cid)) return false;
  return clPkgsOf_(ops, cid, nutToday_()).some(function (p) { return p.phase === 'current' && !/trial|assessment|free/i.test(p.type); });
}

// ---------------------------------------------------------------------
// CLIENT ACTION app_cl_nut  (the client router holds the script lock)
// ---------------------------------------------------------------------
function nutClient_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), op = String(b.op || 'intake_get'), today = nutToday_(), it = nutIntake_(ops, cid), out = {};
  if (op === 'intake_save') {
    var keys = nutKeys_(), a = b.answers || {};
    Object.keys(a).forEach(function (k) {
      var q = keys[k]; if (!q) return; var v = a[k];
      if (q.type === 'many') { var ok = q.opts.map(function (o) { return o.v; }); v = (v || []).filter(function (x) { return ok.indexOf(x) > -1; }).slice(0, 20); if (v.length > 1) v = v.filter(function (x) { return x !== 'none'; }); }
      else if (q.type === 'one') { if (!q.opts.some(function (o) { return o.v === v; })) return; }
      else if (q.type === 'time') { v = /^\d{2}:\d{2}$/.test(String(v)) ? String(v) : ''; }
      else v = clean_(v, q.max || 200);
      it.answers[k] = v;
    });
    it.step = Math.max(it.step, Math.min(7, Number(b.step) || 0));
    if (b.done) { var miss = ['goal', 'job', 'train_days', 'meals', 'allergy', 'health'].filter(function (k) { return it.answers[k] == null || (it.answers[k].length === 0); }); if (miss.length) throw new Error('A few answers are missing: ' + miss.join(', ')); it.done = true; it.ver++; }
    var age0 = nutProfile_(ops, cid, it, today).age; it.flags = nutFlags_(age0, it.answers);
    nutSaveIntake_(ops, cid, it);
  }
  if (op === 'body') {
    var w = Number(b.weight) || 0, h = Number(b.height) || 0, y = Number(b.birth) || 0, sx = b.sex === 'M' || b.sex === 'F' ? b.sex : '', tg = Number(b.target) || 0, yr = Number(today.slice(0, 4));
    if (w && (w < 25 || w > 300)) throw new Error('Check your weight (kg)');
    if (h && (h < 100 || h > 230)) throw new Error('Check your height (cm)');
    if (y && (y < 1920 || y > yr - 8)) throw new Error('Check your birth year');
    if (tg && (tg < 30 || tg > 250)) throw new Error('Check your target weight (kg)');
    if (w || h || y || sx) woTab_(ops, 'CLIENT BODY', WO.BODY_HEAD).appendRow([beirutDate_(today, 0), cid, (appClientInfo_(cid) || {}).name, w || '', h || '', y || '', sx, 'client app']);
    if (b.comp) { var c = b.comp; it.comp = { bf: nutNum_(c.bf, 3, 60), smm: nutNum_(c.smm, 5, 80), visceral: nutNum_(c.visceral, 1, 30), date: /^\d{4}-\d{2}-\d{2}$/.test(String(c.date)) ? c.date : today, file: clean_(c.file, 300) }; }
    var oldT = it.target; if (tg) it.target = tg;
    nutSaveIntake_(ops, cid, it);
    if (tg && oldT && tg !== oldT) out.replan = nutAutoReplan_(ops, cid, it, 'New target ' + tg + ' kg');
  }
  if (op === 'upload') {                                  // body composition report: save it, AI reads the numbers, client confirms with op 'body'
    if (!b.b64) throw new Error('Nothing to upload');
    if (String(b.b64).length > 7000000) throw new Error('File too big: use a photo under 5 MB');
    var mime = String(b.mime || ''); if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(mime)) throw new Error('Upload a photo (JPG / PNG) or a PDF');
    var f = nutSaveFile_(cid, b.b64, mime, b.name);
    out.file = f.url; out.read = nutReadComp_(b.b64, mime);    // { weight, bf, smm, visceral, date } or null
  }
  if (op === 'weigh') {
    var kg = Number(b.kg) || 0; if (kg < 25 || kg > 300) throw new Error('Check the weight (kg)');
    nutTabs_(ops).weigh.appendRow([beirutDate_(today, 0), cid, (appClientInfo_(cid) || {}).name, kg, 'client app']);
    var ap = nutPlans_(ops, cid).filter(function (p) { return p.status === 'Approved'; }).pop();
    if (ap && Math.abs(kg - ap.weight) > NUT.REPLAN_KG) out.replan = nutAutoReplan_(ops, cid, it, 'Weight changed to ' + kg + ' kg');
  }
  if (op === 'generate') {
    if (!nutPaid_(ops, cid)) throw new Error('Your full plan comes with your Wellbe subscription. Message Romy to start.');
    if (!it.done) throw new Error('Finish the questionnaire first.');
    var calc = nutCalc_(nutProfile_(ops, cid, it, today), today);
    if (calc.missing || calc.blocked) throw new Error(calc.msg);
    var open = nutPlans_(ops, cid).filter(function (p) { return /Queued|Writing|Pending|Coach review/.test(p.status); })[0];
    if (open && !b.force) throw new Error('Your plan is already being prepared. A coach checks it before you see it.');
    var pl = nutNewPlan_(ops, cid, calc.coach ? 'Coach review' : 'Queued', calc, it, calc.weight || nutProfile_(ops, cid, it, today).weight, 'client app');
    if (calc.coach) clLog_(ops, cid, pl.name, 'Nutrition plan', pl.name + ' asked for a nutrition plan. Health answers need a coach: build it with them personally (' + it.flags.join(', ') + '). Plan ' + pl.id, '', '', 'New', { plan: pl.id });
    out.status = pl.status;
  }
  // every op answers with the full state of the screen
  var prof = nutProfile_(ops, cid, it, today), calc2 = nutCalc_(prof, today), plans = nutPlans_(ops, cid), last = plans.filter(function (p) { return p.status !== 'Replaced'; }).pop() || null;
  var paid = nutPaid_(ops, cid);
  out.questions = op === 'intake_get' ? nutQuestions_() : undefined;
  out.answers = it.answers; out.step = it.step; out.done = it.done; out.target = it.target; out.comp = it.comp; out.flags = it.flags;
  out.body = { weight: prof.weight, height: prof.height, age: prof.age, sex: prof.sex };
  out.calc = calc2; out.paid = paid; out.weighins = nutWeighins_(ops, cid).slice(-26);
  out.upsell = paid ? '' : 'Get your full plan (meals, portions, grocery list) with your Wellbe subscription.';
  if (last) {
    out.plan = { id: last.id, status: last.status, created: last.created, note: last.note };
    if (last.status === 'Approved' && paid) { out.plan.data = last.plan; out.plan.macros = last.macros; }
  }
  return out;
}
function nutNum_(v, lo, hi) { var n = Math.round((Number(v) || 0) * 10) / 10; return n >= lo && n <= hi ? n : 0; }
function nutAutoReplan_(ops, cid, it, why) {
  if (!nutPaid_(ops, cid) || !it.done) return '';
  var calc = nutCalc_(nutProfile_(ops, cid, it, nutToday_()), nutToday_()); if (!calc.ok) return '';
  var pl = nutNewPlan_(ops, cid, 'Queued', calc, it, calc.weight, 'auto: ' + why);
  return pl.id;
}
function nutSaveFile_(cid, b64, mime, name) {
  var info = appClientInfo_(cid) || {}, root = appFolder_(), sub = cid + ' ' + clean_(info.name || '', 80), fit = root.getFoldersByName(sub);
  var folder = fit.hasNext() ? fit.next() : root.createFolder(sub);
  var f = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, clean_(name, 120) || ('body-composition-' + nutToday_())));
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), sh = appTab_(ops, 'CLIENT FILES', ['Client ID', 'Client', 'File', 'Link', 'Type', 'Uploaded by', 'Date']);
  sh.appendRow([cid, info.name || '', f.getName(), f.getUrl(), 'Body composition', 'client app', beirutDate_(nutToday_(), 0)]);
  return { url: f.getUrl() };
}

// ---------------------------------------------------------------------
// AI (Anthropic API). Key in Script Properties, never in the code.
// ---------------------------------------------------------------------
function nutModel_() { return PropertiesService.getScriptProperties().getProperty('NUTRITION_MODEL') || 'claude-sonnet-5-5'; }
function nutAI_(system, content, maxTokens) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY'); if (!key) throw new Error('ANTHROPIC_KEY missing in Script Properties');
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: nutModel_(), max_tokens: maxTokens || 6000, system: system, messages: [{ role: 'user', content: content }] }) });
  if (r.getResponseCode() !== 200) throw new Error('AI ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return (JSON.parse(r.getContentText()).content || []).map(function (c) { return c.text || ''; }).join('');
}
function nutJSON_(txt) { var a = txt.indexOf('{'), z = txt.lastIndexOf('}'); if (a < 0 || z < a) throw new Error('No JSON from AI'); return JSON.parse(txt.slice(a, z + 1)); }

// InBody / body composition photo or PDF -> numbers (the client confirms them)
function nutReadComp_(b64, mime) {
  try {
    var part = mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: mime, data: b64 } } : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
    var txt = nutAI_('You read body composition reports (InBody, Tanita and similar). Answer ONLY with JSON: {"weight":kg or null,"bf":body fat percent or null,"smm":skeletal muscle mass kg or null,"visceral":visceral fat level or null,"date":"yyyy-mm-dd" or null}. Use only numbers printed on the report. Never guess.',
      [part, { type: 'text', text: 'Read this report.' }], 300);
    var j = nutJSON_(txt);
    return { weight: nutNum_(j.weight, 25, 300), bf: nutNum_(j.bf, 3, 60), smm: nutNum_(j.smm, 5, 80), visceral: nutNum_(j.visceral, 1, 30), date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date)) ? j.date : '' };
  } catch (e) { Logger.log('comp read failed: ' + e); return null; }
}

var NUT_ALLERGEN_WORDS = {
  lactose: ['milk', 'cheese', 'labneh', 'laban', 'yogurt', 'yoghurt', 'cream', 'butter', 'halloumi', 'akkawi', 'feta', 'kashkaval', 'shanklish', 'mozzarella', 'whey'],
  gluten: ['bread', 'wheat', 'pasta', 'bulgur', 'burghul', 'freekeh', 'kaak', "ka'ak", 'manakish', 'manoushe', 'pita', 'flour', 'couscous', 'barley', 'toast', 'wrap', 'tortilla', 'kibbeh', 'noodle', 'cracker', 'oats'],
  nuts: ['almond', 'walnut', 'cashew', 'pistachio', 'hazelnut', 'pine nut', 'pecan', 'nut butter'],
  peanut: ['peanut'],
  eggs: ['egg', 'omelet', 'omelette', 'mayonnaise'],
  seafood: ['fish', 'tuna', 'salmon', 'shrimp', 'prawn', 'sardine', 'hamour', 'sea bass', 'calamari', 'squid', 'crab', 'lobster', 'samke', 'sayadieh'],
  sesame: ['sesame', 'tahini', 'tahina', 'hummus', 'baba ghanouj', 'moutabal', 'zaatar', "za'atar", 'halawa'],
  soy: ['soy', 'tofu', 'edamame']
};
// rules -> words that must not appear
var NUT_RULE_WORDS = { nopork: ['pork', 'ham', 'bacon', 'salami', 'pepperoni'], halal: ['pork', 'ham', 'bacon', 'wine', 'beer'], vegetarian: ['chicken', 'beef', 'lamb', 'meat', 'kafta', 'shawarma', 'tawouk', 'fish', 'tuna', 'salmon', 'shrimp', 'turkey', 'liver'], vegan: ['chicken', 'beef', 'lamb', 'meat', 'fish', 'tuna', 'egg', 'milk', 'cheese', 'labneh', 'laban', 'yogurt', 'honey', 'whey', 'butter'] };

// checks the AI plan in code: macros per day, allergens, rules, dislikes. Returns a list of problems ([] = good).
function nutValidate_(plan, m, ans) {
  var errs = [], ban = [], words = [];
  (ans.allergy || []).forEach(function (a) { (NUT_ALLERGEN_WORDS[a] || []).forEach(function (w) { ban.push([w, a]); }); });
  (ans.rules || []).forEach(function (r) { (NUT_RULE_WORDS[r] || []).forEach(function (w) { ban.push([w, r]); }); });
  String(ans.allergy_other || '').toLowerCase().split(/[,;\/\n]+| and /).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 2; }).forEach(function (w) { ban.push([w, 'allergy']); });
  String(ans.dislike || '').toLowerCase().split(/[,;\/\n]+| and /).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 2; }).forEach(function (w) { words.push(w); });
  if (!plan || !plan.days || !plan.days.length) return ['No days in the plan'];
  plan.days.forEach(function (d, di) {
    var t = { kcal: 0, p: 0, c: 0, f: 0 }, dn = 'Day ' + (di + 1);
    (d.meals || []).forEach(function (ml) {
      if (!ml.items || !ml.items.length) errs.push(dn + ': a meal has no items');
      var mn = String((ml.name || {}).en || '').toLowerCase();
      ban.forEach(function (b) { if (mn.indexOf(b[0]) > -1 && !nutOkWord_(mn, b)) errs.push(dn + ': meal "' + (ml.name || {}).en + '" breaks "' + b[1] + '"'); });
      (ml.items || []).forEach(function (x) {
        ['kcal', 'p', 'c', 'f', 'g'].forEach(function (k) { x[k] = Number(x[k]) || 0; });
        if (!(x.g > 0)) errs.push(dn + ': ' + ((x.food || {}).en || '?') + ' has no portion');
        var calc = x.p * 4 + x.c * 4 + x.f * 9;
        if (x.kcal > 40 && Math.abs(calc - x.kcal) / x.kcal > 0.2) errs.push(dn + ': ' + ((x.food || {}).en || '?') + ' kcal does not match its macros');
        t.kcal += x.kcal; t.p += x.p; t.c += x.c; t.f += x.f;
        var name = String((x.food || {}).en || '').toLowerCase() + ' ' + (x.allergens || []).join(' ').toLowerCase();
        ban.forEach(function (b) { if (name.indexOf(b[0]) > -1 && !nutOkWord_(name, b)) errs.push(dn + ': ' + ((x.food || {}).en || '?') + ' breaks "' + b[1] + '"'); });
        var food = String((x.food || {}).en || '').toLowerCase();
        words.forEach(function (w) { if (food.indexOf(w) > -1) errs.push(dn + ': ' + ((x.food || {}).en || '?') + ' is a food they dislike (' + w + ')'); });
      });
    });
    ['kcal', 'p', 'c', 'f'].forEach(function (k) {
      var want = k === 'kcal' ? m.kcal : m[k];
      if (want && Math.abs(t[k] - want) / want > NUT.TOL[k]) errs.push(dn + ': ' + k + ' is ' + Math.round(t[k]) + ', needs ' + want + ' (within ' + Math.round(NUT.TOL[k] * 100) + '%)');
    });
    d.totals = { kcal: Math.round(t.kcal), p: Math.round(t.p), c: Math.round(t.c), f: Math.round(t.f) };
  });
  return errs.filter(function (x, i) { return errs.indexOf(x) === i; });
}

// 'lactose free milk', 'gluten free bread', 'almond milk' are fine
function nutOkWord_(name, b) {
  if (b[1] === 'lactose' && /lactose[- ]free|plant|almond milk|oat milk|soy milk|coconut milk/.test(name)) return true;
  if (b[1] === 'gluten' && /gluten[- ]free/.test(name)) return true;
  if (b[1] === 'vegan' && /plant|almond milk|oat milk|soy milk|coconut milk|vegan/.test(name)) return true;
  if (b[1] === 'nuts' && b[0] === 'nut butter' && /peanut/.test(name)) return true;   // peanut is its own allergy
  if (b[1] === 'eggs' && /eggplant/.test(name)) return true;
  return false;
}
// grocery list is added up in code from the portions: A B C D A B C over the week
function nutGrocery_(plan) {
  var by = {}, n = plan.days.length;
  NUT.WEEK.forEach(function (di) {
    var d = plan.days[di % n]; if (!d) return;
    (d.meals || []).forEach(function (ml) { (ml.items || []).forEach(function (x) {
      var k = String((x.food || {}).en || '').toLowerCase().trim(); if (!k) return;
      var e = by[k] = by[k] || { en: x.food.en, ar: (x.food || {}).ar || '', aisle: x.aisle || 'other', g: 0, unit: x.unit || 'g' };
      e.g += Number(x.g) || 0;
    }); });
  });
  var aisles = { produce: { en: 'Fruit and vegetables', ar: 'خضرة وفواكه' }, meat: { en: 'Meat, chicken, fish', ar: 'لحمة، دجاج، سمك' }, dairy: { en: 'Dairy and eggs', ar: 'ألبان وبيض' }, bakery: { en: 'Bread and grains', ar: 'خبز وحبوب' }, pantry: { en: 'Pantry', ar: 'مونة' }, frozen: { en: 'Frozen', ar: 'مجلدات' }, drinks: { en: 'Drinks', ar: 'مشروبات' }, other: { en: 'Other', ar: 'غيرها' } };
  var out = {};
  Object.keys(by).forEach(function (k) {
    var e = by[k], a = aisles[e.aisle] ? e.aisle : 'other', g = e.g;
    var q = e.unit === 'ml' ? (g >= 1000 ? (Math.ceil(g / 250) / 4) + ' L' : Math.ceil(g / 50) * 50 + ' ml') : (g >= 1000 ? (Math.ceil(g / 250) / 4) + ' kg' : Math.ceil(g / 50) * 50 + ' g');
    (out[a] = out[a] || { aisle: aisles[a], items: [] }).items.push({ en: e.en, ar: e.ar, qty: q });
  });
  return Object.keys(aisles).filter(function (a) { return out[a]; }).map(function (a) { out[a].items.sort(function (x, y) { return x.en < y.en ? -1 : 1; }); return out[a]; });
}

function nutSystem_() {
  return 'You are the head nutrition coach at Wellbe Health Center in Lebanon (physiotherapy and semi-private training). ' +
    'You turn calorie and macro targets that are ALREADY CALCULATED into a practical meal plan. Never change the targets. ' +
    'Rules: use foods easy to buy in Lebanon and Lebanese home dishes the client likes; respect every allergy, intolerance, food rule and dislike with zero exceptions; ' +
    'match the meals per day, breakfast habit, training time (carbs around training), cooking time, who cooks, budget and eating-out habits; ' +
    'give exact portions in grams (or ml for liquids) AND a household measure (cups, spoons, pieces, palm, hand); per item give kcal, protein p, carbs c, fat f in grams, consistent with standard food tables; ' +
    'each day must hit the daily targets: kcal and protein within 4%, carbs and fat within 8%; ' +
    'one realistic swap per meal with the same macros; short, warm, simple coaching notes; no medical claims, no supplements beyond what they already take, no extreme foods. ' +
    'All text in English and Lebanese-friendly Arabic. Answer ONLY with JSON, no markdown.';
}
function nutSchema_() {
  return '{"days":[{"name":{"en":"","ar":""},"meals":[{"slot":"breakfast|lunch|dinner|snack","time":"HH:MM","name":{"en":"","ar":""},' +
    '"items":[{"food":{"en":"","ar":""},"g":0,"unit":"g|ml","measure":{"en":"","ar":""},"kcal":0,"p":0,"c":0,"f":0,"aisle":"produce|meat|dairy|bakery|pantry|frozen|drinks|other","allergens":[]}],' +
    '"swap":{"en":"","ar":""}}]}],"notes":{"en":["",""],"ar":["",""]}}';
}
function nutBrief_(m, ans, comp) {
  return { targets_per_day: { kcal: m.kcal, protein_g: m.p, carbs_g: m.c, fat_g: m.f }, goal: ans.goal, why: ans.why, pace: ans.pace, event: ans.event,
    job: ans.job, train_days: ans.train_days, train_time: ans.train_time, wake: ans.wake, sleep_h: ans.sleep, meals: ans.meals, breakfast: ans.breakfast,
    cook: ans.cook, cook_time_min: ans.cook_time, eat_out_per_week: ans.out, budget: ans.budget, eats_now: ans.now_day, eats_a_lot: ans.often,
    loves: (ans.love || []).concat(ans.love_other ? [ans.love_other] : []), dislikes: ans.dislike, allergies: (ans.allergy || []).concat(ans.allergy_other ? [ans.allergy_other] : []),
    rules: ans.rules, digestion: ans.digest, coffee: ans.coffee, sugary_drinks: ans.sugar_drinks, alcohol: ans.alcohol, water_l: ans.water, cravings: ans.cravings,
    weekend: ans.weekend, supplements: ans.supps, body_fat_pct: comp && comp.bf || null };
}
// 2 AI calls of 2 days each (stays well inside Apps Script time limits), then checked; one retry with the problems listed
function nutWrite_(m, ans, comp) {
  var brief = JSON.stringify(nutBrief_(m, ans, comp)), days = [], notes = null;
  [[1, 2], [3, 4]].forEach(function (pair, k) {
    var ask = 'Client brief: ' + brief + '\n\nWrite day templates ' + pair.join(' and ') + ' of 4 (they rotate over the week, so make them clearly different' +
      (days.length ? ' from these meals: ' + days.map(function (d) { return (d.meals || []).map(function (x) { return (x.name || {}).en; }).join(', '); }).join(' | ') : '') + ').' +
      (k === 0 ? ' Include 4 to 6 coaching notes.' : ' Notes can be empty.') + '\nJSON shape: ' + nutSchema_();
    var got = null, errs = [];
    for (var tryN = 0; tryN < 2 && !got; tryN++) {
      var txt = nutAI_(nutSystem_(), tryN === 0 ? ask : ask + '\n\nYour last answer had these problems, fix all of them: ' + errs.slice(0, 15).join('; '), 7000);
      try { var j = nutJSON_(txt); errs = nutValidate_(j, m, ans); if (!errs.length) got = j; } catch (e) { errs = ['Invalid JSON: ' + e.message]; }
    }
    if (!got) throw new Error('Plan did not pass the checks: ' + errs.slice(0, 5).join('; '));
    days = days.concat(got.days.slice(0, 2)); if (k === 0) notes = got.notes;
  });
  var plan = { days: days, notes: notes || { en: [], ar: [] }, macros: { kcal: m.kcal, p: m.p, c: m.c, f: m.f }, week: NUT.WEEK, made: nutNow_(), model: nutModel_() };
  plan.grocery = nutGrocery_(plan);
  return plan;
}

// ---------------------------------------------------------------------
// WORKER: every minute, writes one queued plan (outside the request, so nobody waits)
// ---------------------------------------------------------------------
function nutWorker() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), lock = LockService.getScriptLock(), job = null, it = null;
  if (!lock.tryLock(20000)) return;
  try {
    var all = nutPlans_(ops, null), now = Date.now();
    all.forEach(function (p) { if (p.status === 'Writing' && now - nutParse_(p.created) > 15 * 60000) nutSetPlan_(ops, p, { status: 'Queued' }); });   // stuck: try again
    job = all.filter(function (p) { return p.status === 'Queued'; })[0];
    if (!job) return;
    nutSetPlan_(ops, job, { status: 'Writing' });
    it = nutIntake_(ops, job.cid);
  } finally { lock.releaseLock(); }
  var plan = null, err = '';
  try { plan = nutWrite_(job.macros, it.answers, it.comp); } catch (e) { err = String(e.message || e); }
  lock.waitLock(30000);
  try {
    if (plan) {
      nutSetPlan_(ops, job, { plan: plan, status: 'Pending', error: '' });
      clLog_(ops, job.cid, job.name, 'Nutrition plan', 'Nutrition plan ready to check for ' + job.name + ': ' + job.macros.kcal + ' kcal, P ' + job.macros.p + ' g, C ' + job.macros.c + ' g, F ' + job.macros.f + ' g' + (it.flags.length ? '. Health answers: ' + it.flags.join(', ') + ', check carefully.' : '.') + ' Approve it in the staff app to send it to the client. Plan ' + job.id, '', '', 'New', { plan: job.id });
    } else {
      nutSetPlan_(ops, job, { status: 'Failed', error: err });
      clLog_(ops, job.cid, job.name, 'Nutrition plan', 'The AI could not write a plan for ' + job.name + ' (' + err.slice(0, 200) + '). Regenerate it or build it by hand. Plan ' + job.id, '', '', 'New', { plan: job.id });
    }
    if (typeof appBump_ === 'function') appBump_();
  } finally { lock.releaseLock(); }
}
function nutParse_(s) { var m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/.exec(String(s)); return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])).getTime() : 0; }

// ---------------------------------------------------------------------
// STAFF ACTIONS (App.gs router): trainers only see their own clients
// ---------------------------------------------------------------------
function nutCanSee_(ops, me, cid) {
  if (me.role !== 'trainer') return true;
  var today = nutToday_(), list = (woSessByClient_(ops, appShift_(today, -WO.SEE_DAYS), appShift_(today, WO.AHEAD), woPkgCid_(ops))[cid]) || [];
  return woCanSee_(me, list, today);
}
function nutList_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), out = [];
  nutPlans_(ops, null).forEach(function (p) {
    if (!/Pending|Coach review|Failed/.test(p.status) && !b.all) return;
    if (!nutCanSee_(ops, me, p.cid)) return;
    out.push({ id: p.id, cid: p.cid, name: p.name, status: p.status, created: p.created, kcal: (p.macros || {}).kcal, p: (p.macros || {}).p, c: (p.macros || {}).c, f: (p.macros || {}).f, error: p.error });
  });
  return { plans: out.reverse().slice(0, 100) };
}
function nutGet_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid || '').toUpperCase();
  if (!nutCanSee_(ops, me, cid)) throw new Error('This client is not one of yours');
  var it = nutIntake_(ops, cid), prof = nutProfile_(ops, cid, it, nutToday_()), plans = nutPlans_(ops, cid);
  var p = b.id ? plans.filter(function (x) { return x.id === b.id; })[0] : plans.filter(function (x) { return x.status !== 'Replaced'; }).pop();
  return { cid: cid, name: (appClientInfo_(cid) || {}).name, answers: it.answers, flags: it.flags, comp: it.comp, target: it.target, body: { weight: prof.weight, height: prof.height, age: prof.age, sex: prof.sex },
    calc: nutCalc_(prof, nutToday_()), plan: p || null, weighins: nutWeighins_(ops, cid).slice(-26), paid: nutPaid_(ops, cid), questions: nutQuestions_() };
}
// act: approve | note | regen | decline   (+ note text; regen can take kcal/p/c/f overrides from the coach)
function nutDecide_(b, me) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), cid = String(b.cid || '').toUpperCase();
  if (!nutCanSee_(ops, me, cid)) throw new Error('This client is not one of yours');
  var p = nutPlans_(ops, cid).filter(function (x) { return x.id === String(b.id); })[0]; if (!p) throw new Error('Plan not found, refresh');
  var act = String(b.act), note = clean_(b.note, 500), at = nutNow_();
  if (act === 'approve') { if (!p.plan) throw new Error('This plan has no meals yet'); nutSetPlan_(ops, p, { status: 'Approved', by: me.name, decided: at, note: note || p.note }); nutCloseReq_(ops, p.id, me, 'Done'); }
  else if (act === 'decline') { nutSetPlan_(ops, p, { status: 'Declined', by: me.name, decided: at, note: note }); nutCloseReq_(ops, p.id, me, 'Declined'); }
  else if (act === 'note') { nutSetPlan_(ops, p, { note: note }); }
  else if (act === 'regen') {
    var m = p.macros || {}; ['kcal', 'p', 'c', 'f'].forEach(function (k) { var v = Number(b[k]); if (v > 0) m[k] = Math.round(v); });
    if (m.kcal < 900) throw new Error('Calories too low');
    var it = nutIntake_(ops, cid); if (note) it.answers.coach_note = note;
    nutSaveIntake_(ops, cid, it);
    nutCloseReq_(ops, p.id, me, 'Done');
    var np = nutNewPlan_(ops, cid, 'Queued', m, it, p.weight, me.name);
    return { id: np.id, status: 'Queued' };
  } else throw new Error('Unknown action');
  return { id: p.id, status: p.status };
}
// the matching To do item in CLIENT REQUESTS
function nutCloseReq_(ops, planId, me, status) {
  var sh = appTab_(ops, 'CLIENT REQUESTS', CL.REQ_HEAD), v = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, CL.REQ_HEAD.length).getValues() : [];
  for (var i = 0; i < v.length; i++) if (String(v[i][4]) === 'Nutrition plan' && String(v[i][8]) === 'New' && nutJ_(v[i][11], {}).plan === planId)
    sh.getRange(i + 2, 9, 1, 3).setValues([[status, me.name, nutNow_()]]);
}
// called from appReqDone_ when Romy taps done / accept / decline on a Nutrition plan item
function nutFromReq_(q, b, me) {
  var p = nutPlans_(SpreadsheetApp.openById(CFG.OPS_ID), q.cid).filter(function (x) { return x.id === (q.data || {}).plan; })[0];
  if (!p) return {};
  if (b.act === 'decline') nutSetPlan_(SpreadsheetApp.openById(CFG.OPS_ID), p, { status: 'Declined', by: me.name, decided: nutNow_() });
  else if (p.plan && p.status === 'Pending') nutSetPlan_(SpreadsheetApp.openById(CFG.OPS_ID), p, { status: 'Approved', by: me.name, decided: nutNow_() });
  return { plan: p.id, status: p.status };
}

// ---------------------------------------------------------------------
// ONE TIME + TESTS
// ---------------------------------------------------------------------
function nutSetup() {
  nutTabs_(SpreadsheetApp.openById(CFG.OPS_ID));
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'nutWorker') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('nutWorker').timeBased().everyMinutes(1).create();
  Logger.log('Nutrition tabs ready, worker runs every minute. AI key set: ' + !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY'));
}
function nutTest() {
  var t = nutToday_(), ans = { job: 'desk', train_days: '3', pace: 'slow', health: ['none'] };
  [{ weight: 95, height: 180, age: 38, sex: 'M', target: 82 }, { weight: 62, height: 163, age: 34, sex: 'F', target: 56, bf: 32 }, { weight: 70, height: 168, age: 29, sex: 'F', target: 74 }]
    .forEach(function (p) { p.ans = ans; p.pace = 'slow'; var c = nutCalc_(p, t); Logger.log(JSON.stringify({ in: p.weight + '>' + p.target, kcal: c.kcal, p: c.p, c: c.c, f: c.f, proj: c.projection.text.en })); });
}
