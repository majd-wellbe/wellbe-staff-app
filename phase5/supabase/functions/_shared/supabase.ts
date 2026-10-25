// Shared helpers for the Wellbe edge functions (Deno). Keys come from Supabase secrets, never from code.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const URL = Deno.env.get("SUPABASE_URL")!;
export const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
export const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;   // only inside functions, never in the apps

// a client that acts as the caller (their Supabase Auth login), so Row Level Security applies
export function asCaller(req: Request): SupabaseClient {
  return createClient(URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
}
// a client with full access: workers, and the API door (which checks the caller itself)
export function asService(): SupabaseClient {
  return createClient(URL, SERVICE, { auth: { persistSession: false } });
}

// pages allowed to call the API from a browser: the live apps and local testing
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://majd-wellbe.github.io").split(",").map((s) => s.trim()).filter(Boolean);
export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ORIGINS.includes(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (origin === "capacitor://localhost" || origin === "https://localhost" || origin === "ionic://localhost") return origin;   // the store apps (Capacitor)
  return null;
}
export function corsFor(req: Request): Record<string, string> {
  const o = allowedOrigin(req.headers.get("Origin"));
  return { ...(o ? { "Access-Control-Allow-Origin": o } : {}), "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
}
export function jsonFor(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });
}

// older helpers, still used by the workers and upload
export const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
