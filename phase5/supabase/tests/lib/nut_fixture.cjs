// Nutrition test fixture: a realistic Lebanese desk worker building muscle (3,120 kcal, the owner's example) and a
// hand-written plan in the exact shape the AI must answer with (functions/nutrition-worker/plan.ts schema):
// 4 breakfast options + 4 snack options (the owner's example sets), 4 lunch/dinner pairs (A Mon-Tue, B Wed-Thu,
// C Fri-Sat, D Sun) from 2 prep sessions (main: chicken, kafta, rice, potatoes; top-up: chicken, salmon, bulgur,
// sweet potato), at most 3 ingredients a meal, a raw cucumber and tomato side, one ready-made tabbouleh a week.
// Item numbers come from standard food tables (per 100 g), so every item's kcal matches its macros.
// Used as the "mocked AI" in the tests and for sample-plan.json. No restaurant dishes are made up here:
// the library seed in 0012 holds only dishes found on real pages.

// per 100 g (or 100 ml): kcal, protein, carbs, fat
const F = {
  egg:      { en: 'Boiled eggs', ar: 'بيض مسلوق', buy: ['Eggs', 'بيض'], v: [143, 12.6, 0.7, 9.5], aisle: 'dairy', state: 'cooked' },
  bread:    { en: 'Whole wheat Arabic bread', ar: 'خبز عربي أسمر', buy: ['Whole wheat Lebanese bread', 'خبز لبناني أسمر'], v: [250, 9, 50, 1.7], aisle: 'bakery', state: 'ready' },
  veg:      { en: 'Tomato and cucumber', ar: 'بندورة وخيار', buy: ['Tomatoes and cucumbers', 'بندورة وخيار'], v: [17, 0.8, 3.7, 0.15], aisle: 'produce', state: 'raw', role: 'veg' },
  lettom:   { en: 'Lettuce and tomato', ar: 'خس وبندورة', buy: ['Lettuce and tomatoes', 'خس وبندورة'], v: [17, 1, 3.4, 0.2], aisle: 'produce', state: 'raw', role: 'veg' },
  oats:     { en: 'Rolled oats', ar: 'شوفان', buy: ['Rolled oats', 'شوفان'], v: [389, 16.9, 66.3, 6.9], aisle: 'grains', state: 'raw' },
  milk:     { en: 'Low fat milk', ar: 'حليب قليل الدسم', buy: ['Low fat milk', 'حليب قليل الدسم'], v: [47, 3.4, 4.8, 1.5], aisle: 'dairy', state: 'ready', unit: 'ml' },
  pb:       { en: 'Peanut butter', ar: 'زبدة فستق', buy: ['Peanut butter', 'زبدة فستق'], v: [588, 25, 20, 50], aisle: 'canned', state: 'ready' },
  labneh:   { en: 'Light labneh', ar: 'لبنة لايت', buy: ['Light labneh', 'لبنة لايت'], v: [110, 10, 5, 5], aisle: 'dairy', state: 'ready' },
  halloumi: { en: 'Halloumi', ar: 'حلوم', buy: ['Halloumi', 'حلوم'], v: [321, 21, 2, 26], aisle: 'dairy', state: 'ready' },
  whey:     { en: 'Whey protein (1 scoop)', ar: 'بروتين واي (سكوب)', buy: ['Whey protein', 'بروتين واي'], v: [400, 80, 10, 5], aisle: 'other', state: 'ready' },
  banana:   { en: 'Banana', ar: 'موزة', buy: ['Bananas', 'موز'], v: [89, 1.1, 22.8, 0.3], aisle: 'produce', state: 'raw' },
  greek0:   { en: 'Greek yogurt 0%', ar: 'لبن يوناني 0%', buy: ['Greek yogurt 0%', 'لبن يوناني 0%'], v: [59, 10.3, 3.6, 0.4], aisle: 'dairy', state: 'ready' },
  dates:    { en: 'Dates', ar: 'تمر', buy: ['Dates', 'تمر'], v: [282, 2.5, 75, 0.4], aisle: 'canned', state: 'ready' },
  almond:   { en: 'Almonds', ar: 'لوز', buy: ['Almonds', 'لوز'], v: [579, 21, 22, 50], aisle: 'canned', state: 'ready' },
  tuna:     { en: 'Tuna in water, drained', ar: 'تونة بالمي مصفاية', buy: ['Tuna in water', 'تونة بالمي'], v: [116, 25.5, 0, 0.8], aisle: 'canned', state: 'ready' },
  chicken:  { en: 'Grilled chicken breast (taouk)', ar: 'صدر دجاج مشوي (طاووق)', buy: ['Chicken breast', 'صدر دجاج'], v: [165, 31, 0, 3.6], aisle: 'meat', state: 'cooked', role: 'protein' },
  kafta:    { en: 'Lean beef kafta', ar: 'كفتة لحمة هبرة', buy: ['Lean minced beef', 'لحمة مفرومة هبرة'], v: [217, 26, 0, 12], aisle: 'meat', state: 'cooked', role: 'protein' },
  salmon:   { en: 'Oven salmon fillet', ar: 'فيليه سلمون بالفرن', buy: ['Salmon fillet', 'فيليه سلمون'], v: [206, 22, 0, 12.4], aisle: 'fish', state: 'cooked', role: 'protein' },
  rice:     { en: 'White rice', ar: 'رز أبيض', buy: ['Rice', 'رز'], v: [130, 2.7, 28, 0.3], aisle: 'grains', state: 'cooked', role: 'carb' },
  potato:   { en: 'Oven potatoes', ar: 'بطاطا بالفرن', buy: ['Potatoes', 'بطاطا'], v: [87, 1.9, 20, 0.1], aisle: 'produce', state: 'cooked', role: 'carb' },
  bulgur:   { en: 'Bulgur', ar: 'برغل', buy: ['Bulgur', 'برغل'], v: [83, 3.1, 18.6, 0.2], aisle: 'grains', state: 'cooked', role: 'carb' },
  sweetpot: { en: 'Baked sweet potato', ar: 'بطاطا حلوة بالفرن', buy: ['Sweet potatoes', 'بطاطا حلوة'], v: [90, 2, 20.7, 0.2], aisle: 'produce', state: 'cooked', role: 'carb' },
  tabbouleh:{ en: 'Tabbouleh (ready-made)', ar: 'تبولة (جاهزة)', buy: ['Tabbouleh, ready-made', 'تبولة جاهزة'], v: [120, 2.5, 11, 7.5], aisle: 'produce', state: 'ready', role: 'veg', ready: true },
  oil:      { en: 'Olive oil', ar: 'زيت زيتون', buy: ['Olive oil', 'زيت زيتون'], v: [884, 0, 0, 100], aisle: 'pantry', state: 'raw', unit: 'ml' },
};
const r1 = x => Math.round(x * 10) / 10;
// raw vegetable sides: what they are made of (for the grocery list)
const ING = { veg: [['Tomatoes', 'بندورة', 50, 'produce'], ['Cucumbers', 'خيار', 50, 'produce']], lettom: [['Lettuce', 'خس', 50, 'produce'], ['Tomatoes', 'بندورة', 50, 'produce']] };
const ALG = { bread: ['gluten'], egg: ['eggs'], labneh: ['lactose'], halloumi: ['lactose'], milk: ['lactose'], whey: ['lactose'], greek0: ['lactose'], pb: ['peanut'], almond: ['nuts'], oats: ['gluten'], tuna: ['seafood'], salmon: ['seafood'], bulgur: ['gluten'], tabbouleh: ['gluten'] };
// one item: food key, grams, household measure
function it(k, g, en, ar) {
  const f = F[k], m = g / 100;
  const o = { food: { en: f.en, ar: f.ar }, buy: { en: f.buy[0], ar: f.buy[1] }, g, unit: f.unit || 'g', state: f.state, measure: { en, ar },
    kcal: Math.round(f.v[0] * m), p: r1(f.v[1] * m), c: r1(f.v[2] * m), f: r1(f.v[3] * m), aisle: f.aisle, allergens: ALG[k] || [], ready_made: !!f.ready };
  if (f.role) o.role = f.role;
  if (ING[k]) o.ingredients = ING[k].map(x => ({ buy: { en: x[0], ar: x[1] }, g: Math.round(x[2] * m * 10) / 10, unit: 'g', aisle: x[3] }));
  return o;
}
const opt = (en, ar, items) => ({ name: { en, ar }, items });
const meal = (en, ar, method, items, swap) => ({ name: { en, ar }, method, items, swap });
const sw = (en, ar, method, items) => ({ name: { en, ar }, method, items });
const oil = (ml) => it('oil', ml, ml >= 15 ? Math.round(ml / 5) + ' teaspoons' : ml > 5 ? '2 teaspoons' : '1 teaspoon', ml >= 15 ? Math.round(ml / 5) + ' ملاعق صغار' : ml > 5 ? 'ملعقتين صغار' : 'ملعقة صغيرة');
const side = () => it('veg', 150, '1 tomato and 1 cucumber', 'بندورة وخيارة');

