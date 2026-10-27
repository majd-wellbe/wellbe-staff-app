// deno test --node-modules-dir=none --allow-env --allow-read --allow-net=none
// Nutrition v2 worker: eating times, variety, the code checks (allergens, rules, dislikes, macros, swaps),
// the grocery list, the retry, and one run of the edge function with a fake database and a mocked AI.
Deno.env.set("WB_TEST", "1"); Deno.env.set("SUPABASE_URL", "http://x"); Deno.env.set("SUPABASE_ANON_KEY", "a"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "s");
import { createRequire } from "node:module";
import * as P from "../../functions/nutrition-worker/plan.ts";
const { runOnce, anthropic } = await import("../../functions/nutrition-worker/index.ts");
const X = createRequire(import.meta.url)("../lib/nut_fixture.cjs");

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ": " + JSON.stringify(a) + " != " + JSON.stringify(b)); };
const yes = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const M = { kcal: 1990, p: 165, c: 195, f: 62 };              // the sample client's targets (checked against SQL in nutrition.js)
const ANS = X.profile.answers;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

Deno.test("3 to 5 eating times: 2 meals becomes 3, snacks add up, never more than 5", () => {
  eq(["2", "3", "3s", "4s", "", undefined].map(P.eatingTimes), [3, 3, 4, 5, 4, 4], "eating times");
  for (const meals of ["2", "3", "3s", "4s"]) for (const breakfast of ["yes", "late", "no"]) {
    const s = P.mealSlots({ meals, breakfast, wake: "06:30", bed: "22:30" });
    yes(s.length >= 3 && s.length <= 5, "3..5 for " + meals);
    eq(s[s.length - 1].slot, "dinner", "last is dinner");
    eq(s[0].slot, breakfast === "no" ? "lunch" : "breakfast", "first slot follows the breakfast habit");
    yes(s.every((x, i) => i === 0 || x.time > s[i - 1].time), "times in order " + JSON.stringify(s));
  }
  // the sample client: 3 meals + 1 snack, trains in the evening
  eq(P.mealSlots(ANS), [{ slot: "breakfast", time: "07:45" }, { slot: "lunch", time: "12:15" }, { slot: "snack", time: "16:30", training: "pre" }, { slot: "dinner", time: "21:00", training: "post" }], "sample slots");
  // a plan with 3 meals when 4 are needed is refused by the check
  const d = clone(X.planDays()); d[0].meals.pop();
  yes(P.validate(d, M, ANS).some((e) => /needs exactly 4 eating times, has 3/.test(e)), "meal count checked");
});

Deno.test("variety: same day / 2 alternating / 4 rotating / 7 days, over the 21 day cycle", () => {
  eq(["same", "two", "four", "seven", "x"].map(P.dayCount), [1, 2, 4, 7, 4], "templates");
  eq(P.schedule("same").length, 21, "21 days");
  eq(new Set(P.schedule("same")).size, 1, "same");
  eq(P.schedule("two").slice(0, 7), [0, 1, 0, 1, 0, 1, 0], "two alternate");
  eq(P.schedule("four").slice(0, 9), [0, 1, 2, 3, 0, 1, 2, 3, 0], "four rotate");
  eq(P.schedule("seven").slice(0, 8), [0, 1, 2, 3, 4, 5, 6, 0], "seven");
  eq(P.chunks("seven"), [["A", "B"], ["C", "D"], ["E", "F"], ["G"]], "AI calls of 2 days");
  eq(P.chunks("same"), [["A"]], "one call");
  // the prompt asks for the right days and states the variety
  const q = P.ask(M, { ...ANS, variety: "seven" }, P.mealSlots(ANS), ["C", "D"], [], false, []);
  yes(/Write day templates C and D/.test(q) && /a different menu every day/.test(q), "prompt names the days and variety");
});

