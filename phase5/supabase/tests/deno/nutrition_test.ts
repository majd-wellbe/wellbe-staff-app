// deno test --node-modules-dir=none --allow-env --allow-read --allow-net=none
// Nutrition worker core: eating times, breakfast/snack options, 2-day lunch/dinner rotation, 2 prep sessions,
// simplicity and salad rules, the code checks (allergens, rules, dislikes, macros, swaps), social meals, family lunch,
// restaurants, grocery lists, the review loop steps (draft, revise, full 3 weeks), client memory in the prompt,
// and runs of the edge function with a fake database and a mocked AI.
Deno.env.set("WB_TEST", "1"); Deno.env.set("SUPABASE_URL", "http://x"); Deno.env.set("SUPABASE_ANON_KEY", "a"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "s");
import { createRequire } from "node:module";
import * as P from "../../functions/nutrition-worker/plan.ts";
const { runOnce, anthropic, anthropicSearch } = await import("../../functions/nutrition-worker/index.ts");
const X = createRequire(import.meta.url)("../lib/nut_fixture.cjs");

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ": " + JSON.stringify(a) + " != " + JSON.stringify(b)); };
const yes = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const has = (errs: string[], re: RegExp, m: string) => yes(errs.some((e) => re.test(e)), m + ": " + errs.join(" | "));
const M = { kcal: 3120, p: 200, c: 360, f: 97 };              // the sample client's targets (checked against SQL in nutrition.js)
const ANS = X.profile.answers, SLOTS = P.mealSlots(ANS);
const LIB: P.Restaurant[] = [            // as wb_nut_claim gives it: the 0012 seed (real pages only) + one place the search did not find
  { name: "Zaatar w Zeit", key: "zaatarzeit", status: "found", dishes: [{ restaurant: "Zaatar W Zeit", dish: "Spicy Chicken (brown bread)", kcal: 440, p: 19, c: 23, f: 30, source_url: "https://www.eatthismuch.com/calories/zaatar-w-zeit-spicy-chicken-793697", checked: false }] },
  { name: "Roadster Diner", key: "roadsterdiner", status: "found", dishes: [{ restaurant: "Roadster Diner", dish: "All-Fit mushroom burger", kcal: 400, source_url: "https://cdn.nogarlicnoonions.com/roadsters-all-fit-menu-reviewed" }, { restaurant: "Roadster Diner", dish: "Mushroom BBQ burger", kcal: 390, source_url: "https://cdn.nogarlicnoonions.com/roadsters-all-fit-menu-reviewed" }] },
  { name: "Kababji", key: "kababji", status: "not_found", dishes: [] },
];
const full = (ans = ANS, flags: string[] = [], rests = LIB) => P.finish(M, ans, X.fixed(), [X.week(1), X.week(2), X.week(3)], X.notes, flags, rests, new Date("2026-10-27T10:00:00Z"), "t", 0, "final");

Deno.test("3 to 5 eating times: 2 meals becomes 3; always one lunch and one dinner", () => {
  eq(["2", "3", "3s", "4s", "", undefined].map(P.eatingTimes), [3, 3, 4, 5, 4, 4], "eating times");
  for (const meals of ["2", "3", "3s", "4s"]) for (const breakfast of ["yes", "late", "no"]) {
    const s = P.mealSlots({ meals, breakfast, wake: "06:30", bed: "22:30" });
    yes(s.length >= 3 && s.length <= 5, "3..5 for " + meals);
    eq([s.filter((x) => x.slot === "lunch").length, s.filter((x) => x.slot === "dinner").length], [1, 1], "one lunch, one dinner");
  }
  eq(SLOTS, [{ slot: "breakfast", time: "07:45" }, { slot: "lunch", time: "12:15" }, { slot: "snack", time: "16:30", training: "pre" }, { slot: "dinner", time: "21:00", training: "post" }], "sample slots");
});