// The sample client: Ziad, 30, desk job (accountant in Beirut), 96 kg, 190 cm, building muscle to 100 kg (steady),
// trains 5 evenings a week, 3 meals + 1 snack, main prep Sunday 11:00, salad 1 to 2 times a week, no pork,
// dislikes mushrooms, takes whey, out with friends Friday night (sometimes drinks), Sunday family lunch.
const profile = {
  body: { weight: 96, height: 190, birth: 1996, sex: 'M', target: 100 },
  answers: {
    goal: 'gain', why: 'I sit all day at work and want to get stronger and fix my posture', pace: 'slow', event: '',
    job: 'desk', train_days: '5', train_time: 'pm', wake: '07:00', bed: '23:30', sleep: '6',
    meals: '3s', breakfast: 'yes', cook: 'me', skill: 'ok', cook_time: '30', out: '2', budget: 'mid', household: '1', salad_freq: 'few_week', prep_day: 'sun', prep_time: '11:00',
    social: ['fri_night', 'family_lunch'], social_drinks: 'sometimes', restaurants: 'Zaatar w Zeit, Roadster Diner, Kababji',
    now_day: 'Manoushe at 9, shawarma or a sandwich at work, big dinner at home late',
    often: ['bread', 'rice', 'chicken', 'meat', 'dairy', 'eggs'], love: ['grills', 'shawarma', 'tabbouleh', 'foul'], style: ['lebanese', 'protein'],
    love_other: 'salmon', dislike: 'mushrooms',
    allergy: ['none'], allergy_other: '', rules: ['nopork'], digest: ['ok'],
    coffee: '2', sugar_drinks: '0', alcohol: '1', water: '2', cravings: 'night', weekend: 'family', supps: ['whey'], health: ['none'],
  },
};

