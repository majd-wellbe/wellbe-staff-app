// =====================================================================
// Sign in with a 6 digit email code (same as Client.gs clCode_ / clLogin_ today).
// The api function already handles app_cl_code and app_cl_login; this one exists for pages that only sign in.
//   POST {email, mode?, name?}        -> sends the code       {ok, guest?, client?}
//   POST {email, code}                -> checks it            {ok, token}
// Own codes (not Supabase Auth OTP): see migrations/0008_auth.sql header for why.
// =====================================================================
import { asService, corsFor, jsonFor } from "../_shared/supabase.ts";
import { askCode, verifyCode } from "../_shared/login.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return jsonFor(req, { ok: false, error: "Bad request" }, 400);
  const db = asService();
  return jsonFor(req, b.code != null ? await verifyCode(db, b) : await askCode(db, b));
});
