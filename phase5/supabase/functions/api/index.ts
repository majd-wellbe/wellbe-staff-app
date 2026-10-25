// =====================================================================
// /functions/v1/api : the one door for the staff app, client app and game. Same shape as the Apps Script doPost:
//   POST {action, key | token, ...fields}  ->  {ok:true, ...} or {ok:false, error}
// Who is calling comes ONLY from the staff key or the client token, checked inside the database (public.wb_call).
// The database runs only actions listed in app.api_actions (every public.api_<action>(jsonb) function).
// Deploy with "Verify JWT" OFF: the apps send the publishable key, the real check is the key / token.
// =====================================================================
import { asService, corsFor, jsonFor } from "../_shared/supabase.ts";
import { askCode, verifyCode } from "../_shared/login.ts";

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
// booking refusals carry flags next to the error, like the Apps Script body: {ok:false, full:true, error} / {already:true}.
// wb_call already puts them in its answer; this also reads them from a raw database error (detail '{"full":true}').
function flags(detail: unknown): Record<string, unknown> {
  try { const j = typeof detail === "string" && detail.startsWith("{") ? JSON.parse(detail) : null; if (j && typeof j === "object" && !Array.isArray(j)) { delete j.ok; delete j.error; return j; } } catch { /* not JSON */ }
  return {};
}

export async function handle(req: Request, db = asService(), fetcher: typeof fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST") return jsonFor(req, { ok: false, error: "Bad request" }, 405);
  let b: Body;
  try { b = await req.json(); } catch { return jsonFor(req, { ok: false, error: "Bad request" }, 400); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return jsonFor(req, { ok: false, error: "Bad request" }, 400);
  const action = String(b.action ?? ""), key = str(b.key), token = str(b.token);
  try {
    // sign in (no token yet)
    if (action === "app_cl_code") return jsonFor(req, await askCode(db, b, fetcher));
    if (action === "app_cl_login") return jsonFor(req, await verifyCode(db, b));
    if (action === "app_cl_signout") {
      if (token) await db.rpc("wb_signout", { p_token: token });
      return jsonFor(req, { ok: true });
    }
    // side by side week: the phone reports a difference between the two servers
    if (action === "wb_shadow") {
      const { data, error } = await db.rpc("wb_shadow", { p_key: key, p_token: token, p_action: String(b.of ?? ""), p_same: !!b.same, p_diff: b.diff ?? null });
      return jsonFor(req, error ? { ok: false, error: error.message } : data);
    }
    const body: Body = { ...b };
    for (const k of ["action", "key", "token", "_pre", "_ident", "identity"]) delete body[k];
    const { data, error } = await db.rpc("wb_call", { p_action: action, p_key: key, p_token: token, p_body: body });
    if (error) return jsonFor(req, { ok: false, error: error.message, ...flags(error.details) });
    return jsonFor(req, data ?? { ok: false, error: "Server error" });
  } catch (e) {
    return jsonFor(req, { ok: false, error: String((e as Error)?.message || e) });
  }
}

// started always on Supabase; the tests set WB_TEST and call handle() themselves
if (!Deno.env.get("WB_TEST")) Deno.serve((req) => handle(req));