Deno.test("the sample plan passes every check", () => {
  const days = X.planDays();
  eq(P.validate(days, M, ANS, { keys: ["A", "B"], slots: P.mealSlots(ANS) }), [], "no problems");
  eq(days.map((d: P.Day) => d.totals), [{ kcal: 1990, p: 169, c: 198, f: 58 }, { kcal: 1960, p: 160, c: 202, f: 59 }], "day totals");
});

Deno.test("allergen check catches a planted violation, in meals, swaps and ingredients", () => {
  const plant = (fn: (d: P.Day[]) => void) => { const d = clone(X.planDays()); fn(d); return P.validate(d, M, ANS); };
  // nuts allergy: walnuts in a meal
  let e = plant((d) => { d[0].meals[2].items.push(X.it("dates", 1, "x", "x")); d[0].meals[2].items[3].food = { en: "Walnuts", ar: "جوز" }; });
  yes(e.some((x) => /Walnuts breaks "nuts"/.test(x)), "walnuts caught: " + e.join(" | "));
  // hidden in a swap
  e = plant((d) => { d[1].meals[0].swap!.items[0].food.en = "Halloumi with pistachios"; });
  yes(e.some((x) => /swap.*breaks "nuts"/.test(x)), "pistachio in swap caught");
  // hidden in a dish's ingredients
  e = plant((d) => { d[0].meals[1].items[2].ingredients!.push({ buy: { en: "Pine nuts", ar: "صنوبر" }, g: 5 }); });
  yes(e.some((x) => /breaks "nuts" \(pine nut\)/.test(x)), "pine nuts in ingredients caught");
  // halal: pork; dislikes: mushrooms
  e = plant((d) => { d[0].meals[3].items[0].food.en = "Grilled pork chops"; d[1].meals[3].items[2].food.en = "Roasted mushrooms"; });
  yes(e.some((x) => /breaks "halal" \(pork\)/.test(x)) && e.some((x) => /dislike \(mushrooms\)/.test(x)), "rule + dislike caught");
  // other allergies: sesame catches hummus, lactose catches labneh but not peanut butter, eggs not eggplant
  const ans2 = { ...ANS, allergy: ["sesame", "lactose", "eggs"], dislike: "" };
  const d2 = clone(X.planDays());
  d2[0].meals[0].items[0].food.en = "Hummus"; d2[0].meals[0].items[1].food.en = "Peanut butter"; d2[0].meals[0].items[1].buy!.en = "Peanut butter"; d2[0].meals[0].items[4].food.en = "Grilled eggplant";
  const e2 = P.validate(d2, M, ans2);
  yes(e2.some((x) => /Hummus breaks "sesame"/.test(x)), "hummus = sesame");
  yes(e2.some((x) => /Light labneh breaks "lactose"/.test(x)), "labneh = lactose");
  yes(!e2.some((x) => /Peanut butter breaks "lactose"/.test(x)), "peanut butter is not dairy");
  yes(!e2.some((x) => /eggplant/i.test(x)), "eggplant is not egg");
  // free text allergy
  e = P.validate(clone(X.planDays()), M, { ...ANS, allergy_other: "strawberries, kiwi" });
  eq(e, [], "no strawberries in the plan");
  const d3 = clone(X.planDays()); d3[1].meals[2].items[1].food.en = "Strawberry";
  yes(P.validate(d3, M, { ...ANS, allergy_other: "strawberries" }).some((x) => /allergy: strawberries/.test(x)), "free text allergy, singular in the plan");
});

