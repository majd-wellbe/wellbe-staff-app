-- =====================================================================
-- WELLBE on Supabase: 0008 sign in + the one API door (edge function "api")
--
-- Logins stay exactly as today:
--   staff    their private link key (#k=...). Only a hash (sha256) is stored here.
--   clients  email + 6 digit code (10 minutes, 5 tries, 3 codes per 15 minutes, login.codesPerDay a day),
--            then a sign in token valid login.tokenDays (180) days. Only its hash is stored.
--            Tokens made by the Apps Script keep working (same CL_SECRET, imported once), so nobody
--            has to sign in again on the day we switch.
--   guests   same as clients; an unknown email becomes a guest when the code is checked.
-- We do NOT use Supabase Auth for these people (no Supabase user rows, no SMTP needed for logins):
-- the edge function sends the code email (Resend) and calls public.wb_call() with the service key.
--
-- How a request runs:
--   app -> edge function api {action, key|token, ...body}
--       -> public.wb_call(action, key, token, body)        (service role only)
--          1. finds the action in app.api_actions (whitelist)       -> else "unknown action"
--          2. turns key / token into an identity                    -> else "auth" (staff) / "signin" (client)
--          3. stores the identity for this transaction, signed with a secret only the database knows
--          4. runs public.api_<action>(body) and returns {ok:true,...} or {ok:false,error}
--   app.caller(), app.my_role(), app.my_staff(), app.my_clients() read that identity first.
--   Nothing in the body can change who you are.
--
-- Also fixes: a person who signs up through Supabase Auth on their own (possible with the public key)
-- and has no profile was treated as 'system' by app.caller(). Now: anyone reaching the database as
-- anon / authenticated is never 'system'.
-- =====================================================================

-- ---------------------------------------------------------------------
-- private tables (no grants, Row Level Security on, no policies)
-- ---------------------------------------------------------------------
create table if not exists app.secrets (key text primary key, value text not null, updated_at timestamptz not null default now());
insert into app.secrets (key, value)
values ('ident_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

create table if not exists app.staff_keys (
  staff_id   text primary key references public.staff(id) on delete cascade,
  key_hash   text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists app.sessions (                    -- client / guest sign ins
  token_hash   text primary key,
  email        text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_seen_at timestamptz
);
create index if not exists sessions_email on app.sessions (lower(email));
create table if not exists app.login_codes (                 -- one live code per email
  email       text primary key,
  code_hash   text not null,
  name        text,                                          -- name typed by a new person (guest made after the code)
  tries       int not null default 0,
  expires_at  timestamptz not null
);
create table if not exists app.login_sends (                 -- codes asked, for the limits
  email text not null, at timestamptz not null default now()
);
create index if not exists login_sends_email on app.login_sends (email, at);
create table if not exists app.signout_before (              -- sign ins made before `at` are dead (account deletion)
  email text primary key, at timestamptz not null
);
create table if not exists app.api_actions (                 -- the whitelist of the API door
  action  text primary key,
  fn      text not null,                                     -- public function name, e.g. api_app_sell
  needs   text not null check (needs in ('staff', 'client', 'any', 'none')),
  enabled boolean not null default true
);
create table if not exists app.shadow_log (                  -- side by side week: differences Apps Script vs Supabase
  id      bigserial primary key,
  at      timestamptz not null default now(),
  action  text not null,
  who     text,
  same    boolean not null,
  diff    jsonb
);
do $$ declare t text; begin
  foreach t in array array['secrets','staff_keys','sessions','login_codes','login_sends','signout_before','api_actions','shadow_log'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('revoke all on app.%I from public, anon, authenticated', t);
  end loop;
end $$;
-- shadow_log is insert only, even for the database owner by mistake
create or replace function app.no_change() returns trigger language plpgsql as $$ begin raise exception 'shadow_log is insert only'; end $$;
drop trigger if exists shadow_log_ro on app.shadow_log;
create trigger shadow_log_ro before update or delete on app.shadow_log for each row execute function app.no_change();

-- ---------------------------------------------------------------------
-- small helpers
-- ---------------------------------------------------------------------
create or replace function app.sha(t text) returns text language sql immutable as $$
  select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') $$;
create or replace function app.b64url(b bytea) returns text language sql immutable as $$
  select rtrim(translate(replace(encode(b, 'base64'), E'\n', ''), '+/', '-_'), '=') $$;
create or replace function app.b64url_dec(t text) returns bytea language sql immutable as $$
  select decode(translate(t, '-_', '+/') || repeat('=', (4 - length(t) % 4) % 4), 'base64') $$;
create or replace function app.secret(k text) returns text language sql stable security definer set search_path = public as $$
  select value from app.secrets where key = k $$;
create or replace function app.rand_hex(n int) returns text language sql volatile as $$   -- n hex chars (max 64)
  select left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), n) $$;
-- the database is reached by a person (through the public API) and not by a worker / the API door
create or replace function app.from_api_role() returns boolean language sql stable as $$
  select coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated') $$;
create or replace function app.hmac_hex(msg text, k text) returns text language sql immutable set search_path = public, extensions, pg_temp as $$
  select encode(hmac(convert_to(msg, 'UTF8'), convert_to(k, 'UTF8'), 'sha256'), 'hex') $$;

-- the identity of this request, set by public.wb_call(); null when not called through the API door
create or replace function app.ident() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v text := current_setting('wb.identity', true); s text := current_setting('wb.identity_sig', true);
begin
  if v is null or v = '' then return null; end if;
  if app.from_api_role() then return '{"role":"anon"}'::jsonb; end if;          -- never from the public API
  if s is null or s <> app.hmac_hex(v, app.secret('ident_key')) then return '{"role":"anon"}'::jsonb; end if;
  return v::jsonb;
end $$;

-- ---------------------------------------------------------------------
-- 0002 / 0003 helpers, now reading the API door identity first
-- ---------------------------------------------------------------------
create or replace function app.me() returns public.profiles language plpgsql stable security definer set search_path = public as $$
declare i jsonb := app.ident(); p public.profiles;
begin
  if i is not null then
    p.user_id := null; p.email := coalesce(i->>'email', ''); p.role := coalesce(i->>'role', 'anon'); p.staff_id := i->>'staff'; p.created_at := now();
    return p;
  end if;
  select * into p from public.profiles where user_id = auth.uid();
  return p;
end $$;
create or replace function app.my_role() returns text language sql stable security definer set search_path = public as $$
  select case when app.ident() is not null then coalesce(app.ident()->>'role', 'anon')
              else coalesce((select role from public.profiles where user_id = auth.uid()), 'anon') end
$$;
create or replace function app.my_staff() returns text language sql stable security definer set search_path = public as $$
  select case when app.ident() is not null then app.ident()->>'staff'
              else (select staff_id from public.profiles where user_id = auth.uid()) end
$$;
create or replace function app.my_trainer() returns text language sql stable security definer set search_path = public as $$
  select s.trainer from public.staff s where s.id = app.my_staff() and s.active
$$;
create or replace function app.my_email() returns text language sql stable security definer set search_path = public as $$
  select lower(case when app.ident() is not null then app.ident()->>'email'
                    else (select email from public.profiles where user_id = auth.uid()) end)
$$;
create or replace function app.my_clients() returns setof uuid language sql stable security definer set search_path = public as $$
  select c.id from public.clients c
   where c.deleted_at is null and app.my_role() in ('client', 'guest') and app.my_email() is not null
     and (lower(c.email) = app.my_email() or lower(c.parent_email) = app.my_email())
$$;
-- who is calling: role + staff id + the name written in notes
create or replace function app.caller() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare i jsonb := app.ident(); p public.profiles; s public.staff; sid text; r text;
begin
  if i is not null then
    r := coalesce(i->>'role', 'anon');
    if r in ('owner', 'assistant', 'trainer') then
      select * into s from public.staff where id = i->>'staff' and active and role = r;
      if s.id is null then return jsonb_build_object('role', 'anon'); end if;
      return jsonb_build_object('role', s.role, 'staff', s.id, 'trainer', s.trainer, 'name', s.name);
    end if;
    if r in ('client', 'guest') then return jsonb_build_object('role', r, 'name', 'client app', 'email', i->>'email'); end if;
    return jsonb_build_object('role', 'anon');
  end if;
  select * into p from public.profiles where user_id = auth.uid();
  if p.user_id is null then
    -- workers and the SQL editor (no request role) are 'system'; a person through the public API never is
    if not app.from_api_role() then return jsonb_build_object('role', 'system', 'name', 'system'); end if;
    return jsonb_build_object('role', 'anon');
  end if;
  if p.staff_id is not null then
    select * into s from public.staff where id = p.staff_id and active;
    if s.id is null then return jsonb_build_object('role', 'anon'); end if;
    return jsonb_build_object('role', p.role, 'staff', s.id, 'trainer', s.trainer, 'name', s.name);
  end if;
  return jsonb_build_object('role', p.role, 'name', 'client app');
end $$;

-- ---------------------------------------------------------------------
-- key / token -> identity
-- ---------------------------------------------------------------------
-- 'client' when the email (or a parent email) is on a client row, 'guest' when only a guest row, else null
create or replace function app.email_role(e text) returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.clients c where c.kind = 'client' and c.deleted_at is null and (lower(c.email) = lower(e) or lower(c.parent_email) = lower(e))) then 'client'
    when exists (select 1 from public.clients c where c.kind = 'guest' and c.deleted_at is null and lower(c.email) = lower(e)) then 'guest'
  end
$$;
-- an Apps Script token: base64url(email|expiry ms) . base64url(hmac sha256 with CL_SECRET)
create or replace function app.legacy_token_email(t text) returns text language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare parts text[] := string_to_array(t, '.'); payload text; sig text; sec text := app.secret('cl_secret'); e text; exp_ms bigint; issued timestamptz; cut timestamptz;
begin
  if sec is null or array_length(parts, 1) <> 2 then return null; end if;
  begin payload := convert_from(app.b64url_dec(parts[1]), 'UTF8'); exception when others then return null; end;
  sig := app.b64url(hmac(convert_to(payload, 'UTF8'), convert_to(sec, 'UTF8'), 'sha256'));
  if sig <> parts[2] then return null; end if;
  e := lower(split_part(payload, '|', 1));
  begin exp_ms := split_part(payload, '|', 2)::bigint; exception when others then return null; end;
  if to_timestamp(exp_ms / 1000.0) < now() then return null; end if;
  issued := to_timestamp(exp_ms / 1000.0) - make_interval(days => app.setting_int('{login,tokenDays}', 180));
  select at into cut from app.signout_before where email = e;
  if cut is not null and issued <= cut then return null; end if;
  cut := nullif(app.secret('signout_all_at'), '')::timestamptz;
  if cut is not null and issued <= cut then return null; end if;
  return e;
end $$;
create or replace function app.resolve_identity(p_key text, p_token text) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare s public.staff; e text; r text; ses app.sessions; cut timestamptz;
begin
  if coalesce(p_key, '') <> '' then
    select st.* into s from app.staff_keys k join public.staff st on st.id = k.staff_id where k.key_hash = app.sha(p_key) and st.active;
    if s.id is null then return null; end if;
    return jsonb_build_object('role', s.role, 'staff', s.id);
  end if;
  if coalesce(p_token, '') = '' then return null; end if;
  if p_token like 'wb1.%' then
    select * into ses from app.sessions where token_hash = app.sha(p_token);
    if ses.token_hash is null or ses.revoked_at is not null or ses.expires_at < now() then return null; end if;
    select at into cut from app.signout_before where email = lower(ses.email);
    if cut is not null and ses.created_at <= cut then return null; end if;
    if ses.last_seen_at is null or ses.last_seen_at < now() - interval '1 hour' then
      update app.sessions set last_seen_at = now() where token_hash = ses.token_hash;
    end if;
    e := lower(ses.email);
  else
    e := app.legacy_token_email(p_token);
  end if;
  if e is null then return null; end if;
  r := app.email_role(e);
  if r is null then return null; end if;                                  -- like clWho_: no account, no sign in
  return jsonb_build_object('role', r, 'email', e);
end $$;

-- ---------------------------------------------------------------------
-- THE API DOOR (service role only)
-- ---------------------------------------------------------------------
create or replace function public.wb_call(p_action text, p_key text default null, p_token text default null, p_body jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare a app.api_actions; who jsonb; v text; r jsonb; b jsonb := coalesce(p_body, '{}'::jsonb); edet text; ej jsonb;
begin
  select * into a from app.api_actions where action = p_action and enabled;
  if a.action is null or to_regprocedure('public.' || quote_ident(a.fn) || '(jsonb)') is null then
    return jsonb_build_object('ok', false, 'error', 'unknown action');
  end if;
  who := app.resolve_identity(p_key, p_token);
  if a.needs = 'staff' and (who is null or who->>'role' not in ('owner', 'assistant', 'trainer')) then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if a.needs = 'client' and (who is null or who->>'role' not in ('client', 'guest')) then
    return jsonb_build_object('ok', false, 'error', 'signin');
  end if;
  if a.needs = 'any' and who is null then
    return jsonb_build_object('ok', false, 'error', case when coalesce(p_key, '') <> '' then 'auth' else 'signin' end);
  end if;
  who := coalesce(who, '{"role":"anon"}'::jsonb);
  -- nothing in the body speaks for the caller
  b := b - 'action' - 'key' - 'token' - '_pre' - '_ident' - 'identity';
  v := who::text;
  perform set_config('wb.identity', v, true);
  perform set_config('wb.identity_sig', app.hmac_hex(v, app.secret('ident_key')), true);
  begin
    execute format('select public.%I($1)', a.fn) into r using b;
  exception when others then
    get stacked diagnostics edet = pg_exception_detail;
    perform set_config('wb.identity', '', true); perform set_config('wb.identity_sig', '', true);
    -- flags raised with "using detail = '{"full":true}'" go out next to the error, like the Apps Script {ok:false, full:true, error}
    begin ej := case when edet like '{%' then edet::jsonb end; exception when others then ej := null; end;
    return jsonb_build_object('ok', false, 'error', sqlerrm) || case when jsonb_typeof(ej) = 'object' then ej - 'ok' - 'error' else '{}'::jsonb end;
  end;
  perform set_config('wb.identity', '', true); perform set_config('wb.identity_sig', '', true);
  if r is null then return jsonb_build_object('ok', true); end if;
  if jsonb_typeof(r) = 'object' then
    if r ? 'ok' and r->>'ok' = 'false' then return r; end if;
    return jsonb_build_object('ok', true) || (r - 'ok');
  end if;
  return jsonb_build_object('ok', true, 'result', r);
end $$;

-- every public.api_<action>(jsonb) becomes a whitelisted action. Who may call it, by name:
--   app_cl_*  clients and guests      app_*  staff      anything else  no sign in (landing page)
-- Run again after adding API functions:  select app.api_sync();
-- Switch one off:  update app.api_actions set enabled = false where action = '...';
create or replace function app.api_sync() returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; f record;
begin
  for f in select p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname like 'api\_%' and p.pronargs = 1 and p.proargtypes[0] = 'jsonb'::regtype
  loop
    insert into app.api_actions (action, fn, needs)
    values (substr(f.proname, 5), f.proname,
            case when f.proname like 'api\_app\_cl\_%' then 'client' when f.proname like 'api\_app\_%' then 'staff' else 'none' end)
    on conflict (action) do update set fn = excluded.fn;
    -- the API functions are reached only through the door, never directly
    execute format('revoke execute on function public.%I(jsonb) from public, anon, authenticated', f.proname);
    n := n + 1;
  end loop;
  delete from app.api_actions a where to_regprocedure('public.' || quote_ident(a.fn) || '(jsonb)') is null;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- client sign in with a code (the edge function sends the email)
-- ---------------------------------------------------------------------
create or replace function public.wb_login_code(p_email text, p_mode text default null, p_name text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email, ''))); r text; nm text := left(trim(coalesce(p_name, '')), 60); out jsonb := '{"ok":true}'::jsonb;
  code text; sent15 int; today_n int; first text;