Deno.test("breakfast and snack: 4 options each, matched within 5%, every option checked against the day", () => {
  eq(P.validate(X.aiPlan(), M, ANS), [], "the sample passes");
  let a = X.aiPlan(); a.fixed[0].options.pop();
  has(P.validate(a, M, ANS), /breakfast: write exactly 4 options, not 3/, "4 options");
  a = X.aiPlan(); a.fixed[1].options[2].items.push(X.it("almond", 30, "x", "x"));       // +174 kcal on one snack option
  let e = P.validate(a, M, ANS);
  has(e, /snack option 3 is \d+ kcal: the snack options must be within 5% of each other/, "options matched");
  a = X.aiPlan(); a.fixed[0].options[3].items[0] = X.it("halloumi", 160, "x", "x"); a.fixed[0].options[3].items[1] = X.it("bread", 120, "x", "x");   // same kcal, more fat
  e = P.validate(a, M, ANS);
  has(e, /day with pair [A-D] with breakfast option 4: f is \d+, needs 97/, "an option other than the default is checked against the day");
  a = X.aiPlan(); a.fixed[1].options[1].items[2].food.en = "Pork rind";
  has(P.validate(a, M, ANS), /snack option 2: Pork rind breaks "nopork"/, "every option checked against food rules");
  a = X.aiPlan(); a.fixed[0].options[1].items.push(X.it("banana", 20, "x", "x"));
  has(P.validate(a, M, ANS), /breakfast option 2: "Oats with milk and peanut butter" has 4 ingredients, at most 3/, "3 ingredients + oil per option");
  yes(P.ingredientCount(X.fixed()[0].options[0].items) === 3, "eggs + bread + tomato/cucumber, oil does not count");
  yes(/built for THIS client \(scaled to their targets, from the foods they like, their food style, budget, cooking skill and prep time\)/.test(P.system()) && /never a generic list/.test(P.system()), "options are per client");
  // picks: the day is built with the chosen options
  const day = P.assembleDay(X.fixed(), X.week(1).combos[0], SLOTS, [1, 2]);
  eq([day[0].name.en, day[2].name.en], ["Oats with milk and peanut butter", "Tuna sandwich with cucumber"], "picks");
});

Deno.test("lunch and dinner change every 2 days: A Mon-Tue, B Wed-Thu, C Fri-Sat, D Sun; 2 prep sessions", () => {
  eq(P.BLOCKS, [0, 0, 1, 1, 2, 2, 3], "blocks");
  eq(P.schedule(3).slice(0, 8), [[0, 1], [0, 2], [0, 2], [0, 3], [0, 0], [0, 0], [0, 1], [1, 1]], "21 days from a Thursday: cycle week, pair of the weekday");
  let a = X.aiPlan(); a.week.combos.pop();
  has(P.validate(a, M, ANS), /write exactly 4 lunch\/dinner pairs \(A Mon-Tue, B Wed-Thu, C Fri-Sat, D Sun\), not 3/, "4 pairs");
  a = X.aiPlan(); a.week.combos[2].lunch.items[0] = X.it("kafta", 160, "x", "x");      // kafta is cooked at the main prep, not the top-up
  has(P.validate(a, M, ANS), /Week 1 pair C: lunch: protein Lean minced beef is not cooked in the mid-week top-up \(Chicken breast, Salmon fillet\)/, "C/D come from the top-up");
  a = X.aiPlan(); a.week.batch.main.carbs.push({ en: "Pasta", ar: "معكرونة" });
  has(P.validate(a, M, ANS), /the main prep cooks 1 or 2 carbs, not 3/, "max 2 carbs a session");
  a = X.aiPlan(); a.week.combos[0].dinner.method = "slow braise";
  has(P.validate(a, M, ANS), /needs a heat-and-assemble method/, "heat and assemble");
  a = X.aiPlan(); a.week.combos[1].lunch.items[0].food.en = "Kibbeh bil sayniyeh";
  has(P.validate(a, M, ANS), /Kibbeh bil sayniyeh is too complicated to cook: make it "buy ready-made"/, "complicated dish refused");
  a.week.combos[1].lunch.items[0].ready_made = true;
  yes(!P.validate(a, M, ANS).some((x) => /too complicated/.test(x)), "ready-made allowed");
  const q = P.askWeek1(M, ANS, SLOTS, []);
  yes(/A Monday-Tuesday, B Wednesday-Thursday, C Friday-Saturday, D Sunday/.test(q) && /"main_prep":"Sunday 11:00 \(cooks for A and B\)"/.test(q) && /"mid_week_topup":"Wednesday 19:00 \(about 30 minutes, cooks for C and D\)"/.test(q), "prompt: blocks and 2 sessions");
  const f = full(); eq([f.plan.weeks.length, f.plan.weeks[0].batch.topup.day, f.plan.weeks[0].batch.topup.minutes, f.plan.weeks[0].batch.main.for], [3, "wed", 30, ["A", "B"]], "plan: 3 weeks, top-up Wednesday 30 min");
});