Deno.test("macro tolerance: day within 5% kcal and protein, 10% carbs and fat; swaps the same macros", () => {
  const d = clone(X.planDays());
  d[0].meals[1].items[0].g = 260; d[0].meals[1].items[0].kcal = 429; d[0].meals[1].items[0].p = 80.6; d[0].meals[1].items[0].f = 9.4;   // more chicken
  const e = P.validate(d, M, ANS);
  yes(e.some((x) => /^Day A: p is 197, needs 165 \(within 5%\)$/.test(x)) && e.some((x) => /^Day A: kcal is 2138, needs 1990/.test(x)), "protein and kcal over 5%: " + e.join(" | "));
  yes(!e.some((x) => /^Day B: (kcal|p|c|f) is/.test(x)), "day B untouched");
  yes(e.some((x) => /swap for "Chicken taouk with rice and tabbouleh"/.test(x)), "swap no longer matches the meal");
  const d2 = clone(X.planDays()); d2[1].meals[0].items[0].kcal = 400;                                  // kcal not matching its macros
  yes(P.validate(d2, M, ANS).some((x) => /Rolled oats kcal does not match its macros/.test(x)), "item kcal vs macros");
  const d3 = clone(X.planDays()); delete d3[0].meals[0].swap;
  yes(P.validate(d3, M, ANS).some((x) => /needs one swap/.test(x)), "one swap per meal");
});

Deno.test("sport goal: carbs before and after training", () => {
  const ans = { ...ANS, goal: "sport" }, slots = P.mealSlots(ans);
  const d = clone(X.planDays());
  const e = P.validate([d[0]], M, ans, { slots, sport: true });
  yes(!e.some((x) => /training/.test(x)), "day A has carbs around training");
  yes(P.validate([d[1]], M, ans, { slots, sport: true }).some((x) => /Day B: the meal before training \(16:30\) needs a bigger carb portion/.test(x)), "day B snack too light for a sport plan");
  d[0].meals[3].items = [X.it("fish", 300, "x", "x"), X.it("salad", 300, "x", "x")];     // no carbs after training
  yes(P.validate(d, M, ans, { slots, sport: true }).some((x) => /after training \(21:00\) needs a bigger carb portion/.test(x)), "post training carbs checked");
  yes(/bigger carb portions in the meals before and after training/.test(JSON.stringify(P.brief({ ...M, goal: "sport" }, ans, slots))), "brief tells the AI");
});

Deno.test("grocery: weekly totals by aisle, shop packs, pantry apart, client only, 3 weeks", () => {
  const days = X.planDays(), sch = P.schedule("two"), g = P.grocery(days, sch);
  eq(g.length, 3, "3 weekly lists");
  const w1 = g[0], find = (w: P.GroceryWeek, en: string) => w.aisles.flatMap((a) => a.items).find((x) => x.en === en);
  // week 1 = A B A B A B A: chicken = (170 + 0) x 4 days A + 130 x 3 days B, cooked x 1.33
  eq(find(w1, "Chicken breast")!.g, Math.round((170 * 4 + 130 * 3) * 1.33), "chicken summed and raw");
  eq(find(w1, "Chicken breast")!.qty.en, "1 kg tray + 500 g tray (you need 1.5 kg)", "pack sizes");
  eq(find(w1, "Rice")!.g, Math.round(120 * 4 / 3), "cooked rice -> dry");
  eq(find(w1, "Eggs")!.qty.en, "tray of 30 (you need 26 eggs)", "eggs incl. whites as whole eggs");
  eq(find(w1, "Parsley")!.qty.en, "4 × bunch", "herbs in bunches");
  yes(find(w1, "Tomatoes")!.qty.en === "about 1 kg", "loose vegetables rounded up");
  eq(w1.pantry.items.map((x) => x.en), ["Olive oil", "Salt and black pepper"], "pantry staples apart");
  yes(!w1.aisles.flatMap((a) => a.items).some((x) => x.en === "Olive oil"), "oil not in the aisles");
  eq(w1.aisles.map((a) => a.key), ["produce", "meat", "fish", "dairy", "bakery", "grains", "canned"], "aisle order");
  // week 2 = B A B A B A B: different totals
  yes(find(g[1], "Chicken breast")!.g !== find(w1, "Chicken breast")!.g, "weeks differ with the rotation");
  // household does not scale the list
  eq(P.finish(M, { ...ANS, household: "5" }, X.planDays(), null, [], new Date(), "t").plan.grocery, P.finish(M, { ...ANS, household: "1" }, X.planDays(), null, [], new Date(), "t").plan.grocery, "not scaled to household");
  // pack choice: least left over, then fewest packs
  const rice = [{ size: 500, en: "500", ar: "" }, { size: 1000, en: "1000", ar: "" }];
  eq(P.packsFor(1700, rice).map((x) => x.n + "x" + x.pack.size), ["2x1000"], "1.7 kg rice");
  eq(P.packsFor(1200, rice).map((x) => x.n + "x" + x.pack.size), ["1x1000", "1x500"], "1.2 kg rice");
  eq(P.packsFor(13, [{ size: 6, en: "", ar: "" }, { size: 12, en: "", ar: "" }, { size: 30, en: "", ar: "" }]).map((x) => x.n + "x" + x.pack.size), ["1x12", "1x6"], "13 eggs");
});