begin
  if e !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return jsonb_build_object('ok', false, 'error', 'Please type a valid email.'); end if;
  r := app.email_role(e);
  if r is null then
    if coalesce(p_mode, '') <> 'new' then return jsonb_build_object('ok', false, 'error', 'unknown'); end if;
    if length(regexp_replace(nm, '[^A-Za-z؀-ۿ]', '', 'g')) < 2 then return jsonb_build_object('ok', false, 'error', 'Please type your name.'); end if;
    out := out || '{"guest":true}';
  elsif r = 'guest' then out := out || '{"guest":true}'; nm := null;
  else nm := null; if p_mode = 'new' then out := out || '{"client":true}'; end if;
  end if;
  select count(*) into sent15 from app.login_sends where email = e and at > now() - interval '15 minutes';
  if sent15 >= 3 then return jsonb_build_object('ok', false, 'error', 'Too many codes asked. Wait 15 minutes, then try again.'); end if;
  select count(*) into today_n from app.login_sends where email = e and (at at time zone 'Asia/Beirut')::date = app_today();
  if today_n >= app.setting_int('{login,codesPerDay}', 8) then
    return jsonb_build_object('ok', false, 'error', 'Too many codes for this email today. Try again tomorrow, or message ' || app.desk_name() || ' on WhatsApp.');
  end if;
  code := (100000 + (('x' || app.rand_hex(8))::bit(32)::bigint % 900000))::text;
  insert into app.login_codes (email, code_hash, name, tries, expires_at) values (e, app.sha(e || ':' || code), nm, 0, now() + interval '10 minutes')
  on conflict (email) do update set code_hash = excluded.code_hash, name = coalesce(excluded.name, app.login_codes.name), tries = 0, expires_at = excluded.expires_at;
  insert into app.login_sends (email) values (e);
  delete from app.login_sends where at < now() - interval '2 days';
  select split_part(coalesce(nm, (select c.name from public.clients c where c.deleted_at is null and (lower(c.email) = e or lower(c.parent_email) = e)
                                  order by (c.kind = 'client') desc, c.created_at limit 1), ''), ' ', 1) into first;
  -- the code goes back ONLY to the edge function (service role), which emails it
  return out || jsonb_build_object('code', code, 'first', coalesce(first, ''), 'email', e, 'desk', app.desk_name());
