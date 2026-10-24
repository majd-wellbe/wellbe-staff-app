// =====================================================================
// Writes the queued nutrition plans with the AI, one at a time (Nutrition.gs nutWorker).
// The numbers (calories, macros) are computed in code before this runs and saved in nutrition_plans.macros;
// the AI only writes meals as JSON, which are checked against the numbers (TODO(port): move nutValidate_ here).
// Plans stay Pending until a coach approves them (status rule in 0002_security.sql: clients only see Approved).
// TODO(Majd): secret ANTHROPIC_KEY (Supabase > Edge Functions > Secrets). Optional NUTRITION_MODEL.
// =====================================================================
import { asService, json } from "../_shared/supabase.ts";

Deno.serve(async () => {
  const db = asService(), key = Deno.env.get("ANTHROPIC_KEY");
  if (!key) return json({ ok: false, error: "ANTHROPIC_KEY missing" });
  const { data: plan } = await db.from("nutrition_plans").select("*").eq("status", "Queued").order("created_at").limit(1).maybeSingle();
  if (!plan) return json({ ok: true, idle: true });
  await db.from("nutrition_plans").update({ status: "Writing", writing_since: new Date().toISOString(), attempts: plan.attempts + 1 }).eq("id", plan.id);
  try {
    // TODO(port): build the same prompt as Nutrition.gs nutPrompt_ from nutrition_intake + plan.macros, 2 calls of 2 days,
    // run nutValidate_, 1 retry with the problems listed, then the grocery list in code.
    throw new Error("Prompt not ported yet: plans keep being written by Apps Script until this is done");
  } catch (e) {
    await db.from("nutrition_plans").update({ status: plan.attempts + 1 >= 2 ? "Failed" : "Queued", error: String((e as Error).message) }).eq("id", plan.id);
    return json({ ok: false, error: String((e as Error).message) });
  }
});
