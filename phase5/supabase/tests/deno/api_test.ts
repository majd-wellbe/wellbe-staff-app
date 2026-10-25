// deno test --allow-env --allow-read --allow-net=none  (no network: Supabase and Resend are faked)
Deno.env.set("WB_TEST", "1"); Deno.env.set("SUPABASE_URL", "http://x"); Deno.env.set("SUPABASE_ANON_KEY", "a"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "s");
Deno.env.set("RESEND_API_KEY", "re_test"); Deno.env.set("MAIL_FROM", "Wellbe <app@example.com>");
const { handle } = await import(Deno.env.get("WB_FN_API") ?? "../../functions/api/index.ts");
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ": " + JSON.stringify(a) + " != " + JSON.stringify(b)); };
const yes = (c: unknown, m: string) => { if (!c) throw new Error(m); };

function fakeDb(answers: Record<string, unknown> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return { calls, rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: answers[fn] ?? { ok: true, fn }, error: null }; } } as any;
}
const post = (body: unknown, origin = "https://majd-wellbe.github.io") =>
  new Request("http://x/api", { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8", Origin: origin }, body: typeof body === "string" ? body : JSON.stringify(body) });

Deno.test("normal action goes to wb_call with key/token apart and identity fields stripped", async () => {
  const db = fakeDb({ wb_call: { ok: true, packages: [1] } });
  const r = await handle(post({ action: "app_sell", key: "k1", cid: "C001", identity: { role: "owner" }, _ident: 1, _pre: 2, role: "owner" }), db);
  eq(await r.json(), { ok: true, packages: [1] }, "result passed through");
  eq(db.calls[0], { fn: "wb_call", args: { p_action: "app_sell", p_key: "k1", p_token: null, p_body: { cid: "C001", role: "owner" } } }, "call");
});
Deno.test("CORS: live site and localhost allowed, others not", async () => {
  let r = await handle(post({ action: "x" }), fakeDb()); eq(r.headers.get("Access-Control-Allow-Origin"), "https://majd-wellbe.github.io", "live");
  r = await handle(post({ action: "x" }, "http://localhost:5500"), fakeDb()); eq(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:5500", "local");
  r = await handle(post({ action: "x" }, "https://evil.example"), fakeDb()); eq(r.headers.get("Access-Control-Allow-Origin"), null, "evil");
  r = await handle(new Request("http://x/api", { method: "OPTIONS", headers: { Origin: "https://majd-wellbe.github.io" } }), fakeDb()); eq(r.status, 200, "preflight");
});
Deno.test("bad requests", async () => {
  eq((await handle(post("not json"), fakeDb())).status, 400, "not json");
  eq((await handle(post("[1]"), fakeDb())).status, 400, "array");
  eq((await handle(new Request("http://x/api"), fakeDb())).status, 405, "GET");
});
Deno.test("code request: emails the code, never returns it", async () => {
  const db = fakeDb({ wb_login_code: { ok: true, guest: true, code: "123456", first: "Nadia", email: "n@x.com", desk: "Romy" } });
  const mails: any[] = [];
  const fetcher = (async (url: string, init: any) => { mails.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return new Response("{}", { status: 200 }); }) as any;
  const j = await (await handle(post({ action: "app_cl_code", email: "N@x.com", mode: "new", name: "Nadia Nasr" }), db, fetcher)).json();
  eq(j, { ok: true, guest: true }, "no code in the answer");
  eq(db.calls[0], { fn: "wb_login_code", args: { p_email: "N@x.com", p_mode: "new", p_name: "Nadia Nasr" } }, "db call");
  eq(mails[0].url, "https://api.resend.com/emails", "resend"); eq(mails[0].body.to, ["n@x.com"], "to"); eq(mails[0].body.subject, "Your Wellbe code: 123456", "subject");
  yes(mails[0].body.html.includes("Hi Nadia") && mails[0].auth === "Bearer re_test", "html + key");
});
Deno.test("code request: email fails -> code dropped, friendly error", async () => {
  const db = fakeDb({ wb_login_code: { ok: true, code: "123456", first: "A", email: "a@x.com", desk: "Romy" } });
  const fetcher = (async () => new Response("quota", { status: 429 })) as any;
  const j = await (await handle(post({ action: "app_cl_code", email: "a@x.com" }), db, fetcher)).json();
  eq(j.ok, false, "fails"); yes(/message Romy on WhatsApp/.test(j.error), j.error);
  eq(db.calls[1], { fn: "wb_login_code_cancel", args: { p_email: "a@x.com" } }, "cancelled");
});
Deno.test("code refused by the database: no email sent", async () => {
  const db = fakeDb({ wb_login_code: { ok: false, error: "unknown" } }); let sent = 0;
  const j = await (await handle(post({ action: "app_cl_code", email: "z@x.com" }), db, (async () => { sent++; return new Response(); }) as any)).json();
  eq(j, { ok: false, error: "unknown" }, "unknown"); eq(sent, 0, "no mail");
});
Deno.test("verify, sign out, shadow", async () => {
  const db = fakeDb({ wb_login_verify: { ok: true, token: "wb1.abc" } });
  eq(await (await handle(post({ action: "app_cl_login", email: "a@x.com", code: "123456" }), db)).json(), { ok: true, token: "wb1.abc" }, "verify");
  await handle(post({ action: "app_cl_signout", token: "wb1.abc" }), db); eq(db.calls[1], { fn: "wb_signout", args: { p_token: "wb1.abc" } }, "signout");
  await handle(post({ action: "wb_shadow", key: "k", of: "app_boot", same: false, diff: { a: 1 } }), db);
  eq(db.calls[2], { fn: "wb_shadow", args: { p_key: "k", p_token: null, p_action: "app_boot", p_same: false, p_diff: { a: 1 } } }, "shadow");
});
Deno.test("database error comes back as {ok:false}", async () => {
  const db = { rpc: async () => ({ data: null, error: { message: "permission denied" } }) } as any;
  eq(await (await handle(post({ action: "app_boot", key: "k" }), db)).json(), { ok: false, error: "permission denied" }, "error");
});
Deno.test("booking refusal flags come back next to the error, like the Apps Script ({full}, {already})", async () => {
  let db = fakeDb({ wb_call: { ok: false, full: true, error: "That session just filled up. Please pick another time." } });
  eq(await (await handle(post({ action: "lp_book", name: "N" }), db)).json(), { ok: false, full: true, error: "That session just filled up. Please pick another time." }, "full from wb_call");
  db = { rpc: async () => ({ data: null, error: { message: "You already have a trial booked: 2026-10-30 at 8 AM.", details: '{"already":true}' } }) } as any;
  eq(await (await handle(post({ action: "lp_book" }), db)).json(), { ok: false, error: "You already have a trial booked: 2026-10-30 at 8 AM.", already: true }, "already from a raw error");
  db = { rpc: async () => ({ data: null, error: { message: "x", details: "not json" } }) } as any;
  eq(await (await handle(post({ action: "lp_book" }), db)).json(), { ok: false, error: "x" }, "plain detail ignored");
});