end $$;
-- the email could not be sent: the code is dropped (like the Apps Script)
create or replace function public.wb_login_code_cancel(p_email text) returns void language sql volatile security definer set search_path = public as $$
  delete from app.login_codes where email = lower(trim(coalesce(p_email, '')))
$$;
create or replace function public.wb_login_verify(p_email text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email, ''))); c text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g'); lc app.login_codes; tok text; g public.clients; gid text;
begin
  if e = '' or length(c) <> 6 then return jsonb_build_object('ok', false, 'error', 'Type the 6 digit code from the email.'); end if;
  select * into lc from app.login_codes where email = e;
  if lc.email is null or lc.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'This code expired. Ask for a new one.'); end if;
  if lc.tries >= 5 then delete from app.login_codes where email = e; return jsonb_build_object('ok', false, 'error', 'Too many tries. Ask for a new code.'); end if;
  if lc.code_hash <> app.sha(e || ':' || c) then
    update app.login_codes set tries = tries + 1 where email = e;
    return jsonb_build_object('ok', false, 'error', 'Wrong code. ' || (4 - lc.tries) || ' tries left.');
  end if;
  delete from app.login_codes where email = e;
  if app.email_role(e) is null then                                       -- a new person: the guest row is made now that the email is proven
    if coalesce(lc.name, '') = '' then return jsonb_build_object('ok', false, 'error', 'Please start again and type your name.'); end if;
    select 'G' || lpad((coalesce(max(substring(legacy_id from '^G(\d+)$')::int), 0) + 1)::text, 4, '0') into gid from public.clients where legacy_id ~ '^G\d+$';
    insert into public.clients (legacy_id, kind, name, email) values (gid, 'guest', lc.name, e);
  end if;
  select * into g from public.clients where kind = 'guest' and deleted_at is null and lower(email) = e order by created_at limit 1;
  if g.id is not null and g.verified_at is null and app.email_role(e) = 'guest' then   -- first sign in of a new person: tell the owner and the desk
    update public.clients set verified_at = now() where id = g.id;
    insert into public.outbox (channel, to_staff, body)
    select 'whatsapp', x, 'NEW APP SIGN UP (not a client yet)' || chr(10) || g.name || chr(10) || e || chr(10) ||
           'They are looking at the packages. If they ask for a trial or a call, you get another message.'
      from (select app.desk_id() as x union select id from public.staff where role = 'owner' and active) s where x <> '';
  end if;
  tok := 'wb1.' || app.b64url(decode(app.rand_hex(64), 'hex'));
  insert into app.sessions (token_hash, email, expires_at) values (app.sha(tok), e, now() + make_interval(days => app.setting_int('{login,tokenDays}', 180)));
  return jsonb_build_object('ok', true, 'token', tok);