// the owner's example option sets (about 790 kcal and 38 g protein; about 390 kcal and 37 g protein)
function fixed() {
  return [
    { slot: 'breakfast', options: [
      opt('3 eggs, 2 loaves whole wheat bread, tomato and cucumber', '3 بيضات، رغيفين خبز أسمر، بندورة وخيار', [it('egg', 150, '3 eggs', '3 بيضات'), it('bread', 200, '2 loaves', 'رغيفين'), side(), oil(5)]),
      opt('Oats with milk and peanut butter', 'شوفان بالحليب وزبدة فستق', [it('oats', 120, '1 and 1/4 cups', 'كوب وربع'), it('milk', 300, '1 big glass', 'كباية كبيرة'), it('pb', 32, '2 tablespoons', '2 ملاعق كبار')]),
      opt('Labneh, 2 eggs and 2 loaves', 'لبنة، بيضتين ورغيفين', [it('labneh', 90, '3 tablespoons', '3 ملاعق كبار'), it('egg', 100, '2 eggs', 'بيضتين'), it('bread', 200, '2 loaves', 'رغيفين'), oil(5)]),
      opt('Halloumi, 2 loaves, tomato and cucumber', 'حلوم، رغيفين، بندورة وخيار', [it('halloumi', 100, '4 slices', '4 شقف'), it('bread', 180, '2 small loaves', 'رغيفين صغار'), side()]),
    ] },
    { slot: 'snack', options: [
      opt('Whey shake with milk and a banana', 'شيك بروتين بالحليب مع موزة', [it('whey', 32, '1 scoop', 'سكوب'), it('milk', 300, '1 big glass', 'كباية كبيرة'), it('banana', 150, '1 large banana', 'موزة كبيرة')]),
      opt('Greek yogurt with dates and almonds', 'لبن يوناني مع تمر ولوز', [it('greek0', 340, '1 and 1/2 cups', 'كوب ونص'), it('dates', 48, '5 dates', '5 تمرات'), it('almond', 10, '8 almonds', '8 حبات لوز')]),
      opt('Tuna sandwich with cucumber', 'سندويش تونة مع خيار', [it('tuna', 112, '1 can, drained', 'علبة مصفاية'), it('bread', 100, '1 loaf', 'رغيف'), it('veg', 100, '1 cucumber', 'خيارة')]),
      opt('Chicken sandwich with lettuce and tomato', 'سندويش دجاج مع خس وبندورة', [it('chicken', 100, '1 palm (from the prep)', 'كف (من التحضير)'), it('bread', 80, '1 small loaf', 'رغيف صغير'), it('lettom', 100, 'a handful', 'كمشة')]),
    ] },
  ];
}
// lunch/dinner blocks
const L = {
  chickRice: () => [it('chicken', 200, '1 large palm', 'كف كبير'), it('rice', 330, '2 cups', 'كوبين'), side(), oil(15)],
  chickPot: () => [it('chicken', 200, '1 large palm', 'كف كبير'), it('potato', 450, '3 medium potatoes', '3 حبات بطاطا وسط'), side(), oil(15)],
  kaftaRice: () => [it('kafta', 180, '5 small skewers', '5 أسياخ صغار'), it('rice', 330, '2 cups', 'كوبين'), side(), oil(20)],
  kaftaPot: () => [it('kafta', 180, '5 small skewers', '5 أسياخ صغار'), it('potato', 450, '3 medium potatoes', '3 حبات بطاطا وسط'), side(), oil(20)],
  chickBulgur: (g, b, o) => [it('chicken', g, '1 large palm', 'كف كبير'), it('bulgur', b, b >= 500 ? '3 cups' : '2 and 1/2 cups', b >= 500 ? '3 كبايات' : 'كوبين ونص'), side(), oil(o)],
  chickSweet: (g, sp, o) => [it('chicken', g, '1 large palm', 'كف كبير'), it('sweetpot', sp, '2 sweet potatoes', 'حبتين بطاطا حلوة'), side(), oil(o)],
  salmonSweet: () => [it('salmon', 200, '1 large fillet', 'فيليه كبير'), it('sweetpot', 480, '2 large sweet potatoes', 'حبتين بطاطا حلوة كبار'), side(), oil(10)],
  salmonBulgur: () => [it('salmon', 200, '1 large fillet', 'فيليه كبير'), it('bulgur', 500, '3 cups', '3 كبايات'), side(), oil(5)],
  salmonSweetTab: () => [it('salmon', 200, '1 large fillet', 'فيليه كبير'), it('sweetpot', 400, '2 sweet potatoes', 'حبتين بطاطا حلوة'), it('tabbouleh', 200, '1 bowl (ready-made)', 'زبدية (جاهزة)')],
  salmonBulgurTab: () => [it('salmon', 200, '1 large fillet', 'فيليه كبير'), it('bulgur', 450, '2 and 1/2 cups', 'كوبين ونص'), it('tabbouleh', 200, '1 bowl (ready-made)', 'زبدية (جاهزة)')],
};
const T = {
  A_l: () => meal('Chicken taouk with rice', 'طاووق مع رز', 'grill', L.chickRice(), sw('Chicken with oven potatoes', 'دجاج مع بطاطا بالفرن', 'oven tray', L.chickPot())),
  A_d: () => meal('Kafta with oven potatoes', 'كفتة مع بطاطا بالفرن', 'oven tray', L.kaftaPot(), sw('Kafta with rice', 'كفتة مع رز', 'grill', L.kaftaRice())),
  B_l: () => meal('Kafta with rice', 'كفتة مع رز', 'grill', L.kaftaRice(), sw('Kafta with oven potatoes', 'كفتة مع بطاطا بالفرن', 'oven tray', L.kaftaPot())),
  B_d: () => meal('Chicken with oven potatoes', 'دجاج مع بطاطا بالفرن', 'oven tray', L.chickPot(), sw('Chicken taouk with rice', 'طاووق مع رز', 'grill', L.chickRice())),
  C_l: () => meal('Chicken with bulgur', 'دجاج مع برغل', 'heat', L.chickBulgur(190, 500, 20), sw('Chicken with sweet potato', 'دجاج مع بطاطا حلوة', 'oven tray', L.chickSweet(190, 480, 20))),
  C_d: () => meal('Oven salmon with sweet potato', 'سلمون بالفرن مع بطاطا حلوة', 'oven tray', L.salmonSweet(), sw('Salmon with bulgur', 'سلمون مع برغل', 'heat', L.salmonBulgur())),
  D_l: () => meal('Salmon, sweet potato and tabbouleh', 'سلمون، بطاطا حلوة وتبولة', 'oven tray', L.salmonSweetTab(), sw('Salmon, bulgur and tabbouleh', 'سلمون، برغل وتبولة', 'heat', L.salmonBulgurTab())),
  D_d: () => meal('Chicken with bulgur', 'دجاج مع برغل', 'heat', L.chickBulgur(185, 450, 15), sw('Chicken with sweet potato', 'دجاج مع بطاطا حلوة', 'oven tray', L.chickSweet(185, 420, 15))),
};
const MAIN = { proteins: [{ en: 'Chicken breast', ar: 'صدر دجاج' }, { en: 'Lean minced beef (kafta)', ar: 'لحمة مفرومة هبرة (كفتة)' }], carbs: [{ en: 'Rice', ar: 'رز' }, { en: 'Potatoes', ar: 'بطاطا' }], veg: [{ en: 'Tomatoes, cucumbers', ar: 'بندورة، خيار' }],
  steps: { en: ['Marinate 1.5 kg chicken breast (lemon, garlic, spices) and grill it all.', 'Shape the kafta into skewers and bake on one oven tray (20 min).', 'Rice in the rice cooker; potato wedges on a second tray.', 'Box for 4 days in the fridge.'],
           ar: ['تبّل كيلو ونص صدر دجاج (حامض، توم، بهارات) واشويهم كلهم.', 'اعمل الكفتة أسياخ وحطها بصينية بالفرن (20 دقيقة).', 'الرز بطنجرة الرز، والبطاطا بصينية تانية.', 'عبّي بعلب لـ 4 أيام بالبراد.'] } };