// a mocked AI: answers from the fixture, can plant a problem on chosen calls
function mockAI(plan: (call: number, keys: string[]) => ((j: any) => void) | null) {
  const calls: string[] = [];
  const ask: P.AskFn = (_s, user) => {
    calls.push(user);
    const keys = /Write day templates? ([A-G](?: and [A-G])?)/.exec(user)![1].split(" and ");
    return Promise.resolve(X.aiAnswer(keys, plan(calls.length, keys) ?? undefined));
  };
  return { ask, calls };
}
const job = (over: Record<string, unknown> = {}) => ({ macros: M, answers: ANS, ...over });
async function writeAll(j: P.Job, ask: P.AskFn) {
  let r = await P.step(j, ask), n = 1;
  while (!r.done) { r = await P.step({ ...j, draft: r.draft }, ask); n++; }
  return { ...r, steps: n };
}

Deno.test("writing a plan: clean answer = done in one call, schedule and grocery added", async () => {
  const ai = mockAI(() => null);
  const r = await writeAll(job(), ai.ask);
  eq(ai.calls.length, 1, "one AI call for 2 days");
  eq(r.problems, [], "passed");
  eq(r.plan.schedule.length, 21, "21 days");
  eq(r.plan.eating_times.length, 4, "eating times");
  eq(r.plan.grocery.length, 3, "3 weeks");
  eq(r.plan.disclaimer.en.slice(0, 16), "General guidance", "disclaimer");
});

Deno.test("retry once with the problems listed, then it passes", async () => {
  const ai = mockAI((n) => n === 1 ? (j) => { j.days[0].meals[0].items[0].food.en = "Almond and egg muffin"; } : null);
  const r = await writeAll(job(), ai.ask);
  eq(ai.calls.length, 2, "two calls");
  yes(/fix all of them: Day A: Almond and egg muffin breaks "nuts"/.test(ai.calls[1]), "second prompt lists the problem");
  eq(r.problems, [], "passed after the retry");
});

Deno.test("fails twice: the plan is finished with its problems (it goes to the owner)", async () => {
  const ai = mockAI(() => (j) => { j.days[1].meals[3].items[0].food.en = "Kafta with pine nuts"; });
  const r = await writeAll(job(), ai.ask);
  eq(ai.calls.length, 2, "only one retry");
  yes(r.problems!.length > 0 && r.problems!.every((x) => /nuts/.test(x)), "problems kept: " + r.problems!.join(" | "));
});

Deno.test("7 different days: 4 AI calls, one per run, earlier meals sent so days differ", async () => {
  const days7 = "ABCDEFG".split("").map((k, i) => ({ ...clone(X.planDays()[i % 2]), key: k }));
  const calls: string[] = [];
  const ask: P.AskFn = (_s, user) => { calls.push(user); const keys = /Write day templates? ([A-G](?: and [A-G])?)/.exec(user)![1].split(" and "); return Promise.resolve(JSON.stringify({ days: days7.filter((d) => keys.includes(d.key)), notes: X.notes })); };
  const r = await writeAll(job({ answers: { ...ANS, variety: "seven" } }), ask);
  eq(r.steps, 4, "4 runs");
  eq(r.plan.days.map((d: P.Day) => d.key).join(""), "ABCDEFG", "7 days");
  yes(/clearly different from these meals: Eggs, labneh/.test(calls[1]), "earlier days in the prompt");
  eq(r.problems, [], "passed");
});