end $$;
-- sign out this phone
create or replace function public.wb_signout(p_token text) returns void language sql volatile security definer set search_path = public as $$
  update app.sessions set revoked_at = now() where token_hash = app.sha(p_token) and revoked_at is null
$$;
-- side by side week: the phone reports whether both servers answered the same
create or replace function public.wb_shadow(p_key text, p_token text, p_action text, p_same boolean, p_diff jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare who jsonb := app.resolve_identity(p_key, p_token);
begin
  if who is null then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  insert into app.shadow_log (action, who, same, diff)
  values (left(coalesce(p_action, ''), 60), coalesce(who->>'staff', who->>'email'), coalesce(p_same, false),
          case when p_diff is null or length(p_diff::text) > 20000 then jsonb_build_object('truncated', true) else p_diff end);
  return jsonb_build_object('ok', true);
end $$;

-- who is calling (for other edge functions, e.g. upload): {role, staff} or {role, email}, null if not signed in
create or replace function public.wb_whoami(p_key text, p_token text) returns jsonb language sql volatile security definer set search_path = public as $$
  select app.resolve_identity(p_key, p_token) $$;

-- ---------------------------------------------------------------------
-- owner tools (run in the SQL editor; or through the API as the owner)
-- ---------------------------------------------------------------------
create or replace function app.owner_or_system() returns void language plpgsql stable as $$
begin if app.caller()->>'role' not in ('owner', 'system') then raise exception 'not allowed'; end if; end $$;
-- copy today's staff links: select app.import_staff_keys('<APP_KEYS value from Script Properties>'::jsonb);
create or replace function app.import_staff_keys(p jsonb) returns int language plpgsql volatile security definer set search_path = public as $$
declare k text; n int := 0;
begin
  perform app.owner_or_system();
  for k in select jsonb_object_keys(p) loop
    if exists (select 1 from public.staff where id = k) and coalesce(p->>k, '') <> '' then
      insert into app.staff_keys (staff_id, key_hash) values (k, app.sha(p->>k))
      on conflict (staff_id) do update set key_hash = excluded.key_hash, created_at = now();
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
-- keep today's client sign ins working: select app.import_legacy_auth('<CL_SECRET>', '<CL_DELETED or {}>'::jsonb);
create or replace function app.import_legacy_auth(p_cl_secret text, p_deleted jsonb default '{}'::jsonb) returns int language plpgsql volatile security definer set search_path = public as $$
declare k text; n int := 0;
begin
  perform app.owner_or_system();
  if coalesce(p_cl_secret, '') <> '' then
    insert into app.secrets (key, value) values ('cl_secret', p_cl_secret) on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  for k in select jsonb_object_keys(coalesce(p_deleted, '{}'::jsonb)) loop
    insert into app.signout_before (email, at) values (lower(k), to_timestamp((p_deleted->>k)::bigint / 1000.0))
    on conflict (email) do update set at = greatest(app.signout_before.at, excluded.at);
    n := n + 1;
  end loop;
  return n;
end $$;
-- a new private link for one person (lost phone, left the team): returns the key, put it in their link #k=...
create or replace function app.reset_staff_key(p_staff text) returns text language plpgsql volatile security definer set search_path = public as $$
declare k text := app.rand_hex(32);
begin
  perform app.owner_or_system();
  if not exists (select 1 from public.staff where id = p_staff) then raise exception 'No staff %', p_staff; end if;
  insert into app.staff_keys (staff_id, key_hash) values (p_staff, app.sha(k)) on conflict (staff_id) do update set key_hash = excluded.key_hash, created_at = now();
  return k;
end $$;
-- every client and guest signs in again (old Apps Script tokens too)
create or replace function app.signout_everyone() returns void language plpgsql volatile security definer set search_path = public as $$
begin
  perform app.owner_or_system();
  update app.sessions set revoked_at = now() where revoked_at is null;
  insert into app.secrets (key, value) values ('signout_all_at', now()::text) on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;
-- account deletion asked: every sign in of this email until now is dead
create or replace function app.revoke_email(p_email text) returns void language plpgsql volatile security definer set search_path = public as $$
begin
  insert into app.signout_before (email, at) values (lower(p_email), now()) on conflict (email) do update set at = now();
  update app.sessions set revoked_at = now() where lower(email) = lower(p_email) and revoked_at is null;
end $$;
-- the owner can do the same from the app
create or replace function public.api_app_signout_everyone(p jsonb) returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if app.caller()->>'role' <> 'owner' then raise exception 'not allowed'; end if;
  perform app.signout_everyone();
  return jsonb_build_object('done', true);
end $$;

-- ---------------------------------------------------------------------
-- settings used here (added only when missing)
-- ---------------------------------------------------------------------
-- login.codesPerDay (8) and login.tokenDays (180) use those defaults. No settings row on purpose: every settings row
-- is sent to the apps in boot (cfg), and Config.gs has no login group. To change them later, add a 'login' row.

-- ---------------------------------------------------------------------
-- grants: the door and the login functions are for the edge function (service role) only
-- ---------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'public.wb_call(text,text,text,jsonb)', 'public.wb_login_code(text,text,text)', 'public.wb_login_code_cancel(text)',
    'public.wb_login_verify(text,text)', 'public.wb_signout(text)', 'public.wb_shadow(text,text,text,boolean,jsonb)', 'public.wb_whoami(text,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- new private helpers: nobody calls them directly
  foreach f in array array[
    'app.sha(text)', 'app.b64url(bytea)', 'app.b64url_dec(text)', 'app.secret(text)', 'app.rand_hex(int)', 'app.from_api_role()', 'app.hmac_hex(text,text)',
    'app.ident()', 'app.my_email()', 'app.email_role(text)', 'app.legacy_token_email(text)', 'app.resolve_identity(text,text)', 'app.api_sync()',
    'app.owner_or_system()', 'app.import_staff_keys(jsonb)', 'app.import_legacy_auth(text,jsonb)', 'app.reset_staff_key(text)',
    'app.signout_everyone()', 'app.revoke_email(text)', 'app.no_change()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- register every API function that exists now (0003 to 0007 and the one above)
select app.api_sync();