const TOPUP = { proteins: [{ en: 'Chicken breast', ar: 'صدر دجاج' }, { en: 'Salmon fillet', ar: 'فيليه سلمون' }], carbs: [{ en: 'Bulgur', ar: 'برغل' }, { en: 'Sweet potatoes', ar: 'بطاطا حلوة' }], veg: [{ en: 'Tomatoes, cucumbers', ar: 'بندورة، خيار' }],
  steps: { en: ['Grill the chicken; salmon fillets on a tray at 200°C for 15 min.', 'Bulgur in the rice cooker (1 cup bulgur, 2 cups water); sweet potatoes in the oven with the salmon.', 'Box for Friday to Sunday.'],
           ar: ['اشوي الدجاج؛ السلمون بصينية عـ 200 درجة لـ 15 دقيقة.', 'البرغل بطنجرة الرز (كوب برغل، كوبين مي)؛ البطاطا الحلوة بالفرن مع السلمون.', 'عبّي بعلب للجمعة لحد الأحد.'] } };
const flip = (cb) => ({ ...cb, lunch: cb.dinner, dinner: cb.lunch });
function week(n) {
  const A = { key: 'A', name: { en: 'Chicken lunch, kafta dinner', ar: 'غدا دجاج، عشا كفتة' }, lunch: T.A_l(), dinner: T.A_d() };
  const B = { key: 'B', name: { en: 'Kafta lunch, chicken dinner', ar: 'غدا كفتة، عشا دجاج' }, lunch: T.B_l(), dinner: T.B_d() };
  const C = { key: 'C', name: { en: 'Chicken and bulgur, salmon dinner', ar: 'دجاج وبرغل، عشا سلمون' }, lunch: T.C_l(), dinner: T.C_d() };
  const D = { key: 'D', name: { en: 'Sunday salmon and tabbouleh', ar: 'سلمون وتبولة نهار الأحد' }, lunch: T.D_l(), dinner: T.D_d() };
  const combos = n === 1 ? [A, B, C, D] : n === 2 ? [{ ...B, key: 'A' }, { ...A, key: 'B' }, { ...flip(C), key: 'C' }, { ...D, key: 'D' }] : [{ ...B, key: 'A' }, { ...A, key: 'B' }, { ...C, key: 'C' }, { ...flip(D), key: 'D' }];
  return JSON.parse(JSON.stringify({ combos, batch: { main: MAIN, topup: TOPUP } }));   // fresh copies: tests change them
}
const notes = {
  en: ['Pick any breakfast and snack option on any day: they are matched, so your numbers stay right.', 'Sunday main prep covers Monday to Thursday; the Wednesday evening top-up (30 min) covers Friday to Sunday.', 'Training in the evening: have your snack about 1.5 hours before.', 'Drink a big glass of water with every meal and keep a bottle on your desk.', 'Weigh yourself once a week, same day, before breakfast.'],
  ar: ['اختار أي ترويقة أو سناك بأي يوم: كلهم متساويين، فأرقامك بتضل مزبوطة.', 'تحضير الأحد بيغطي من الاثنين للخميس؛ تحضير الأربعا المسا (30 دقيقة) بيغطي من الجمعة للأحد.', 'إذا بتتمرن المسا، كول السناك قبل بساعة ونص.', 'اشرب كباية مي كبيرة مع كل وجبة وخلي قنينة على مكتبك.', 'وزن حالك مرة بالأسبوع، نفس النهار، قبل الترويقة.'],
};
// the AI answers, as text, like the API returns them
function aiPlan() { return { fixed: fixed(), week: week(1), notes }; }
function aiAnswer(mutate) { const j = aiPlan(); if (mutate) mutate(j); return 'Here is week 1:\n' + JSON.stringify(j); }
function aiWeekAnswer(n, mutate) { const j = { week: week(n) }; if (mutate) mutate(j); return JSON.stringify(j); }
// the mocked AI for the worker: week 1 / revise prompts get the week 1 plan, week N prompts get that week
function mockAsk(plant) {
  const calls = [];
  const ask = (system, user) => {
    calls.push(user);
    const m = /Write WEEK (\d)/.exec(user), n = m ? Number(m[1]) : 1, p = plant ? plant(calls.length, n, user) : null;
    return Promise.resolve(/rewrite week 1|Write WEEK 1/i.test(user) ? aiAnswer(p || undefined) : aiWeekAnswer(n, p || undefined));
  };
  return { ask, calls };
}
module.exports = { F, it, profile, aiPlan, aiAnswer, aiWeekAnswer, week, fixed, notes, mockAsk };
