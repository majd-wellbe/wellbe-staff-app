// Nutrition v2 test fixture: a realistic Lebanese desk worker and a hand-written plan in the exact shape the AI
// must answer with (functions/nutrition-worker/plan.ts schema). Item numbers come from standard food tables
// (per 100 g), so every item's kcal matches its macros. Used as the "mocked AI" in the tests and for sample-plan.json.

// per 100 g (or 100 ml): kcal, protein, carbs, fat
const F = {
  egg:        { en: 'Boiled eggs', ar: 'بيض مسلوق', buy: ['Eggs', 'بيض'], v: [143, 12.6, 0.7, 9.5], aisle: 'dairy', state: 'cooked' },
  eggwhite:   { en: 'Egg whites', ar: 'بياض بيض', buy: ['Eggs', 'بيض'], v: [52, 10.9, 0.7, 0.2], aisle: 'dairy', state: 'cooked' },
  labneh:     { en: 'Light labneh', ar: 'لبنة لايت', buy: ['Light labneh', 'لبنة لايت'], v: [110, 10, 5, 5], aisle: 'dairy', state: 'ready' },
  bread:      { en: 'Whole wheat Lebanese bread', ar: 'خبز لبناني أسمر', buy: ['Whole wheat Lebanese bread', 'خبز لبناني أسمر'], v: [250, 9, 50, 1.7], aisle: 'bakery', state: 'ready' },
  cucumber:   { en: 'Cucumber', ar: 'خيار', buy: ['Cucumbers', 'خيار'], v: [15, 0.7, 3.6, 0.1], aisle: 'produce', state: 'raw' },
  tomato:     { en: 'Tomato', ar: 'بندورة', buy: ['Tomatoes', 'بندورة'], v: [18, 0.9, 3.9, 0.2], aisle: 'produce', state: 'raw' },
  mint:       { en: 'Fresh mint', ar: 'نعنع أخضر', buy: ['Fresh mint', 'نعنع'], v: [44, 3.3, 8.4, 0.7], aisle: 'produce', state: 'raw' },
  chicken:    { en: 'Grilled chicken breast (taouk)', ar: 'صدر دجاج مشوي (طاووق)', buy: ['Chicken breast', 'صدر دجاج'], v: [165, 31, 0, 3.6], aisle: 'meat', state: 'cooked' },
  rice:       { en: 'White rice', ar: 'رز أبيض', buy: ['Rice', 'رز'], v: [130, 2.7, 28, 0.3], aisle: 'grains', state: 'cooked' },
  tabbouleh:  { en: 'Tabbouleh (light on oil)', ar: 'تبولة (زيت خفيف)', buy: ['Parsley', 'بقدونس'], v: [120, 2.5, 11, 7.5], aisle: 'produce', state: 'ready' },
  greek:      { en: 'Greek yogurt 2%', ar: 'لبن يوناني 2%', buy: ['Greek yogurt 2%', 'لبن يوناني 2%'], v: [73, 10, 3.9, 2], aisle: 'dairy', state: 'ready' },
  banana:     { en: 'Banana', ar: 'موزة', buy: ['Bananas', 'موز'], v: [89, 1.1, 22.8, 0.3], aisle: 'produce', state: 'raw' },
  dates:      { en: 'Dates', ar: 'تمر', buy: ['Dates', 'تمر'], v: [282, 2.5, 75, 0.4], aisle: 'canned', state: 'ready' },
  fish:       { en: 'Grilled hamour fillet', ar: 'فيليه هامور مشوي', buy: ['Hamour fillet', 'فيليه هامور'], v: [118, 24, 0, 2.3], aisle: 'fish', state: 'cooked' },
  potato:     { en: 'Boiled potatoes', ar: 'بطاطا مسلوقة', buy: ['Potatoes', 'بطاطا'], v: [87, 1.9, 20, 0.1], aisle: 'produce', state: 'cooked' },
  loubieh:    { en: 'Loubieh bil zeit (green beans in tomato)', ar: 'لوبية بزيت', buy: ['Green beans', 'لوبية'], v: [80, 2, 8, 4.5], aisle: 'produce', state: 'cooked' },
  oil:        { en: 'Olive oil', ar: 'زيت زيتون', buy: ['Olive oil', 'زيت زيتون'], v: [884, 0, 0, 100], aisle: 'pantry', state: 'raw', unit: 'ml' },
  foul:       { en: 'Foul mudammas', ar: 'فول مدمس', buy: ['Fava beans (foul), canned', 'فول معلب'], v: [130, 7, 15, 4.5], aisle: 'canned', state: 'ready' },
  kafta:      { en: 'Lean beef kafta, grilled', ar: 'كفتة لحمة هبرة مشوية', buy: ['Lean minced beef', 'لحمة مفرومة هبرة'], v: [217, 26, 0, 12], aisle: 'meat', state: 'cooked' },
  bulgur:     { en: 'Bulgur', ar: 'برغل', buy: ['Bulgur', 'برغل'], v: [83, 3.1, 18.6, 0.2], aisle: 'grains', state: 'cooked' },
  salad:      { en: 'Lebanese salad (lettuce, tomato, cucumber, lemon)', ar: 'سلطة لبنانية (خس، بندورة، خيار، حامض)', buy: ['Lettuce', 'خس'], v: [20, 1, 4, 0.2], aisle: 'produce', state: 'raw' },
  cottage:    { en: 'Light cottage cheese', ar: 'جبنة كوتاج لايت', buy: ['Light cottage cheese', 'جبنة كوتاج لايت'], v: [72, 12.4, 2.7, 1], aisle: 'dairy', state: 'ready' },
  apple:      { en: 'Apple', ar: 'تفاحة', buy: ['Apples', 'تفاح'], v: [52, 0.3, 13.8, 0.2], aisle: 'produce', state: 'raw' },
  oats:       { en: 'Rolled oats', ar: 'شوفان', buy: ['Rolled oats', 'شوفان'], v: [389, 16.9, 66.3, 6.9], aisle: 'grains', state: 'raw' },
  milk:       { en: 'Low fat milk', ar: 'حليب قليل الدسم', buy: ['Low fat milk', 'حليب قليل الدسم'], v: [47, 3.4, 4.8, 1.5], aisle: 'dairy', state: 'ready', unit: 'ml' },
  mjadra:     { en: 'Mjadra (lentils and bulgur)', ar: 'مجدرة', buy: ['Brown lentils', 'عدس بني'], v: [150, 6.5, 24, 3.5], aisle: 'grains', state: 'cooked' },
  halloumi:   { en: 'Light halloumi', ar: 'حلوم لايت', buy: ['Light halloumi', 'حلوم لايت'], v: [250, 24, 2, 16], aisle: 'dairy', state: 'ready' },
  sweetpot:   { en: 'Baked sweet potato', ar: 'بطاطا حلوة بالفرن', buy: ['Sweet potatoes', 'بطاطا حلوة'], v: [90, 2, 20.7, 0.2], aisle: 'produce', state: 'cooked' },
  vegroast:   { en: 'Roasted zucchini and peppers', ar: 'كوسا وفليفلة بالفرن', buy: ['Zucchini', 'كوسا'], v: [35, 1.5, 7, 0.3], aisle: 'produce', state: 'cooked' },
  tuna:       { en: 'Tuna in water, drained', ar: 'تونة بالمي مصفاية', buy: ['Tuna in water', 'تونة بالمي'], v: [116, 25.5, 0, 0.8], aisle: 'canned', state: 'ready' },
  lentilsoup: { en: 'Red lentil soup', ar: 'شوربة عدس', buy: ['Red lentils', 'عدس أحمر'], v: [70, 4.5, 11, 1], aisle: 'grains', state: 'cooked' },
  orange:     { en: 'Orange', ar: 'ليمونة (برتقال)', buy: ['Oranges', 'ليمون (برتقال)'], v: [47, 0.9, 11.8, 0.1], aisle: 'produce', state: 'raw' },
};
const r1 = x => Math.round(x * 10) / 10;
// home-cooked dishes: raw ingredients per 100 g of the cooked dish (for the grocery list)
const ING = {
  tabbouleh: [['Parsley', 'بقدونس', 45, 'produce'], ['Tomatoes', 'بندورة', 30, 'produce'], ['Fine bulgur', 'برغل ناعم', 6, 'grains'], ['Lemons', 'حامض', 10, 'produce'], ['Olive oil', 'زيت زيتون', 5, 'pantry', 'ml']],
  mjadra: [['Brown lentils', 'عدس بني', 18, 'grains'], ['Coarse bulgur', 'برغل خشن', 10, 'grains'], ['Onions', 'بصل', 15, 'produce'], ['Olive oil', 'زيت زيتون', 3, 'pantry', 'ml']],
  loubieh: [['Green beans', 'لوبية', 75, 'produce'], ['Tomatoes', 'بندورة', 30, 'produce'], ['Onions', 'بصل', 10, 'produce'], ['Garlic', 'توم', 2, 'produce'], ['Olive oil', 'زيت زيتون', 4, 'pantry', 'ml']],
  lentilsoup: [['Red lentils', 'عدس أحمر', 18, 'grains'], ['Onions', 'بصل', 8, 'produce'], ['Carrots', 'جزر', 8, 'produce'], ['Cumin', 'كمون', 0.3, 'pantry'], ['Olive oil', 'زيت زيتون', 1, 'pantry', 'ml']],
  salad: [['Lettuce', 'خس', 50, 'produce'], ['Tomatoes', 'بندورة', 25, 'produce'], ['Cucumbers', 'خيار', 20, 'produce'], ['Lemons', 'حامض', 5, 'produce']],
  vegroast: [['Zucchini', 'كوسا', 70, 'produce'], ['Bell peppers', 'فليفلة حلوة', 50, 'produce'], ['Salt and black pepper', 'ملح وبهار أسود', 0.5, 'pantry']],
};
// one item: food key, grams, household measure
function it(k, g, en, ar) {
  const f = F[k], m = g / 100;
  return { food: { en: f.en, ar: f.ar }, buy: { en: f.buy[0], ar: f.buy[1] }, g, unit: f.unit || 'g', state: f.state, measure: { en, ar },
    kcal: Math.round(f.v[0] * m), p: r1(f.v[1] * m), c: r1(f.v[2] * m), f: r1(f.v[3] * m), aisle: f.aisle, allergens: k === 'bread' || k === 'bulgur' || k === 'tabbouleh' || k === 'oats' || k === 'mjadra' ? ['gluten'] : ['egg', 'eggwhite'].includes(k) ? ['eggs'] : ['labneh', 'greek', 'cottage', 'milk', 'halloumi'].includes(k) ? ['lactose'] : k === 'fish' || k === 'tuna' ? ['seafood'] : [],
    ingredients: (ING[k] || []).map(x => ({ buy: { en: x[0], ar: x[1] }, g: Math.round(x[2] * m * 10) / 10, unit: x[4] || 'g', aisle: x[3] })) };
}
const meal = (slot, time, en, ar, items, swap) => ({ slot, time, name: { en, ar }, items, swap });
const sw = (en, ar, items) => ({ name: { en, ar }, items });

