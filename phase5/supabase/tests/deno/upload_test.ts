// deno test --allow-env --allow-read --allow-net=none  (Supabase faked)
Deno.env.set("WB_TEST", "1"); Deno.env.set("SUPABASE_URL", "http://x"); Deno.env.set("SUPABASE_ANON_KEY", "a"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "s");
const { handle } = await import(Deno.env.get("WB_FN_UPLOAD") ?? "../../functions/upload/index.ts");
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ": " + JSON.stringify(a) + " != " + JSON.stringify(b)); };

const CLIENT = { id: "u-c050", email: "dina@x.com", parent_email: null };
function fakeDb(who: unknown) {
  const log: any[] = [];
  const q = (table: string) => {
    const f: Record<string, unknown> = {};
    const o: any = {
      select: () => o, eq: (k: string, v: unknown) => (f[k] = v, o),
      maybeSingle: async () => ({ data: table === "clients" ? (f.legacy_id === "C050" ? CLIENT : null) : table === "staff" ? { name: "Majd Bou Habib" } : null }),
      insert: async (row: unknown) => (log.push({ insert: table, row }), { error: null }),
      upsert: async (row: unknown) => (log.push({ upsert: table, row }), { error: null }),
    };
    return o;
  };
  return { log, rpc: async (fn: string, args: unknown) => (log.push({ rpc: fn, args }), { data: who, error: null }), from: q,
    storage: { from: (bucket: string) => ({ upload: async (path: string, bytes: Uint8Array, opt: any) => (log.push({ bucket, path, n: bytes.length, type: opt.contentType }), { error: null }) }) } } as any;
}
const post = (body: unknown) => new Request("http://x/upload", { method: "POST", headers: { Origin: "https://majd-wellbe.github.io" }, body: JSON.stringify(body) });
const B64 = btoa("hello");

Deno.test("who is calling comes from wb_whoami (key or token), never from the body", async () => {
  const db = fakeDb({ role: "owner", staff: "majd" });
  const j = await (await handle(post({ key: "k-majd", cid: "c050", name: "mri.pdf", mime: "application/pdf", b64: B64, role: "client" }), db)).json();
  eq(db.log[0], { rpc: "wb_whoami", args: { p_key: "k-majd", p_token: null } }, "whoami");
  eq(j.ok, true, "owner uploads a file");
  eq(db.log[1].bucket, "client-files", "bucket"); eq(db.log[1].n, 5, "bytes");
  eq(db.log[2], { insert: "client_files", row: { client_id: "u-c050", file_name: "mri.pdf", storage_path: db.log[1].path, file_type: "application/pdf", uploaded_by: "Majd Bou Habib" } }, "row");
});
Deno.test("bad key / token: auth / signin, nothing stored", async () => {
  let db = fakeDb(null); eq(await (await handle(post({ key: "bad", cid: "C050", b64: B64 }), db)).json(), { ok: false, error: "auth" }, "key"); eq(db.log.length, 1, "only whoami");
  db = fakeDb(null); eq(await (await handle(post({ token: "bad", cid: "C050", b64: B64 }), db)).json(), { ok: false, error: "signin" }, "token");
});
Deno.test("files are owner only; a client may set their own photo, not someone else's", async () => {
  let db = fakeDb({ role: "trainer", staff: "joe" });
  eq(await (await handle(post({ key: "k-joe", cid: "C050", b64: B64 }), db)).json(), { ok: false, error: "not allowed" }, "trainer file");
  db = fakeDb({ role: "client", email: "dina@x.com" });
  eq(await (await handle(post({ token: "t", cid: "C050", b64: B64 }), db)).json(), { ok: false, error: "Not your account" }, "client file");
  db = fakeDb({ role: "client", email: "DINA@x.com" });
  const j = await (await handle(post({ token: "t", cid: "C050", b64: "data:image/jpeg;base64," + B64, mime: "image/jpeg", kind: "photo" }), db)).json();
  eq(j.ok, true, "own photo"); eq(db.log[1].bucket, "client-photos", "photo bucket"); eq(db.log[2].upsert, "client_photos", "photo row");
  db = fakeDb({ role: "client", email: "bea@x.com" });
  eq(await (await handle(post({ token: "t", cid: "C050", b64: B64, mime: "image/jpeg", kind: "photo" }), db)).json(), { ok: false, error: "Not your account" }, "other's photo");
  db = fakeDb({ role: "client", email: "dina@x.com" });
  eq(await (await handle(post({ token: "t", cid: "C050", b64: B64, mime: "application/pdf", kind: "photo" }), db)).json(), { ok: false, error: "Photos only" }, "photo type");
});
Deno.test("unknown client, empty body, too big, bad method", async () => {
  const db = fakeDb({ role: "owner", staff: "majd" });
  eq(await (await handle(post({ key: "k", cid: "C999", b64: B64 }), db)).json(), { ok: false, error: "Client not found" }, "unknown");
  eq(await (await handle(post({ key: "k", cid: "C050" }), db)).json(), { ok: false, error: "Nothing to upload" }, "empty");
  eq(await (await handle(post({ key: "k", cid: "C050", b64: btoa("x".repeat(10 * 1024 * 1024 + 1)) }), db)).json(), { ok: false, error: "File too big (10 MB max)" }, "big");
  eq((await handle(new Request("http://x/upload"), db)).status, 405, "GET");
});