Deno.test("salads: none by default, raw side fine, named salads only as often as the client said", () => {
  eq(P.saladMax({ salad_freq: "most_meals" }) > 7 && P.saladMax({ salad_freq: "few_week" }) === 2 && P.saladMax({ salad_freq: "rarely" }) === 0 && P.saladMax({}) === 2, true, "limits");
  eq(P.validate(X.aiPlan(), M, ANS), [], "1 ready-made tabbouleh a week + raw sides = fine for 1 to 2 a week");
  has(P.validate(X.aiPlan(), M, { ...ANS, salad_freq: "rarely" }), /named salads \(fattoush, tabbouleh, any salad\) on 1 meals, the client wants none \(rarely\)/, "rarely");
  const a = X.aiPlan(); a.week.combos[0].lunch.items[2] = { ...X.it("tabbouleh", 150, "x", "x") };          // a salad on Mon-Tue lunch = 2 more
  has(P.validate(a, M, ANS), /named salads .* on 3 meals, the client wants at most 2 a week/, "few_week");
  yes(!P.validate(a, M, { ...ANS, salad_freq: "most_meals" }).some((x) => /named salads/.test(x)), "most meals");
  yes(!P.isNamedSalad(X.it("veg", 100, "x", "x")) && P.isNamedSalad(X.it("tabbouleh", 100, "x", "x")), "tomato and cucumber is a side, not a salad");
});