// Lebanese desk worker: Karim, 34, 92 kg, 178 cm, target 82 kg, lose (steady), desk job, trains 3 evenings a week,
// family cooks for 4 at home, 3 meals + 1 snack, 2 alternating days, no nuts (allergy), halal, dislikes mushrooms.
const profile = {
  body: { weight: 92, height: 178, birth: 1992, sex: 'M', target: 82 },
  answers: {
    goal: 'lose', why: 'My back hurts after long days at the desk and I want to feel fit again', pace: 'slow', event: '',
    job: 'desk', train_days: '3', train_time: 'pm', wake: '07:00', bed: '23:30', sleep: '6',
    meals: '3s', breakfast: 'yes', cook: 'family', skill: 'ok', cook_time: '30', out: '2', budget: 'mid', household: '4', variety: 'two', prep_day: 'sun', prep_time: '11:00',
    now_day: 'Manoushe and coffee at 9, a big lunch at home around 3, snacks in the afternoon, late dinner or delivery',
    often: ['bread', 'rice', 'sweets', 'chicken', 'dairy'], love: ['tabbouleh', 'grills', 'mjadra', 'loubieh', 'foul'], style: ['lebanese', 'protein'],
    love_other: 'grilled fish', dislike: 'mushrooms',
    allergy: ['nuts'], allergy_other: '', rules: ['halal'], digest: ['ok'],
    coffee: '2', sugar_drinks: '1', alcohol: '0', water: '1', cravings: 'night', weekend: 'family', supps: ['none'], health: ['none'],
  },
};

