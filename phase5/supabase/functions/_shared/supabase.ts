// Shared helpers for the Wellbe edge functions (Deno). Keys come from Supabase secrets, never from code.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const URL = Deno.env.get("SUPABASE_URL")!;
export const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
export const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;   // only inside functions, never in the apps

// a client that acts as the caller (their login), so Row Level Security applies
export function asCaller(req: Request): SupabaseClient {
  return createClient(URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
}
// a client with full access, for workers only
export function asService(): SupabaseClient {
  return createClient(URL, SERVICE, { auth: { persistSession: false } });
}
export const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info" };
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