Deno.test("allergen check catches a planted violation, in meals, swaps, options and ingredients", () => {
  const plant = (fn: (a: any) => void, ans = ANS) => { const a = X.aiPlan(); fn(a); return P.validate(a, M, ans); };
  has(plant((a) => { a.week.combos[0].lunch.swap.items[0].food.en = "Chicken with pistachio crust"; }, { ...ANS, allergy: ["nuts"] }), /swap: Chicken with pistachio crust breaks "nuts"/, "pistachio in a swap");
  has(plant(() => {}, { ...ANS, allergy: ["nuts"] }), /snack option 2: Almonds breaks "nuts"/, "almonds in a snack option");
  has(plant(() => {}, { ...ANS, allergy: ["peanut"] }), /breakfast option 2: Peanut butter breaks "peanut"/, "peanut butter");
  has(plant((a) => { a.week.combos[0].lunch.items[2].ingredients.push({ buy: { en: "Pine nuts", ar: "صنوبر" }, g: 5 }); }, { ...ANS, allergy: ["nuts"] }), /breaks "nuts" \(pine nut\)/, "pine nuts in ingredients");
  const e = plant((a) => { a.week.combos[0].dinner.items[0].food.en = "Grilled pork chops"; a.week.combos[1].dinner.items[1].food.en = "Mushroom potatoes"; });
  has(e, /breaks "nopork" \(pork\)/, "rule"); has(e, /is a food they dislike \(mushroom/, "dislike");
  has(plant((a) => { a.week.combos[0].dinner.name.en = "Kafta with a glass of wine"; }), /breaks "no alcohol in meals"/, "no alcohol inside meals");
  has(plant(() => {}, { ...ANS, dislike: "mushrooms, tuna" }), /snack option 3: Tuna in water, drained is a food they dislike \(tuna\)/, "an \"I don't eat\" note (added to the dislikes by the database) is enforced");
});

Deno.test("macro tolerance: each day within 5% kcal and protein, 10% carbs and fat; swaps the same macros", () => {
  const a = X.aiPlan(); a.week.combos[0].lunch.items[0] = X.it("chicken", 300, "x", "x");
  const e = P.validate(a, M, ANS);
  has(e, /^Week 1 day with pair A: p is 2\d\d, needs 200 \(within 5%\)$/, "protein over 5%");
  has(e, /swap for "Chicken taouk with rice"/, "swap no longer matches");
  yes(!e.some((x) => /day with pair B/.test(x)), "pair B untouched");
  const b = X.aiPlan(); b.fixed[0].options[0].items[1].kcal = 900;
  has(P.validate(b, M, ANS), /Whole wheat Arabic bread kcal does not match its macros/, "item kcal vs macros");
  const c = X.aiPlan(); delete c.week.combos[0].dinner.swap;
  has(P.validate(c, M, ANS), /needs one swap/, "one swap per lunch and dinner");
});

Deno.test("sport goal: carbs before and after training", () => {
  const ans = { ...ANS, goal: "sport" };
  const e0 = P.validate(X.aiPlan(), M, ans, { slots: SLOTS, sport: true });
  has(e0, /pair A: the meal before training \(16:30\) needs a bigger carb portion/, "the sample snack is too light for a sport plan");
  yes(!e0.some((x) => /after training/.test(x)), "dinner after training has enough carbs");
  const a = X.aiPlan(); a.week.combos[0].dinner.items = [X.it("kafta", 400, "x", "x"), X.it("veg", 200, "x", "x"), X.it("oil", 5, "x", "x")];
  has(P.validate(a, M, ans, { slots: SLOTS, sport: true }), /pair A: the meal after training \(21:00\) needs a bigger carb portion/, "post training carbs");
});

Deno.test("social meals: the rest of the day's budget; drinks only on social nights; never flagged, under 18 or halal", () => {
  const S = full().plan.social;
  eq(S.map((s: any) => [s.key, s.dow, s.slot, s.kind]), [["fri_night", 4, "dinner", "restaurant"], ["family_lunch", 6, "lunch", "family"]], "Friday night, Sunday family lunch");
  const dayC = full().plan.weeks[0].days[2], others = dayC.meals.filter((m: P.Meal) => m.slot !== "dinner").reduce((t: number, m: P.Meal) => t + m.totals!.kcal, 0);
  eq(S[0].budget.kcal, 3120 - others, "Friday (pair C): remaining calories");
  eq([S[0].drinks.n, S[0].food_kcal], [1, S[0].budget.kcal - 150], "sometimes = 1 drink inside the budget");
  eq(S[1].drinks, null, "no drinks at lunch");
  eq(full({ ...ANS, social: ["midweek_dinner"], social_drinks: "usually" }).plan.social[0].drinks, null, "never midweek");
  eq(full({ ...ANS, social_drinks: "usually" }).plan.social[0].drinks.n, 2, "usually = up to 2");
  eq(full({ ...ANS, social_drinks: "usually" }, ["diabetes"]).plan.social[0].drinks, null, "never a health flag");
  eq(full({ ...ANS, social_drinks: "usually" }, ["minor"]).plan.social[0].drinks, null, "never under 18");
  eq(full({ ...ANS, social_drinks: "usually", rules: ["halal"] }).plan.social[0].drinks, null, "never halal");
  eq(full({ ...ANS, social: ["rarely"] }).plan.social, [], "rarely = none");
  eq(full({ ...ANS, social: ["sun_lunch", "family_lunch"] }).plan.social.map((s: any) => s.key), ["family_lunch"], "the family lunch takes the Sunday lunch");
});

Deno.test("family lunch: mashawi and mezze portions inside the budget, rules respected, a home meal when there is none", () => {
  const fam = full().plan.social[1];
  eq(fam.guide.items.map((x: any) => x.en), ["3 skewers (taouk or kafta)", "3 tbsp hummus", "1 plate tabbouleh", "1 loaf of bread", "at most 2 fried pieces (kibbeh or sambousek)"], "big budget: full guide");
  yes(fam.guide.kcal <= fam.food_kcal, "inside the budget");
  eq(fam.home.name.en, "Salmon, sweet potato and tabbouleh", "home meal = Sunday's pair D lunch");
  const small = P.familyGuide(650, ANS);
  eq(small.items.map((x) => x.en), ["2 skewers (taouk or kafta)", "3 tbsp hummus", "1 plate tabbouleh", "½ loaf of bread"], "650 kcal: fried pieces first, then bread");
  yes(small.kcal <= 650, "small budget kept");
  eq(P.familyGuide(900, { ...ANS, allergy: ["sesame", "gluten"] }).items.map((x) => x.en), ["3 skewers (taouk or kafta)"], "sesame and gluten: no hummus, tabbouleh, bread, kibbeh");
  eq(P.familyGuide(900, { ...ANS, salad_freq: "rarely" }).items.some((x) => /raw vegetables/.test(x.en)), true, "rarely salad: raw vegetables instead of tabbouleh");
  eq(P.familyGuide(900, { ...ANS, rules: ["vegetarian"] }).items[0].en.includes("halloumi"), true, "vegetarian: halloumi instead of skewers");
});

Deno.test("restaurants: 1 to 2 dishes that fit, rules respected, estimates, menu not found, real sources only", () => {
  const S = full().plan.social[0];
  eq(S.suggestions.map((d: any) => [d.restaurant, d.dish, d.estimate]), [["Zaatar W Zeit", "Spicy Chicken (brown bread)", true]], "fits; mushroom burgers left out (dislike)");
  eq(S.not_found, [{ restaurant: "Kababji", msg: { en: "Menu not found, coach will add it.", ar: "ما لقينا المنيو، المدرب رح يزيده." } }], "menu not found, never invented");
  eq(P.askFor("Chicken wrap with fries").en, "salad instead of fries, sauce on the side", "ask for");
  eq(P.restKey("Zaatar w Zeit") + "|" + P.restKey("ZAATAR & ZEIT"), "zaatarzeit|zaatarzeit", "restaurant key (same as SQL app.rest_key)");
  eq(P.parseSearch('{"found":true,"dishes":[{"dish":"Grilled chicken plate","kcal":520,"source_url":"https://example.com/menu"},{"dish":"Made up","kcal":400}]}').map((d) => d.dish), ["Grilled chicken plate"], "no source = dropped");
  yes(/Never invent dishes/.test(P.searchPrompt("Kababji").system), "search prompt forbids invention");
});

Deno.test("grocery: lunch/dinner per week (meals out left out), one list per breakfast/snack option, packs, pantry", () => {
  const p = full().plan, g = p.weeks[0].grocery;
  const find = (en: string, gg = g) => gg.aisles.flatMap((a: any) => a.items).find((x: any) => x.en === en);
  // week 1: chicken at A lunch (Mon Tue), B dinner (Wed Thu), C lunch (Fri Sat), D dinner (Sun); no Sunday lunch at home
  eq(find("Chicken breast").g, Math.round((200 * 2 + 200 * 2 + 190 * 2 + 185) * 1.33), "chicken, cooked -> raw");
  // salmon: C dinner Friday is out (Friday night) -> Saturday only; D lunch is the family lunch -> out
  eq(find("Salmon fillet").g, Math.round(200 * 1 * 1.2), "meals out left out");
  eq(find("Tabbouleh, ready-made"), undefined, "the family lunch's home meal is not bought");
  eq(p.options_grocery.length, 2, "breakfast and snack");
  eq(p.options_grocery[0].length, 4, "one list per option");
  eq(find("Eggs", p.options_grocery[0][0]).qty.en, "2 × box of 12 (you need 20 eggs)", "option 1: 3 eggs x 7 days");
  eq(find("Rolled oats", p.options_grocery[0][1]).qty.en, "1 kg pack (you need 850 g)", "option 2: oats 120 g x 7");
  eq(p.weeks[0].grocery.pantry.items.map((x: any) => x.en), ["Olive oil"], "pantry apart");
  yes(JSON.stringify(p.weeks[0].grocery) !== JSON.stringify(p.weeks[1].grocery), "weeks differ with their pairs");
  eq(full({ ...ANS, household: "5" }).plan.weeks[0].grocery, full({ ...ANS, household: "1" }).plan.weeks[0].grocery, "not scaled to household");
  eq(P.packsFor(13, [{ size: 6, en: "", ar: "" }, { size: 12, en: "", ar: "" }, { size: 30, en: "", ar: "" }]).map((x) => x.n + "x" + x.pack.size), ["1x12", "1x6"], "packs");
});

const job = (over: Record<string, unknown> = {}) => ({ macros: M, answers: ANS, restaurants: LIB, flags: [], ...over }) as P.Job;
async function run(j: P.Job, ask: P.AskFn) {
  let r = await P.step(j, ask), n = 1;
  while (!r.done) { r = await P.step({ ...j, draft: r.draft }, ask); n++; }
  return { ...r, steps: n };
}

Deno.test("review loop: week 1 draft, revision with the client's requests, then the full 3 weeks", async () => {
  // draft
  let ai = X.mockAsk(null), r = await run(job({ job: "write" }), ai.ask);
  eq([ai.calls.length, r.problems, r.plan.stage, r.plan.weeks.length], [1, [], "draft", 1], "week 1 draft in one call");
  // revise: the requests and the previous draft are in the prompt
  const requests = [{ kind: "portion", text: "Too much food" }, { kind: "dislike", text: "tuna" }, { kind: "request", text: "More Lebanese dishes" }];
  ai = X.mockAsk(null);
  const rv = await run(job({ job: "revise", base: r.plan, requests }), ai.ask);
  yes(/The client reviewed this WEEK 1 draft/.test(ai.calls[0]) && /"text":"Too much food"/.test(ai.calls[0]) && /"text":"More Lebanese dishes"/.test(ai.calls[0]) && /Chicken taouk with rice/.test(ai.calls[0]), "revision prompt has the draft and the requests");
  eq([rv.plan.stage, rv.problems], ["draft", []], "revised draft");
  // full: weeks 2 and 3, one call per run, week 1 kept
  ai = X.mockAsk(null);
  const fl = await run(job({ job: "full", base: rv.plan }), ai.ask);
  eq([fl.steps, ai.calls.length, fl.plan.stage, fl.plan.weeks.length, fl.problems], [2, 2, "final", 3, []], "2 calls, 3 weeks");
  yes(/Write WEEK 2 in the same style/.test(ai.calls[0]) && /Write WEEK 3 in the same style/.test(ai.calls[1]) && /different from: Chicken taouk with rice/.test(ai.calls[0]), "weeks 2 and 3 differ from earlier weeks");
  eq(JSON.stringify(fl.plan.weeks[0].combos), JSON.stringify(rv.plan.weeks[0].combos), "week 1 kept as approved");
});

Deno.test("client memory from earlier cycles is in the prompt", async () => {
  const memory = [{ kind: "dislike", text: "tuna" }, { kind: "liked", text: "Chicken taouk with rice" }, { kind: "portion", text: "I am still hungry" }];
  const ai = X.mockAsk(null);
  await P.step(job({ job: "write", memory }), ai.ask);
  yes(/"client_memory":\{"does_not_eat":\["tuna"\],"liked":\["Chicken taouk with rice"\],"portion_feedback":\["I am still hungry"\]\}/.test(ai.calls[0]), "memory summary: " + ai.calls[0].slice(0, 200));
});

Deno.test("retry once with the problems listed; fails twice = finished with its problems (to the owner)", async () => {
  let ai = X.mockAsk((n: number) => n === 1 ? (j: any) => { j.fixed[0].options[0].items.push(X.it("labneh", 20, "x", "x")); } : null);
  let r = await run(job({ job: "write" }), ai.ask);
  eq(ai.calls.length, 2, "two calls");
  yes(/fix all of them: breakfast option 1: "3 eggs, 2 loaves whole wheat bread, tomato and cucumber" has 4 ingredients/.test(ai.calls[1]), "second prompt lists the problem");
  eq(r.problems, [], "passed after the retry");
  ai = X.mockAsk(() => (j: any) => { j.week.combos[1].dinner.items[0].food.en = "Chicken with cashew crust"; });
  r = await run(job({ job: "write", answers: { ...ANS, allergy: ["nuts"] } }), ai.ask);
  yes(ai.calls.length === 2 && r.problems!.some((x) => /cashew/.test(x)), "problems kept after one retry");
  // a full-plan week that fails twice
  ai = X.mockAsk((_n: number, wk: number) => wk === 3 ? (j: any) => { j.week.combos[0].lunch.items[0].food.en = "Pork chops"; } : null);
  const base = (await run(job({ job: "write" }), X.mockAsk(null).ask)).plan;
  r = await run(job({ job: "full", base }), ai.ask);
  yes(ai.calls.length === 3 && r.problems!.some((x) => /^Week 3 pair A: lunch: Pork chops breaks "nopork"/.test(x)), "week 3 retried once, problems kept");
});

Deno.test("owner edit (recheck): no AI, the code checks it again", async () => {
  const fixed = { fixed: X.fixed(), weeks: [X.week(1)], notes: X.notes }; fixed.weeks[0].combos[0].lunch.items[0].food.en = "Chicken with sesame";
  const r = await P.step({ ...job({ answers: { ...ANS, allergy: ["sesame"] } }), job: "recheck", draft: { fixed } }, () => Promise.reject(new Error("no AI")));
  yes(r.done && r.problems!.some((x) => /breaks "sesame"/.test(x)), "checked without AI");
});

Deno.test("edge function run: restaurant lookup first, then the step; finish / save / error", async () => {
  const mk = (claim: unknown) => {
    const calls: { fn: string; args: any }[] = [];
    return { calls, rpc: (fn: string, args: any) => { calls.push({ fn, args }); return Promise.resolve({ data: fn === "wb_nut_claim" ? claim : fn === "wb_nut_finish" ? { status: "Draft" } : fn === "wb_nut_rest_found" ? { found: 1 } : true, error: null }); } };
  };
  let db = mk(null); eq(await runOnce(db, null), { idle: true }, "nothing to do");
  eq(db.calls[0].args.p_recheck_only, true, "no AI key: only owner edits");
  const base = { id: "u1", legacy: "NP-0001", macros: M, answers: ANS, draft: null, job: "write", flags: [], memory: [], requests: [] };
  db = mk({ ...base, restaurants: [...LIB.slice(0, 2), { name: "Barbar", key: "barbar", status: "unknown", dishes: [] }] });
  const searched: string[] = [];
  const r0 = await runOnce(db, X.mockAsk(null).ask, new Date(), (n: string) => { searched.push(n); return Promise.resolve('{"found":true,"dishes":[{"dish":"Chicken taouk plate","kcal":610,"p":48,"c":52,"f":22,"source_url":"https://example.org/barbar-menu"}]}'); });
  eq([searched, r0.looked_up, r0.found, db.calls.map((c) => c.fn)], [["Barbar"], "Barbar", 1, ["wb_nut_claim", "wb_nut_rest_found", "wb_nut_save"]], "looked up first");
  db = mk({ ...base, restaurants: LIB });
  const r = await runOnce(db, X.mockAsk(null).ask, new Date(), () => Promise.reject(new Error("must not search")));
  eq([r.status, db.calls.map((c) => c.fn)], ["Draft", ["wb_nut_claim", "wb_nut_finish"]], "finished");
  eq(db.calls[1].args.p_plan.social[0].suggestions[0].dish, "Spicy Chicken (brown bread)", "social suggestions in the plan");
  db = mk({ ...base, job: "full", base: (await run(job({ job: "write" }), X.mockAsk(null).ask)).plan, restaurants: LIB });
  const r2 = await runOnce(db, X.mockAsk(null).ask);
  eq([r2.more, db.calls.map((c) => c.fn)], [true, ["wb_nut_claim", "wb_nut_save"]], "full plan: week 2 saved, next run writes week 3");
  db = mk({ ...base, restaurants: LIB });
  const r3 = await runOnce(db, () => Promise.reject(new Error("AI 529: overloaded")));
  eq([r3.error, db.calls.map((c) => c.fn)], ["AI 529: overloaded", ["wb_nut_claim", "wb_nut_error"]], "AI error counted");
});

Deno.test("Anthropic calls: key in the header, model, web search tool for restaurants", async () => {
  let seen: any = null;
  const f = ((url: string, init: RequestInit) => { seen = { url, init }; return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "server_tool_use" }, { type: "text", text: "{\"a\":" }, { type: "text", text: "1}" }] }), { status: 200 })); }) as unknown as typeof fetch;
  eq(await anthropic("sk-test", "claude-x", f)("sys", "hi", 100), "{\"a\":1}", "text");
  eq([seen.url, (seen.init.headers as any)["x-api-key"], JSON.parse(seen.init.body).model], ["https://api.anthropic.com/v1/messages", "sk-test", "claude-x"], "request");
  eq(await anthropicSearch("sk-test", "claude-x", f)("Kababji"), "{\"a\":1}", "search text");
  eq(JSON.parse(seen.init.body).tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }], "web search tool");
});
