// =====================================================================
// /functions/v1/api : the same action names the apps use today with Apps Script, now on Supabase.
// The apps keep calling api('app_sell', {...}); only the URL and the login change (README, cut over step 4).
// Each action maps to a database function from migrations/0003_logic.sql, called AS THE USER,
// so the role checks and Row Level Security of the database decide what is allowed.
// =====================================================================
import { asCaller, cors, json } from "../_shared/supabase.ts";

type Body = Record<string, any>;
const id = async (db: any, table: string, legacy: string) => {
  const { data } = await db.from(table).select("id").eq("legacy_id", legacy).maybeSingle();
  if (!data) throw new Error(`${legacy} not found`);
  return data.id as string;
};

// action -> how to call the database. Legacy IDs (C012, PKG-0173, S13-0001) are accepted, like today.
const ACTIONS: Record<string, (db: any, b: Body) => Promise<unknown>> = {
  app_sell: async (db, b) => db.rpc("sell_package", { p_client: await id(db, "clients", b.cid), p_type: b.type, p_months: b.months ?? 1, p_discount: b.discount ?? 0,
    p_price: b.price === "" || b.price == null ? null : Number(b.price), p_paid: Number(b.paid) || 0, p_start: b.start || null, p_method: b.method || "Cash", p_use_wallet: !!b.useWallet }),
  app_pay: async (db, b) => db.rpc("pay_package", { p_pkg: await id(db, "packages", b.pkg), p_amount: Number(b.amount), p_method: b.method || "Cash", p_note: b.note || null }),
  app_book: async (db, b) => db.rpc("book_session", { p_kind: b.type, p_day: b.date, p_time: b.time, p_trainer: b.trainer || "", p_pkg: await id(db, "packages", b.pkg), p_name: b.name || "", p_restart: !!b.restart }),
  app_att: async (db, b) => db.rpc("mark_attendance", { p_session: await id(db, "sessions", b.id), p_slot: Number(b.i), p_att: b.att || "" }),
  app_req_done: async (db, b) => db.rpc("handle_request", { p_request: await id(db, "client_requests", b.id), p_act: b.act, p_day: b.d || null, p_time: b.t || null }),
  app_notice_read: async (db, b) => db.rpc("notice_read", { p_ids: b.ids }),
  app_cl_cancel: async (db, b) => db.rpc("cancel_session", { p_session: await id(db, "sessions", b.id), p_client: await id(db, "clients", b.cid) }),
  app_cl_join: async (db, b) => db.rpc("client_join", { p_client: await id(db, "clients", b.cid), p_day: b.date, p_time: b.time, p_trainer: b.trainer }),
  app_cl_upgrade6: async (db, b) => db.rpc("request_upgrade6", { p_client: await id(db, "clients", b.cid) }),
  app_cl_notice_read: async (db, b) => db.rpc("notice_read", { p_ids: b.ids }),
  app_cl_streak: async (db, b) => db.rpc("streak_tick", { p_client: await id(db, "clients", b.cid), p_keys: b.keys ?? null }),
  app_cl_run: async (db, b) => {
    const cid = await id(db, "clients", b.cid);
    if (b.op === "save") return db.rpc("game_save_run", { p_client: cid, p_run: b.run || {}, p_lbhide: b.lbHide == null ? null : !!b.lbHide });
    if (b.op === "redeem") return db.rpc("game_redeem", { p_client: cid });
    if (b.op === "shop") return db.rpc("game_shop", { p_client: cid, p_item: b.item });
    // TODO(port): op get / buy (old upgrades) come with the boot rewrite (README, "Not ported yet")
    return { error: { message: "This game action is not on the new server yet" } };
  },
  app_settings: async (db) => db.rpc("public_cfg"),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: Body = {};
  try { b = await req.json(); } catch { return json({ ok: false, error: "Bad request" }, 400); }
  const fn = ACTIONS[String(b.action)];
  if (!fn) return json({ ok: false, error: "unknown action" });   // the apps already show this text
  try {
    const db = asCaller(req);
    const { data, error } = (await fn(db, b)) as any;
    if (error) return json({ ok: false, error: error.message });
    return json(Object.assign({ ok: true }, typeof data === "object" && data ? data : { result: data }));
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) });
  }
});