Deno.test("owner edit (recheck): no AI, the code checks it again", async () => {
  const fixed = { days: clone(X.planDays()), notes: X.notes };
  fixed.days[0].meals[1].items[2].food.en = "Tabbouleh with sesame";
  const r = await P.step({ ...job({ answers: { ...ANS, allergy: ["sesame"] } }), job: "recheck", draft: { fixed } }, () => Promise.reject(new Error("no AI")));
  yes(r.done && r.problems!.some((x) => /breaks "sesame"/.test(x)), "checked without AI");
});

Deno.test("edge function run: claim, step, finish / save / error through the database door", async () => {
  const mk = (claim: unknown) => {
    const calls: { fn: string; args: any }[] = [];
    return { calls, rpc: (fn: string, args: any) => { calls.push({ fn, args }); return Promise.resolve({ data: fn === "wb_nut_claim" ? claim : fn === "wb_nut_finish" ? { status: "Approved" } : true, error: null }); } };
  };
  let db = mk(null); eq(await runOnce(db, null), { idle: true }, "nothing to do");
  eq(db.calls[0].args.p_recheck_only, true, "no AI key: only owner edits");
  db = mk({ id: "u1", legacy: "NP-0001", macros: M, answers: ANS, draft: null, job: "write" });
  const r = await runOnce(db, mockAI(() => null).ask);
  eq([r.status, db.calls.map((c) => c.fn)], ["Approved", ["wb_nut_claim", "wb_nut_finish"]], "finished");
  eq(db.calls[1].args.p_problems, [], "no problems sent");
  db = mk({ id: "u2", legacy: "NP-0002", macros: M, answers: { ...ANS, variety: "four" }, draft: null, job: "write" });
  const fourDays: P.AskFn = (_s, u) => { const keys = /Write day templates? ([A-G](?: and [A-G])?)/.exec(u)![1].split(" and "); return Promise.resolve(JSON.stringify({ days: keys.map((k, i) => ({ ...clone(X.planDays()[i]), key: k })), notes: X.notes })); };
  const r2 = await runOnce(db, fourDays);
  eq([r2.more, db.calls.map((c) => c.fn)], [true, ["wb_nut_claim", "wb_nut_save"]], "progress saved, next run continues");
  eq(db.calls[1].args.p_draft.chunks.map((c: P.Chunk) => c.done), [true, false], "first 2 days done");
  db = mk({ id: "u3", legacy: "NP-0003", macros: M, answers: ANS, draft: null, job: "write" });
  const r3 = await runOnce(db, () => Promise.reject(new Error("AI 529: overloaded")));
  eq([r3.error, db.calls.map((c) => c.fn)], ["AI 529: overloaded", ["wb_nut_claim", "wb_nut_error"]], "AI error counted");
});

Deno.test("Anthropic call: key in the header, model, answer text joined", async () => {
  let seen: any = null;
  const f = ((url: string, init: RequestInit) => { seen = { url, init }; return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: "{\"a\":" }, { type: "text", text: "1}" }] }), { status: 200 })); }) as unknown as typeof fetch;
  const out = await anthropic("sk-test", "claude-x", f)("sys", "hi", 100);
  eq(out, "{\"a\":1}", "text");
  eq([seen.url, (seen.init.headers as any)["x-api-key"], JSON.parse(seen.init.body).model, JSON.parse(seen.init.body).max_tokens], ["https://api.anthropic.com/v1/messages", "sk-test", "claude-x", 100], "request");
  const bad = (() => Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch;
  let err = ""; try { await anthropic("k", "m", bad)("s", "u", 1); } catch (e) { err = (e as Error).message; }
  eq(err, "AI 401: nope", "error");
});
