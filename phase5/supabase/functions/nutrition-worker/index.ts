// =====================================================================
// nutrition-worker: writes the queued v2 nutrition plans with the AI (Nutrition.gs nutWorker, approved v2 rules).
// Called every 5 minutes by pg_cron (migrations/0004_jobs.sql) with the service key; deploy with Verify JWT ON.
// One AI call per run, the progress is saved in nutrition_plans.draft, and the run starts the next one at once,
// so no run comes near the edge function time limit. Before the plan, each of the client's restaurants that is not in
// the Wellbe library is looked up once with the AI's web search (dishes saved unchecked for the owner). The numbers come from the database
// (macros, computed in code); the AI only writes meals; plan.ts checks them, retries once with the problems,
// adds up the grocery list. Then public.wb_nut_finish decides: shown at once, or to the owner.
// Secrets (Supabase > Edge Functions > Secrets): ANTHROPIC_KEY (required to write plans), NUTRITION_MODEL (optional).
// Without ANTHROPIC_KEY it only re-checks plans the owner edited, and writes nothing else.
// =====================================================================
import { asService, json } from "../_shared/supabase.ts";
import { parseSearch, searchPrompt, step, type AskFn } from "./plan.ts";

const MODEL = Deno.env.get("NUTRITION_MODEL") || "claude-sonnet-5-5";

export function anthropic(key: string, model = MODEL, fetcher: typeof fetch = fetch): AskFn {
  return async (system, user, maxTokens) => {
    const r = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error("AI " + r.status + ": " + t.slice(0, 300));
    return (JSON.parse(t).content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  };
}

export type SearchFn = (name: string) => Promise<string>;
// the restaurant lookup: the AI with the web search tool, only real pages, never invented dishes
export function anthropicSearch(key: string, model = MODEL, fetcher: typeof fetch = fetch): SearchFn {
  return async (name) => {
    const p = searchPrompt(name);
    const r = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 4000, system: p.system, messages: [{ role: "user", content: p.user }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error("AI search " + r.status + ": " + t.slice(0, 300));
    return (JSON.parse(t).content ?? []).filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("");
  };
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

// one run: take a plan, do one step, save. ask = null: only owner edits are re-checked (no AI).
export async function runOnce(db: Rpc, ask: AskFn | null, now = new Date(), search: SearchFn | null = null): Promise<Record<string, unknown>> {
  const { data: job, error } = await db.rpc("wb_nut_claim", { p_lease_s: 240, p_recheck_only: !ask });
  if (error) throw new Error(error.message);
  if (!job) return { idle: true };
  if (job.skip) return { id: job.id, stopped: true, more: true };
  try {
    // a restaurant the library does not know yet: look it up first (one per run)
    const unknown = job.job !== "recheck" && search ? (job.restaurants ?? []).find((x: { status: string }) => x.status === "unknown") : null;
    if (unknown && search) {
      const dishes = parseSearch(await search(unknown.name));
      const f = await db.rpc("wb_nut_rest_found", { p_name: unknown.name, p_dishes: dishes });
      if (f.error) throw new Error(f.error.message);
      const s = await db.rpc("wb_nut_save", { p_id: job.id, p_draft: job.draft });
      if (s.error) throw new Error(s.error.message);
      return { id: job.legacy, looked_up: unknown.name, found: dishes.length, more: true };
    }
    const r = await step({ macros: job.macros, answers: job.answers ?? {}, draft: job.draft, job: job.job, model: MODEL, flags: job.flags ?? [], restaurants: job.restaurants ?? [], base: job.base, memory: job.memory ?? [], requests: job.requests ?? [] }, ask ?? (() => Promise.reject(new Error("no AI key"))), now);
    if (!r.done) {
      const s = await db.rpc("wb_nut_save", { p_id: job.id, p_draft: r.draft });
      if (s.error) throw new Error(s.error.message);
      return { id: job.legacy, more: true };
    }
    const f = await db.rpc("wb_nut_finish", { p_id: job.id, p_plan: r.plan, p_problems: r.problems });
    if (f.error) throw new Error(f.error.message);
    return { id: job.legacy, status: f.data?.status, problems: r.problems?.length ?? 0, more: true };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    await db.rpc("wb_nut_error", { p_id: job.id, p_error: msg });
    return { id: job.legacy, error: msg, more: false };
  }
}

// the scheduler and this function itself only: a service role token (signature checked by Supabase, Verify JWT ON)
function isService(req: Request): boolean {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tok) return false;
  if (tok === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return true;
  try { return JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role"; } catch { return false; }
}

if (!Deno.env.get("WB_TEST")) Deno.serve(async (req) => {
  if (!isService(req)) return json({ ok: false, error: "forbidden" }, 403);
  const key = Deno.env.get("ANTHROPIC_KEY") ?? "";
  try {
    const r = await runOnce(asService(), key ? anthropic(key) : null, new Date(), key ? anthropicSearch(key) : null);
    if (r.more) {                       // go on with the next step / the next plan in a fresh run
      const next = fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/nutrition-worker", { method: "POST", headers: { Authorization: req.headers.get("Authorization")!, "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(next);
    }
    return json({ ok: true, ai: !!key, ...r });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