// the plan the AI would answer with (2 day templates, 4 eating times each, one swap per meal)
function planDays() {
  const A = {
    key: 'A', name: { en: 'Day A: grills and fresh salads', ar: 'نهار A: مشاوي وسلطات' }, meals: [
      meal('breakfast', '07:45', 'Eggs, labneh and whole wheat bread with vegetables', 'بيض، لبنة وخبز أسمر مع خضرة', [
        it('egg', 100, '2 eggs', 'بيضتين'), it('eggwhite', 60, '2 egg whites', 'بياض بيضتين'), it('labneh', 60, '2 tablespoons', '2 ملاعق كبار'),
        it('bread', 60, '2/3 loaf', 'تلتين الرغيف'), it('cucumber', 100, '1 cucumber', 'خيارة'), it('tomato', 100, '1 tomato', 'بندورة وحدة')],
        sw('Foul mudammas with bread and vegetables', 'فول مدمس مع خبز وخضرة', [
          it('foul', 200, '1 bowl', 'صحن صغير'), it('cottage', 100, '3 tablespoons', '3 ملاعق كبار'), it('bread', 40, 'half a loaf', 'نص رغيف'), it('tomato', 100, '1 tomato', 'بندورة وحدة'), it('mint', 10, 'a few leaves', 'كم ورقة')])),
      meal('lunch', '12:15', 'Chicken taouk with rice and tabbouleh', 'طاووق مع رز وتبولة', [
        it('chicken', 170, '1 large palm and a half', 'كف ونص'), it('rice', 120, '3/4 cup', 'تلت أرباع كوب'), it('tabbouleh', 150, '1 cup', 'كوب')],
        sw('Lean kafta with bulgur and Lebanese salad', 'كفتة هبرة مع برغل وسلطة', [
          it('kafta', 170, '5 small skewers', '5 أسياخ صغار'), it('bulgur', 170, '1 cup', 'كوب'), it('salad', 200, '1 big bowl', 'صحن كبير'), it('oil', 5, '1 teaspoon', 'ملعقة صغيرة')])),
      meal('snack', '16:30', 'Greek yogurt with banana and dates (before training)', 'لبن يوناني مع موز وتمر (قبل التمرين)', [
        it('greek', 200, '1 cup', 'كوب'), it('banana', 120, '1 medium banana', 'موزة وسط'), it('dates', 20, '2 dates', 'تمرتين')],
        sw('Cottage cheese with apple and dates', 'جبنة كوتاج مع تفاحة وتمر', [
          it('cottage', 160, '2/3 cup', 'تلتين الكوب'), it('apple', 150, '1 apple', 'تفاحة'), it('dates', 40, '4 dates', '4 تمرات')])),
      meal('dinner', '21:00', 'Grilled hamour with potatoes and loubieh bil zeit', 'هامور مشوي مع بطاطا ولوبية بزيت', [
        it('fish', 200, '1 large fillet', 'فيليه كبير'), it('potato', 200, '2 medium potatoes', 'حبتين بطاطا وسط'), it('loubieh', 200, '1 cup', 'كوب'), it('oil', 8, '2 teaspoons', 'ملعقتين صغار')],
        sw('Chicken taouk with potatoes and salad', 'طاووق مع بطاطا وسلطة', [
          it('chicken', 150, '1 large palm', 'كف كبير'), it('potato', 250, '2 to 3 potatoes', '2 لـ 3 حبات بطاطا'), it('salad', 200, '1 big bowl', 'صحن كبير'), it('oil', 10, '2 teaspoons', 'ملعقتين صغار')])),
    ] };
  const B = {
    key: 'B', name: { en: 'Day B: home classics', ar: 'نهار B: أكل البيت' }, meals: [
      meal('breakfast', '07:45', 'Oats with milk, and boiled eggs', 'شوفان بالحليب مع بيض مسلوق', [
        it('oats', 40, '1/2 cup', 'نص كوب'), it('milk', 250, '1 glass', 'كباية'), it('egg', 100, '2 eggs', 'بيضتين'), it('eggwhite', 60, '2 egg whites', 'بياض بيضتين')],
        sw('Halloumi and tomato sandwich', 'سندويش حلوم وبندورة', [
          it('halloumi', 80, '2 thick slices', 'شقفتين سميكين'), it('bread', 80, '1 small loaf', 'رغيف صغير'), it('tomato', 150, '1 big tomato', 'بندورة كبيرة'), it('eggwhite', 60, '2 egg whites', 'بياض بيضتين'), it('cucumber', 100, '1 cucumber', 'خيارة')])),
      meal('lunch', '12:15', 'Mjadra with grilled chicken and salad', 'مجدرة مع دجاج مشوي وسلطة', [
        it('mjadra', 250, '1 and 1/4 cups', 'كوب وربع'), it('chicken', 130, '1 palm', 'كف'), it('salad', 200, '1 big bowl', 'صحن كبير')],
        sw('Lentil soup with tuna salad and bread', 'شوربة عدس مع سلطة تونة وخبز', [
          it('lentilsoup', 400, '1 large bowl', 'زبدية كبيرة'), it('tuna', 120, '1 can, drained', 'علبة مصفاية'), it('bread', 50, 'half a loaf', 'نص رغيف'), it('salad', 200, '1 big bowl', 'صحن كبير'), it('oil', 5, '1 teaspoon', 'ملعقة صغيرة')])),
      meal('snack', '16:30', 'Greek yogurt with apple (before training)', 'لبن يوناني مع تفاحة (قبل التمرين)', [
        it('greek', 200, '1 cup', 'كوب'), it('apple', 150, '1 apple', 'تفاحة'), it('dates', 20, '2 dates', 'تمرتين')],
        sw('Labneh wrap with cucumber', 'عروسة لبنة مع خيار', [
          it('labneh', 120, '4 tablespoons', '4 ملاعق كبار'), it('bread', 60, '2/3 loaf', 'تلتين الرغيف'), it('cucumber', 150, '1 big cucumber', 'خيارة كبيرة'), it('mint', 10, 'a few leaves', 'كم ورقة')])),
      meal('dinner', '21:00', 'Lean beef kafta with sweet potato and roasted vegetables', 'كفتة هبرة مع بطاطا حلوة وخضرة بالفرن', [
        it('kafta', 150, '4 small skewers', '4 أسياخ صغار'), it('sweetpot', 180, '1 medium sweet potato', 'حبة بطاطا حلوة وسط'), it('vegroast', 200, '1 cup', 'كوب'), it('oil', 5, '1 teaspoon', 'ملعقة صغيرة')],
        sw('Grilled chicken with rice and loubieh', 'دجاج مشوي مع رز ولوبية', [
          it('chicken', 140, '1 large palm', 'كف كبير'), it('rice', 150, '1 cup', 'كوب'), it('loubieh', 200, '1 cup', 'كوب')])),
    ] };
  return [A, B];
}
const notes = {
  en: ['Drink a big glass of water with every meal and keep a bottle on your desk.', 'Train in the evening? Have the yogurt snack about 1.5 hours before.', 'The family can eat the same dishes: just keep your own portions as written.', 'Cook the chicken, rice and loubieh on Sunday for 3 days.', 'Weigh yourself once a week, same day, in the morning.'],
  ar: ['اشرب كباية مي كبيرة مع كل وجبة وخلي قنينة على مكتبك.', 'إذا بتتمرن المسا، كول سناك اللبن قبل بساعة ونص.', 'العيلة فيها تاكل نفس الأطباق: بس خليك على كمياتك المكتوبة.', 'اطبخ الدجاج والرز واللوبية نهار الأحد لـ 3 أيام.', 'وزن حالك مرة بالأسبوع، نفس النهار، الصبح.'],
};
// the AI answer for one chunk (keys), as text, like the API returns it
function aiAnswer(keys, mutate) {
  const days = planDays().filter(d => keys.includes(d.key));
  const j = { days, notes };
  if (mutate) mutate(j);
  return 'Here is the plan:\n' + JSON.stringify(j);
}
module.exports = { F, it, profile, planDays, notes, aiAnswer };
