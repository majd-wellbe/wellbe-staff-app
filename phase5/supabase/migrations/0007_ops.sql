-- =====================================================================
-- WELLBE on Supabase: 0007 operations (Phase 5 port, part C)
-- Every staff and client write action of the apps becomes public.api_<action>(p jsonb) returns jsonb.
--  p   = the body the app sends today (legacy IDs C012 / PKG-0173 / S13-0001 / REQ-0001, or the new uuids)
--  out = the same object the Apps Script returns, without "ok"; IDs in it are the legacy IDs
-- Security definer, search_path fixed, the role is checked inside with app.need / app.need_client (0002/0003),
-- with the same rules as the Apps Script router: staff only actions refuse trainers ('not allowed'),
-- intake and upload are owner only, client actions refuse another person's account ('Not your account').
-- Existing 0003 functions are wrapped where they exist (sell, pay, book, attendance, cancel, join, upgrade, requests).
-- =====================================================================

-- ---------------------------------------------------------------------
-- schema additions (all additive)
-- ---------------------------------------------------------------------
alter table public.expenses add column if not exists legacy_id text unique;                  -- EXP-000123
alter table public.clients add column if not exists discount_pct numeric(6,2) not null default 0;   -- CLIENT NOTES col H "Discount %"
alter table public.pos_sales add column if not exists legacy_id text unique;                 -- POSS-0042
alter table public.pos_sales add column if not exists buyer text;                            -- "To" (free text)
alter table public.pos_sales add column if not exists cost_cents int;                        -- unit cost at the sale
alter table public.pos_sales add column if not exists profit_cents int;
alter table public.pos_sales add column if not exists status text;                           -- 'Paid'
alter table public.pos_sales add column if not exists note text;                             -- 'via app (Romy)'
alter table public.inventory add column if not exists sold int not null default 0;           -- POS INVENTORY col H

-- ---------------------------------------------------------------------
-- security fix: app.caller() is security definer, so current_user inside it is always the owner.
-- 0003 treated "no profile + owner" as the system, which made ANY signed in user without a profile row 'system'.
-- Now: a request with a JWT (auth.uid() set) or with the anon/authenticated role is never the system.
-- Also: a client who asked to delete their account is signed out (tokens issued before the request are refused,
-- like Client.gs clDeny_).
-- ---------------------------------------------------------------------
create or replace function app.caller() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; s public.staff; r text := coalesce(nullif(current_setting('role', true), ''), 'none'); iat numeric;
begin
  select * into p from public.profiles where user_id = auth.uid();
  if p.user_id is null then
    if auth.uid() is null and r not in ('anon', 'authenticated') and current_user in ('postgres', 'service_role', 'supabase_admin') then
      return jsonb_build_object('role', 'system', 'name', 'system');
    end if;
    return jsonb_build_object('role', 'anon');
  end if;
  if p.staff_id is not null then
    select * into s from public.staff where id = p.staff_id and active;
    if s.id is null then return jsonb_build_object('role', 'anon'); end if;
    return jsonb_build_object('role', p.role, 'staff', s.id, 'trainer', s.trainer, 'name', s.name);
  end if;
  iat := nullif(auth.jwt()->>'iat', '')::numeric;
  if iat is not null and exists (select 1 from public.deletion_requests d where lower(d.email) = lower(p.email) and d.status = 'New' and d.created_at >= to_timestamp(iat)) then
    return jsonb_build_object('role', 'anon');
  end if;
  return jsonb_build_object('role', p.role, 'name', 'client app', 'email', p.email);
end $$;

-- ---------------------------------------------------------------------
-- small helpers (app.ops_*: internal, not callable by the API)
-- ---------------------------------------------------------------------
-- Code.gs clean_: one line, trimmed, max length (a leading = + - @ costs one character, the sheet kept a ')
create or replace function app.ops_clean(v text, mx int) returns text language sql immutable as $$
  select case when s ~ '^[=+@-]' then left(s, mx - 1) else left(s, mx) end
    from (select btrim(regexp_replace(coalesce(v, ''), '[\r\n]+', ' ', 'g')) as s) x
$$;
-- JavaScript Number(v): null for NaN (undefined, 'abc'), 0 for '' and null
create or replace function app.ops_num(v jsonb) returns numeric language plpgsql immutable as $$
declare s text;
begin
  if v is null then return null; end if;
  case jsonb_typeof(v)
    when 'number' then return (v #>> '{}')::numeric;
    when 'null' then return 0;
    when 'boolean' then return case when v = 'true'::jsonb then 1 else 0 end;
    when 'string' then
      s := btrim(v #>> '{}');
      if s = '' then return 0; end if;
      if s ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return s::numeric; end if;
      return null;
    else return null;
  end case;
end $$;
create or replace function app.ops_ymd(v text) returns date language sql immutable as $$
  select case when coalesce(v, '') ~ '^\d{4}-\d{2}-\d{2}$' then v::date end
$$;
-- legacy ID or uuid -> uuid
create or replace function app.ops_uuid(v text) returns uuid language sql immutable as $$
  select case when coalesce(v, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end
$$;
create or replace function app.ops_cid(v text) returns uuid language sql stable security definer set search_path = public as $$
  select coalesce((select id from public.clients where id = app.ops_uuid(v)), (select id from public.clients where legacy_id = upper(btrim(coalesce(v, '')))))
$$;
create or replace function app.ops_pkg(v text) returns uuid language sql stable security definer set search_path = public as $$
  select coalesce((select id from public.packages where id = app.ops_uuid(v)), (select id from public.packages where legacy_id = btrim(coalesce(v, ''))))
$$;
create or replace function app.ops_sess(v text) returns uuid language sql stable security definer set search_path = public as $$
  select coalesce((select id from public.sessions where id = app.ops_uuid(v)), (select id from public.sessions where legacy_id = btrim(coalesce(v, ''))))
$$;
create or replace function app.ops_req(v text) returns uuid language sql stable security definer set search_path = public as $$
  select coalesce((select id from public.client_requests where id = app.ops_uuid(v)), (select id from public.client_requests where legacy_id = btrim(coalesce(v, ''))))
$$;
create or replace function app.ops_lid(p_pkg uuid) returns text language sql stable security definer set search_path = public as $$
  select legacy_id from public.packages where id = p_pkg
$$;
-- phones the way the import stores them (961...), and Code.gs phoneKey_ for matching
create or replace function app.ops_phone(v text) returns text language plpgsql immutable as $$
declare d text := regexp_replace(regexp_replace(regexp_replace(coalesce(v, ''), '[^0-9+]', '', 'g'), '^\+', ''), '^00', '');
begin
  if d = '' then return null; end if;
  if d ~ '^0[0-9]{6,8}$' then return '961' || substr(d, 2); end if;
  if d ~ '^[1-9][0-9]{6,7}$' then return '961' || d; end if;
  return d;
end $$;
create or replace function app.ops_phone_key(v text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(v, ''), '\D', '', 'g'), '^00', ''), '^961', ''), '^0', '')
$$;
-- Code.gs emailOk_
create or replace function app.ops_email_ok(e text) returns boolean language sql immutable as $$
  select x <> '' and length(x) <= 120 and x !~ '^[=+@-]' and position('..' in x) = 0
     and x ~ '^[a-z0-9]([a-z0-9._%+-]*[a-z0-9_-])?@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}$'
    from (select lower(btrim(coalesce(e, ''))) as x) y
$$;
-- JavaScript encodeURIComponent
create or replace function app.ops_uri(s text) returns text language plpgsql immutable as $$
declare b bytea := convert_to(coalesce(s, ''), 'UTF8'); o text := ''; i int; c int;
begin
  for i in 0 .. length(b) - 1 loop
    c := get_byte(b, i);
    if c between 48 and 57 or c between 65 and 90 or c between 97 and 122 or c in (45, 95, 46, 33, 126, 42, 39, 40, 41) then o := o || chr(c);
    else o := o || '%' || upper(lpad(to_hex(c), 2, '0')); end if;
  end loop;
  return o;
end $$;
-- Code.gs toHour_ / hourLabel_
create or replace function app.ops_to_hour(s text) returns int language plpgsql immutable as $$
declare m text[]; h int; ap text;
begin
  m := regexp_match(btrim(coalesce(s, '')), '^(\d{1,2})(?::(\d{2}))?\s*([aApP]\.?[mM]\.?)?');
  if m is null then return null; end if;
  h := m[1]::int; ap := lower(coalesce(m[3], ''));
  if left(ap, 1) = 'p' and h < 12 then h := h + 12; end if;
  if left(ap, 1) = 'a' and h = 12 then h := 0; end if;
  return h;
end $$;
create or replace function app.ops_hour_label(h int) returns text language sql immutable as $$
  select case when h is null then '' else (case when h % 12 = 0 then 12 else h % 12 end) || ':00 ' || case when h < 12 then 'AM' else 'PM' end end
$$;
-- App.gs app12Mark_: the last "Name: <attendance>" mark of a client in a 1:2 note
create or replace function app.ops_mark12(note text, nm text) returns text language sql immutable as $$
  select case when btrim(coalesce(nm, '')) = '' then '' else coalesce((
    select m[1] from regexp_matches(coalesce(note, ''), regexp_replace(btrim(nm), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || ': (Present|Late Cancel|No Show|Early Cancel)', 'g') with ordinality t(m, n)
     order by n desc limit 1), '') end
$$;
create or replace function app.ops_stamp() returns text language sql stable as $$
  select to_char(now() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'), 'DD/MM/YYYY HH24:MI')
$$;
-- a date + n days counted in hours from Beirut midnight (Code.gs: new Date(start + n * 86400000)), so DST shifts it like the sheet
create or replace function app.ops_plus_ms_days(d date, n int) returns date language sql stable as $$
  select (((d::timestamp at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut')) + make_interval(hours => 24 * n))
          at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'))::date
$$;
-- Code.gs getOrCreateClient_: same phone (any format), then same name, else a new C id (highest + 1, same padding)
create or replace function app.ops_client(p_name text, p_phone text, p_email text) returns jsonb language plpgsql security definer set search_path = public as $$
declare key text := app.ops_phone_key(p_phone); c public.clients; mx text; n bigint; lid text; u uuid; em text := lower(btrim(coalesce(p_email, '')));
begin
  perform pg_advisory_xact_lock(hashtext('legacy:C'));
  if key <> '' then
    select * into c from public.clients where kind = 'client' and legacy_id ~ '^C\d+$' and deleted_at is null and app.ops_phone_key(phone) = key
     order by substring(legacy_id from 2)::bigint limit 1;
    if c.id is not null then return jsonb_build_object('id', c.legacy_id, 'uuid', c.id, 'isNew', false); end if;
  end if;
  select * into c from public.clients where kind = 'client' and legacy_id ~ '^C\d+$' and deleted_at is null and lower(btrim(name)) = lower(btrim(p_name))
   order by substring(legacy_id from 2)::bigint limit 1;
  if c.id is not null then return jsonb_build_object('id', c.legacy_id, 'uuid', c.id, 'isNew', false); end if;
  select substring(legacy_id from 2) into mx from public.clients where legacy_id ~ '^C\d+$' order by substring(legacy_id from 2)::bigint desc, length(legacy_id) limit 1;
  n := coalesce(mx::bigint, 0);
  lid := 'C' || lpad((n + 1)::text, greatest(coalesce(length(mx), 3), length((n + 1)::text)), '0');
  insert into public.clients (legacy_id, kind, name, email, phone) values (lid, 'client', p_name, case when app.ops_email_ok(em) then em end, app.ops_phone(p_phone))
  returning id into u;
  return jsonb_build_object('id', lid, 'uuid', u, 'isNew', true);
end $$;
create or replace function app.ops_note_row(p_client uuid) returns void language sql security definer set search_path = public as $$
  insert into public.client_notes (client_id, always_show, program, updated_by) values (p_client, '', '', null) on conflict (client_id) do nothing
$$;
create or replace function app.ops_session_ref(p jsonb) returns public.sessions language plpgsql stable security definer set search_path = public as $$
declare s public.sessions;
begin
  -- id (legacy or uuid), or the ref the Supabase boot sends: '<kind>|<legacy id>' (the Apps Script sent '<kind>|<sheet row>')
  select * into s from public.sessions where id = coalesce(app.ops_sess(nullif(p->>'id', '')), app.ops_sess(nullif(p->>'session', '')),
                                                           app.ops_sess(nullif(split_part(coalesce(p->>'ref', ''), '|', 2), '')));
  if s.id is null then raise exception 'Session % not found, refresh', coalesce(nullif(p->>'id', ''), split_part(coalesce(p->>'ref', ''), '|', 2)); end if;
  return s;
end $$;
-- the staff freeze (Client.gs clFreezeApply_): effective end first, then extended, then default
create or replace function app.ops_freeze(p_pkg uuid, p_from text, p_by text) returns date language plpgsql security definer set search_path = public as $$
declare p public.packages; cur_end date; new_end date; n int := app.setting_int('{windows,freezeDays}', 7);
begin
  select * into p from public.packages where id = p_pkg for update;
  if p.id is null then raise exception 'Package % not found', p_pkg; end if;
  cur_end := coalesce(p.effective_expiry, p.extended_expiry, p.expiry_date);
  if cur_end is null then raise exception 'Package % has no end date: fix it in the sheet first', p.legacy_id; end if;
  new_end := cur_end + n;
  update public.packages set extended_expiry = new_end, effective_expiry = new_end,
    note = app.append_note(note, 'Frozen ' || n || ' days from ' || coalesce(p_from, '') || ', ends ' || new_end || ' (' || p_by || ')') where id = p.id;
  return new_end;
end $$;
-- Client.gs clSlots_: physio slots (hours per weekday, notice, minus the physio's sessions and waiting requests).
-- The physio's Google Calendar is not read here (events outside the app).
create or replace function app.ops_physio_free(p_day date, p_time text) returns boolean language plpgsql stable security definer set search_path = public as $$
declare today date := app_today(); days int := app.setting_int('{windows,physioDays}', 14); nh int := app.setting_int('{windows,physioNoticeH}', 12);
  until date := today + days + 1; a timestamptz; who text := app.fixed_trainer('Physio');
begin
  if p_day is null or p_time !~ '^\d{2}:\d{2}$' or p_day < today or p_day > today + days then return false; end if;
  if not coalesce(app.setting(array['hours', 'physio', extract(dow from p_day)::int::text]) ? p_time, false) then return false; end if;
  if coalesce(app.setting('{hours,blocked}') ? p_day::text, false) then return false; end if;
  a := app.at(p_day, p_time::time);
  if a - now() < make_interval(hours => nh) then return false; end if;
  if exists (select 1 from public.sessions s where s.trainer = who and s.status <> 'Cancelled' and s.day between today and until
               and app.at(s.day, s.start_time) < a + interval '1 hour' and app.at(s.day, s.start_time) + interval '1 hour' > a) then return false; end if;
  if exists (select 1 from public.client_requests q where q.type = 'Physio visit' and q.status = 'New' and q.slot ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$'
               and app.at(split_part(q.slot, ' ', 1)::date, split_part(q.slot, ' ', 2)::time) < a + interval '1 hour'
               and app.at(split_part(q.slot, ' ', 1)::date, split_part(q.slot, ' ', 2)::time) + interval '1 hour' > a) then return false; end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- 21:30 default Present (App.gs appDefaultPresent), the open rule per kind exactly as the sheet:
--  1:3 = no attendance yet; 1:2 = no pass flag yet (the partner of a late cancel is still Present);
--  one client = row still Scheduled. Rows whose status says cancel are skipped.
-- ---------------------------------------------------------------------
create or replace function public.default_present() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; pk uuid[] := '{}';
begin
  perform app.need(array['owner']);
  for r in select sc.session_id, sc.slot, sc.package_id from public.sessions s join public.session_clients sc on sc.session_id = s.id
            where s.day = app_today() and s.status !~* 'cancel'
              and case when s.kind = '1:3' then sc.att = '' when s.kind = '1:2' then sc.pass = '' else s.status in ('Scheduled', '') end
            order by s.legacy_id, sc.slot loop
    perform app.set_att(r.session_id, r.slot, 'Present', 'auto 21:30', '', false, false);
    pk := pk || r.package_id; n := n + 1;
  end loop;
  perform app.recount(x) from (select distinct unnest(pk) x) y;
  return n;
end $$;

-- =====================================================================
-- STAFF ACTIONS
-- =====================================================================
-- app_att { id, i, att }: trainers only on their own sessions
create or replace function public.api_app_att(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); s public.sessions; c public.session_clients; pkg uuid; att text := coalesce(p->>'att', ''); v_slot int := coalesce(app.ops_num(p->'i'), 0)::int;
  had_mark boolean;
begin
  s := app.ops_session_ref(p);
  if me->>'role' = 'trainer' and s.trainer is distinct from me->>'trainer' then raise exception 'Not your session'; end if;
  select * into c from public.session_clients sc where sc.session_id = s.id and sc.slot = v_slot;
  had_mark := s.kind = '1:2' and att = 'Present' and app.ops_mark12(s.note, c.name) <> '';
  pkg := app.set_att(s.id, v_slot, att, me->>'name', '', false, false);
  if had_mark then   -- Present overrides an older Late Cancel / No Show mark in the note (App.gs appSetAtt_)
    update public.sessions set note = app.append_note(note, btrim(c.name) || ': Present via app, ' || (me->>'name')) where id = s.id;
  end if;
  return jsonb_build_object('pkg', app.ops_lid(pkg), 'used', app.recount(pkg));
end $$;

-- app_change { id, what: cancel|trainer|move, who: 'all'|slot, kind, reason, trainer, date, time }
create or replace function public.api_app_change(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); s public.sessions; filled int[]; targets int[]; i int; pk uuid; pks uuid[] := '{}';
  fixed text; tr text; d date; t time; c public.session_clients; res jsonb; what text := coalesce(p->>'what', '');
begin
  s := app.ops_session_ref(p);
  select coalesce(array_agg(slot order by slot), '{}') into filled from public.session_clients where session_id = s.id;
  targets := case when p->>'who' = 'all' or cardinality(filled) = 1 then filled else array[coalesce(app.ops_num(p->'who'), -1)::int] end;
  fixed := nullif(app.fixed_trainer(s.kind), '');
  if what = 'cancel' then
    if s.kind = '1:2' and p->>'kind' = 'Early Cancel' then
      perform app.set_att(s.id, targets[1], 'Early Cancel', me->>'name', coalesce(p->>'reason', ''),
        cardinality(targets) = cardinality(filled) and cardinality(filled) > 1, (me->>'staff') is distinct from app.desk_id());
      return '{}';
    end if;
    foreach i in array targets loop pks := pks || app.set_att(s.id, i, coalesce(p->>'kind', ''), me->>'name', coalesce(p->>'reason', '')); end loop;
    if cardinality(targets) = cardinality(filled) and s.kind = '1:3' and coalesce(p->>'kind', '') ~* 'cancel' then
      update public.sessions set status = 'Cancelled' where id = s.id;
    end if;
    perform app.recount(x) from (select distinct unnest(pks) x) y;
    return '{}';
  end if;
  if what = 'trainer' then
    if fixed is not null then raise exception 'This session type has a fixed practitioner'; end if;
    perform app.cap_check(coalesce(p->>'trainer', ''), s.day, s.start_time, cardinality(filled));
    update public.sessions set trainer = app.trainer_name(p->>'trainer') where id = s.id;
    update public.session_clients set gcal_event = null where session_id = s.id;
    return '{}';
  end if;
  if what = 'move' then
    if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p->>'time', '') !~ '^\d{2}:\d{2}$' then raise exception 'Pick a valid day and time'; end if;
    d := (p->>'date')::date; t := (p->>'time')::time; tr := coalesce(fixed, s.trainer);
    if cardinality(targets) = cardinality(filled) then
      perform app.cap_check(tr, d, t, cardinality(filled));
      update public.sessions set day = d, start_time = t, end_time = t + interval '1 hour' where id = s.id;
      update public.session_clients set gcal_event = null where session_id = s.id;
      return '{}';
    end if;
    select * into c from public.session_clients where session_id = s.id and slot = targets[1];
    if c.package_id is null then raise exception 'No client in that spot'; end if;
    if fixed is null then perform app.cap_check(tr, d, t, 1); end if;
    perform app.kind_ok(s.kind, c.package_id);
    if exists (select 1 from public.sessions x join public.session_clients y on y.session_id = x.id
                where x.day = d and x.start_time = t and x.status !~* 'cancel' and y.package_id = c.package_id) then
      raise exception 'This client already has a session on % at %.', d, p->>'time';
    end if;
    delete from public.session_clients where session_id = s.id and slot = c.slot;
    res := app.book_into(s.kind, d, t, tr, c.package_id, c.name);   -- fails: the whole change rolls back, the client keeps the old spot
    perform app.recount(c.package_id);
    return jsonb_build_object('id', res->>'id', 'joined', (res->>'joined')::boolean);
  end if;
  raise exception 'Unknown change';
end $$;

-- app_book { type, date, time, trainer, pkg, name, restart }
create or replace function public.api_app_book(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); r jsonb; pkg uuid := app.ops_pkg(p->>'pkg');
begin
  if coalesce(p->>'type', '') not in ('1:1', '1:2', '1:3', 'Physio', 'Prehab', 'Osteo', 'Madero') then raise exception 'Unknown session type'; end if;
  if pkg is null then raise exception 'Package % not found', coalesce(p->>'pkg', ''); end if;
  r := public.book_session(p->>'type', app.ops_ymd(p->>'date'), (p->>'time')::time, coalesce(p->>'trainer', ''), pkg,
         app.ops_clean(p->>'name', 80), coalesce((p->>'restart')::boolean, false));
  return jsonb_build_object('id', r->>'id', 'joined', (r->>'joined')::boolean);
end $$;

-- app_week { items: [{ type, date, time, trainer, clients: [{ pkg, name }] }] }: each client booked on its own, failures listed
create or replace function public.api_app_week(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); it jsonb; c jsonb; k text; added int := 0; skipped text[] := '{}';
begin
  for it in select * from jsonb_array_elements(coalesce(p->'items', '[]')) loop
    k := it->>'type';
    continue when k is null or k not in ('1:1', '1:2', '1:3', 'Physio', 'Prehab', 'Osteo', 'Madero');
    for c in select * from jsonb_array_elements(coalesce(it->'clients', '[]')) loop
      begin
        perform app.book_into(k, (it->>'date')::date, (it->>'time')::time, coalesce(it->>'trainer', ''), app.ops_pkg(c->>'pkg'), coalesce(c->>'name', ''));
        added := added + 1;
      exception when others then
        skipped := skipped || (coalesce(c->>'name', '') || ' ' || coalesce(it->>'date', '') || ' ' || coalesce(it->>'time', '') || ': ' || sqlerrm);
      end;
    end loop;
  end loop;
  return jsonb_build_object('added', added, 'skipped', to_jsonb(skipped));
end $$;

-- app_pay { pkg, amount, method, note }: extra goes to the wallet (Wallet.gs walletPay_)
create or replace function public.api_app_pay(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); pkg uuid := app.ops_pkg(p->>'pkg'); due int; r jsonb;
begin
  if pkg is null then raise exception 'Package % not found', coalesce(p->>'pkg', ''); end if;
  select greatest(0, price_cents - paid_cents) into due from public.packages where id = pkg;
  r := public.pay_package(pkg, app.ops_num(p->'amount'), coalesce(nullif(p->>'method', ''), 'Cash'), nullif(app.ops_clean(p->>'note', 200), ''));
  r := jsonb_build_object('extra', r->'extra', 'wallet', round((r->>'wallet')::numeric, 2))
    || case when due > 0 then jsonb_build_object('paid', round((r->>'paid')::numeric, 2)) else '{}' end;
  return r;
end $$;

-- app_sell { type, cid, months, discount, price, paid, start, method, useWallet }
create or replace function public.api_app_sell(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); cl uuid := app.ops_cid(p->>'cid'); r jsonb; price numeric;
begin
  if cl is null then raise exception 'Client not found'; end if;
  price := case when p->'price' is null or jsonb_typeof(p->'price') = 'null' or p->>'price' = '' then null else app.ops_num(p->'price') end;
  r := public.sell_package(cl, p->>'type', coalesce(nullif(app.ops_num(p->'months'), 0), 1)::int, coalesce(app.ops_num(p->'discount'), 0), price,
         coalesce(app.ops_num(p->'paid'), 0), app.ops_ymd(p->>'start'), coalesce(nullif(p->>'method', ''), 'Cash'), coalesce(p->>'useWallet', '') not in ('', 'false', '0', 'null'));
  return r - 'uuids';
end $$;

-- app_lead { id, act: 'cancel' | confirm, reason, date, time }: confirm books the free trial (Code.gs w40_confirmRow)
-- A failed confirm is kept like today: the lead goes back to Pending with "AUTO FAILED: ..." and the result is { ok:false, error }.
create or replace function public.api_app_lead(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); l public.leads; h int; lbl text; old_d text; old_t text; tz text := coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut');
  st public.staff; cap int; n int; cl jsonb; ty public.package_types; pkg uuid; plid text; sid uuid; slid text; s record; free int; msg text; d date;
begin
  -- id, or row (the Supabase boot puts the lead ID in "row")
  select * into l from public.leads where legacy_id = coalesce(nullif(p->>'id', ''), p->>'row') or id = app.ops_uuid(coalesce(nullif(p->>'id', ''), p->>'row')) for update;
  if l.id is null then raise exception 'Lead moved in the sheet, refresh and try again'; end if;
  if p->>'act' = 'cancel' then
    update public.leads set status = 'Cancelled', notes = app.append_note(notes, 'Cancelled in the app ' || to_char(now() at time zone tz, 'DD/MM HH24:MI')
      || case when coalesce(p->>'reason', '') <> '' then ': ' || app.ops_clean(p->>'reason', 120) else '' end) where id = l.id;
    return '{}';
  end if;
  if coalesce(p->>'date', '') <> '' and coalesce(p->>'time', '') <> '' then
    h := app.ops_to_hour(p->>'time');
    if p->>'date' !~ '^\d{4}-\d{2}-\d{2}$' or h is null then raise exception 'Pick a valid day and time'; end if;
    lbl := app.ops_hour_label(h); old_d := coalesce(to_char(l.trial_date, 'YYYY-MM-DD'), ''); old_t := coalesce(l.trial_time, '');
    update public.leads set trial_date = (p->>'date')::date, trial_time = lbl,
      notes = case when old_d <> p->>'date' or old_t <> lbl then app.append_note(notes, 'Moved by ' || app.desk_name() || ' from ' || coalesce(nullif(old_d, ''), 'no date') || ' ' || old_t || ' to ' || (p->>'date') || ' ' || lbl) else notes end
     where id = l.id returning * into l;
  end if;
  update public.leads set status = 'Confirmed' where id = l.id returning * into l;
  if l.package_id is not null then return '{}'; end if;     -- already done, never twice
  begin
    h := app.ops_to_hour(l.trial_time); d := l.trial_date;
    if d is null or h is null then raise exception 'Fill Trial Date (yyyy-MM-dd) and Trial Time (e.g. 8:00 AM) first'; end if;
    select * into st from public.staff where id = app.setting('{trial,trainer}') #>> '{}';
    cap := coalesce(st.cap, (app.setting('{services,1:3,cap}') #>> '{}')::int);
    n := app.trainer_load(st.trainer, d, h);
    if n >= cap then raise exception '% already has % clients on % at %', st.trainer, n, d, app.ops_hour_label(h); end if;
    select x.id, x.legacy_id into s from public.sessions x where x.kind = '1:3' and x.trainer = st.trainer and x.day = d and extract(hour from x.start_time) = h
       and x.status !~* 'cancel' and (select count(*) from public.session_clients where session_id = x.id) < 3 order by x.legacy_id limit 1;
    if s.id is null and not exists (select 1 from public.sessions where kind = '1:3' and trainer = st.trainer) then
      raise exception 'No % row found in SESSIONS 1:3 to copy trainer name from', st.trainer;
    end if;
    cl := app.ops_client(btrim(coalesce(l.name, '')), btrim(coalesce(l.phone, '')), l.email);
    select * into ty from public.package_types where trial order by sort limit 1;
    plid := app.next_legacy('PKG', 'public.packages', 4);
    insert into public.packages (legacy_id, client_id, type_name, kind, passes, used, price_cents, paid_cents, discount_pct, start_date, expiry_date, effective_expiry, status, new_client, note)
    values (plid, (cl->>'uuid')::uuid, coalesce(ty.name, 'Trial Session - 1:3 (Free)'), coalesce(ty.kind, '1:3'), 1, 0, 0, 0, 0, d,
            app.ops_plus_ms_days(d, app.setting_int('{windows,trialExpiryDays}', 30)), app.ops_plus_ms_days(d, app.setting_int('{windows,trialExpiryDays}', 30)), 'Active', false, 'W40 landing page trial')
    returning id into pkg;
    if s.id is not null then
      select min(g) into free from generate_series(0, 2) g where not exists (select 1 from public.session_clients where session_id = s.id and slot = g);
      insert into public.session_clients (session_id, slot, package_id, client_id, name) values (s.id, free, pkg, (cl->>'uuid')::uuid, btrim(l.name));
      sid := s.id; slid := s.legacy_id;
    else
      slid := app.next_legacy('S13', 'public.sessions', 4);
      insert into public.sessions (legacy_id, kind, day, start_time, end_time, trainer, room, status)
      values (slid, '1:3', d, make_time(h, 0, 0), make_time(h, 0, 0) + interval '1 hour', st.trainer, coalesce(app.setting('{services,1:3,room}') #>> '{}', ''), 'Scheduled')
      returning id into sid;
      insert into public.session_clients (session_id, slot, package_id, client_id, name) values (sid, 0, pkg, (cl->>'uuid')::uuid, btrim(l.name));
    end if;
    update public.leads set client_id = (cl->>'uuid')::uuid, package_id = pkg, session_id = sid,
      notes = app.append_note(notes, 'Auto: ' || slid || ' ' || d || ' ' || app.ops_hour_label(h)) where id = l.id;
    insert into public.outbox (channel, to_staff, body) select 'whatsapp', x.id, 'W40 CONFIRMED' || E'\n' || btrim(l.name) || ' (' || (cl->>'id') || case when (cl->>'isNew')::boolean then ', new client' else '' end || ')' || E'\n'
      || plid || ' in ' || slid || E'\n' || d || ' at ' || app.ops_hour_label(h) from public.staff x where x.role = 'owner' and x.active;
    return '{}';
  exception when others then
    msg := sqlerrm;
  end;
  update public.leads set status = 'Pending', notes = app.append_note(notes, 'AUTO FAILED: ' || msg) where id = l.id;
  insert into public.outbox (channel, to_staff, body) select 'whatsapp', x.id, 'W40 CONFIRM FAILED for ' || coalesce(l.name, '') || E'\n' || msg || E'\nStatus set back to Pending.' from public.staff x where x.role = 'owner' and x.active;
  return jsonb_build_object('ok', false, 'error', msg);
end $$;

-- app_expense { d, what, cat, amt, recId }
create or replace function public.api_app_expense(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); amt numeric := app.ops_num(p->'amt'); lid text; rec uuid;
begin
  if not coalesce(amt > 0, false) or coalesce(p->>'what', '') = '' then raise exception 'What and amount needed'; end if;
  if app.ops_ymd(p->>'d') is null then raise exception 'Pick a valid day'; end if;
  lid := app.next_legacy('EXP', 'public.expenses', 6);
  select id into rec from public.recurring_expenses where legacy_id = nullif(p->>'recId', '');
  insert into public.expenses (legacy_id, day, what, category, amount_cents, by_who, recurring_id)
  values (lid, (p->>'d')::date, app.ops_clean(p->>'what', 120), app.ops_clean(p->>'cat', 40), round(amt * 100), me->>'name', rec);
  if rec is not null then update public.recurring_expenses set last_logged = (p->>'d')::date where id = rec; end if;
  return jsonb_build_object('id', lid);
end $$;

-- app_rec_add { what, cat, amt, every, start, end }
create or replace function public.api_app_rec_add(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); lid text := app.next_legacy('REC', 'public.recurring_expenses', 3);
begin
  insert into public.recurring_expenses (legacy_id, what, category, amount_cents, every, first_day, end_day, active, last_logged)
  values (lid, app.ops_clean(p->>'what', 120), app.ops_clean(p->>'cat', 40), round(coalesce(app.ops_num(p->'amt'), 0) * 100), left(coalesce(p->>'every', ''), 40),
          coalesce(app.ops_ymd(left(coalesce(p->>'start', ''), 10)), app_today()), app.ops_ymd(left(coalesce(p->>'end', ''), 10)), true, null);
  return jsonb_build_object('id', lid);
end $$;

-- app_rec_stop { id }
create or replace function public.api_app_rec_stop(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']);
begin
  update public.recurring_expenses set active = false where legacy_id = p->>'id' or id = app.ops_uuid(p->>'id');
  return '{}';
end $$;

-- app_pos { product, qty, price, to }: one sale, stock recounted (App.gs appPos_)
create or replace function public.api_app_pos(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); qty numeric := coalesce(nullif(app.ops_num(p->'qty'), 0), 1); each numeric := coalesce(app.ops_num(p->'price'), 0);
  iv public.inventory; cost numeric; lid text;
begin
  select * into iv from public.inventory where item = p->>'product' for update;
  if iv.item is null then raise exception 'Product not found'; end if;
  cost := coalesce(iv.cost_cents, 0) / 100.0;
  lid := app.next_legacy('POSS', 'public.pos_sales', 4);
  insert into public.pos_sales (legacy_id, at, item, buyer, qty, amount_cents, cost_cents, profit_cents, status, note, by_who)
  values (lid, now(), iv.item, app.ops_clean(p->>'to', 80), qty, round(each * qty * 100), round(cost * 100), round((each * qty - cost * qty) * 100), 'Paid', 'via app (' || (me->>'name') || ')', me->>'name');
  update public.inventory set sold = (select coalesce(sum(x.qty), 0) from public.pos_sales x where x.item = iv.item), stock = stock - qty::int where item = iv.item;
  return jsonb_build_object('id', lid);
end $$;

-- app_client { name, phone, email, mel }
create or replace function public.api_app_client(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); nm text := app.ops_clean(p->>'name', 80); ph text := app.ops_clean(p->>'phone', 30); c jsonb;
begin
  if nm = '' or ph = '' then raise exception 'Name and phone needed'; end if;
  c := app.ops_client(nm, ph, app.ops_clean(p->>'email', 120));
  if coalesce((p->>'mel')::boolean, false) then
    update public.clients set is_mel = true where id = (c->>'uuid')::uuid;
    perform app.ops_note_row((c->>'uuid')::uuid);
  end if;
  return jsonb_build_object('id', c->>'id', 'isNew', (c->>'isNew')::boolean);
end $$;

-- app_flag { cid, name, mel }: Melanie's own client or not
create or replace function public.api_app_flag(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); cl uuid := app.ops_cid(p->>'cid');
begin
  if cl is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  update public.clients set is_mel = coalesce(p->>'mel', '') not in ('', 'false', '0', 'null') where id = cl;
  perform app.ops_note_row(cl);
  return '{}';
end $$;

-- app_disc { cid, name, disc }: standing discount %, pre filled when selling
create or replace function public.api_app_disc(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); cl uuid := app.ops_cid(p->>'cid'); d numeric := greatest(0, least(100, coalesce(app.ops_num(p->'disc'), 0)));
begin
  if cl is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  update public.clients set discount_pct = d where id = cl;
  perform app.ops_note_row(cl);
  return jsonb_build_object('disc', d);
end $$;

-- app_cedit { cid, name, phone, email }
create or replace function public.api_app_cedit(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); c public.clients; nm text := app.ops_clean(p->>'name', 80); ph text := app.ops_clean(p->>'phone', 30);
  em text := lower(app.ops_clean(p->>'email', 120));
begin
  if nm = '' then raise exception 'Name needed'; end if;
  if em <> '' and not app.ops_email_ok(em) then raise exception 'This email does not look right'; end if;
  select * into c from public.clients where id = app.ops_cid(p->>'cid') and kind = 'client';
  if c.id is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  update public.clients set name = nm, email = nullif(em, ''), phone = app.ops_phone(ph) where id = c.id;
  return jsonb_build_object('id', c.legacy_id);
end $$;

-- app_freeze { pkg, from, note }: 1 week, once per package
create or replace function public.api_app_freeze(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); pkg uuid := app.ops_pkg(p->>'pkg'); frm text; e date; r uuid; cl public.clients; n int := app.setting_int('{windows,freezeDays}', 7);
begin
  if exists (select 1 from public.client_requests where type = 'Freeze' and status <> 'Declined' and package_id = pkg and pkg is not null) then
    raise exception 'This package already had its freeze';
  end if;
  if pkg is null then raise exception 'Package % not found', coalesce(p->>'pkg', ''); end if;
  frm := coalesce(app.ops_ymd(p->>'from')::text, app_today()::text);
  e := app.ops_freeze(pkg, frm, me->>'name');
  select c.* into cl from public.clients c join public.packages k on k.client_id = c.id where k.id = pkg;
  r := app.client_log(cl.id, cl.name, 'Freeze', n || ' days from ' || frm || ', new end ' || e
         || case when coalesce(p->>'note', '') <> '' then ' · ' || app.ops_clean(p->>'note', 200) else '' end || ' (by ' || (me->>'name') || ')', frm, pkg, 'Done', jsonb_build_object('from', frm));
  update public.client_requests set handled_by = me->>'name', handled_at = now() where id = r;
  return jsonb_build_object('end', e, 'req', (select legacy_id from public.client_requests where id = r));
end $$;

-- app_req_done { id, act: done|decline|accept, d, t }: every request type of the To do (Client.gs appReqDone_)
create or replace function public.api_app_req_done(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); q public.client_requests; np public.nutrition_plans; out jsonb := '{}'; r jsonb;
begin
  select * into q from public.client_requests where id = app.ops_req(p->>'id');
  if q.id is null then raise exception 'Request not found, refresh'; end if;
  if q.status <> 'New' then raise exception 'Already handled by %', coalesce(nullif(q.handled_by, ''), 'someone'); end if;
  if q.type = 'Nutrition plan' then        -- Nutrition.gs nutFromReq_: approve (accept/done) or decline the plan with it
    select * into np from public.nutrition_plans where legacy_id = q.data->>'plan' or id = app.ops_uuid(q.data->>'plan') for update;
    if np.id is not null then
      if p->>'act' = 'decline' then update public.nutrition_plans set status = 'Declined', by_who = me->>'name', decided_at = now() where id = np.id;
      elsif np.plan is not null and np.status = 'Pending' then update public.nutrition_plans set status = 'Approved', by_who = me->>'name', decided_at = now() where id = np.id;
      end if;
      out := jsonb_build_object('plan', coalesce(np.legacy_id, np.id::text), 'status', np.status);
    end if;
  end if;
  r := public.handle_request(q.id, coalesce(p->>'act', ''), app.ops_ymd(p->>'d'), case when coalesce(p->>'t', '') ~ '^\d{2}:\d{2}$' then (p->>'t')::time end);
  return case when r = '{}'::jsonb then out else r end;
end $$;

-- app_ins_set { cid, name, insurer ('' = no longer insured), member, notes, rate }
create or replace function public.api_app_ins_set(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); cl uuid := app.ops_cid(p->>'cid'); ins text := app.ops_clean(p->>'insurer', 60);
  rate numeric := coalesce(nullif(app.ops_num(p->'rate'), 0), (app.setting('{insurance,rate}') #>> '{}')::numeric);
begin
  if cl is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  if ins = '' then delete from public.insurance_clients where client_id = cl; return '{}'; end if;
  insert into public.insurance_clients (client_id, insurer, member_number, notes, rate_cents, updated_at, by_who)
  values (cl, ins, app.ops_clean(p->>'member', 60), app.ops_clean(p->>'notes', 300), round(rate * 100), now(), me->>'name')
  on conflict (client_id) do update set insurer = excluded.insurer, member_number = excluded.member_number, notes = excluded.notes,
    rate_cents = excluded.rate_cents, updated_at = now(), by_who = excluded.by_who;
  return '{}';
end $$;

-- app_ins_submit { cid, name, insurer, month 'yyyy-MM', sessions, amount, submitted, ref, pkgs }
create or replace function public.api_app_ins_submit(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); cl uuid := app.ops_cid(p->>'cid'); mon text := left(coalesce(p->>'month', ''), 7); amt numeric := app.ops_num(p->'amount');
  sent date; lid text; ids uuid[];
begin
  if mon !~ '^\d{4}-\d{2}$' then raise exception 'Month missing'; end if;
  if cl is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  if exists (select 1 from public.insurance_claims where client_id = cl and to_char(month, 'YYYY-MM') = mon) then raise exception 'This month is already submitted'; end if;
  if not coalesce(amt > 0, false) then raise exception 'Amount missing'; end if;
  sent := coalesce(app.ops_ymd(p->>'submitted'), app_today());
  lid := app.next_legacy('CLM', 'public.insurance_claims', 4);
  select coalesce(array_agg(k.id order by x.n), '{}') into ids from regexp_split_to_table(app.ops_clean(p->>'pkgs', 200), '[,\s]+') with ordinality x(v, n)
    join public.packages k on k.legacy_id = x.v;
  insert into public.insurance_claims (legacy_id, client_id, insurer, month, sessions, amount_cents, package_ids, submitted, expected, reference, status, by_who)
  values (lid, cl, app.ops_clean(p->>'insurer', 60), (mon || '-01')::date, coalesce(app.ops_num(p->'sessions'), 0)::int, round(amt * 100), ids, sent, sent + 90,
          app.ops_clean(p->>'ref', 80), 'Submitted', me->>'name');
  return jsonb_build_object('id', lid, 'expected', sent + 90);
end $$;

-- app_ins_paid { id, amount, date }: the money goes on the client's packages, the claim's packages first, then oldest first
create or replace function public.api_app_ins_paid(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); c public.insurance_claims; amt numeric := app.ops_num(p->'amount'); day date; lft numeric; k record; take numeric;
begin
  select * into c from public.insurance_claims where legacy_id = p->>'id' or id = app.ops_uuid(p->>'id') for update;
  if c.id is null then raise exception 'Claim not found, refresh'; end if;
  if c.status = 'Paid' then raise exception 'Already marked paid'; end if;
  if not coalesce(amt > 0, false) then raise exception 'Amount missing'; end if;
  day := coalesce(app.ops_ymd(p->>'date'), app_today());
  update public.insurance_claims set status = 'Paid', paid_on = day, paid_cents = round(amt * 100) where id = c.id;
  lft := amt;
  for k in select id, (price_cents - paid_cents) / 100.0 as due from public.packages
            where client_id = c.client_id and status !~* 'cancel' and price_cents - paid_cents > 0
            order by case when id = any(c.package_ids) then 0 else 1 end, start_date nulls first, legacy_id loop
    exit when lft <= 0;
    take := least(lft, k.due);
    perform public.pay_package(k.id, take, c.insurer, 'claim ' || coalesce(c.legacy_id, '') || ' (' || to_char(c.month, 'YYYY-MM') || ')');
    lft := app.jsround((lft - take) * 100) / 100;
  end loop;
  if lft > 0 then
    insert into public.wallet_ledger (day, client_id, amount_cents, reason, package_id, by_who)
    values (app_today(), c.client_id, round(lft * 100), c.insurer || ' paid $' || app.jsnum(amt) || ' for claim ' || coalesce(c.legacy_id, '') || ', more than the packages needed.', null, me->>'name');
  end if;
  return jsonb_build_object('left', lft);
end $$;

-- app_pkg_price { pkg, price }
create or replace function public.api_app_pkg_price(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); k public.packages; price numeric := round(app.ops_num(p->'price') * 100) / 100;
begin
  select * into k from public.packages where id = app.ops_pkg(p->>'pkg') for update;
  if k.id is null then raise exception 'Package % not found', coalesce(p->>'pkg', ''); end if;
  if not coalesce(price >= 0, false) then raise exception 'Price missing'; end if;
  update public.packages set price_cents = round(price * 100),
    note = app.append_note(note, 'Price $' || app.jsnum(k.price_cents / 100.0) || ' -> $' || app.jsnum(price) || ' ' || app.ddmm() || ' (' || (me->>'name') || ')') where id = k.id;
  return jsonb_build_object('price', price);
end $$;

-- app_notes { cid, name, always, program, note, date, sid }: trainers only for their own clients
create or replace function public.api_app_notes(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cl uuid := app.ops_cid(p->>'cid'); tr_ok boolean;
begin
  if me->>'role' = 'trainer' then
    select exists (select 1 from public.sessions s join public.session_clients sc on sc.session_id = s.id
                    where sc.client_id = cl and s.trainer = me->>'trainer' and s.status <> 'Cancelled'
                      and s.day between app_today() - app.setting_int('{windows,trainerSee}', 60) and app_today() + app.setting_int('{windows,ahead}', 35)) into tr_ok;
    if not tr_ok then raise exception 'This client is not one of yours'; end if;
  end if;
  if cl is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  insert into public.client_notes (client_id, always_show, program, updated_by, updated_at)
  values (cl, left(coalesce(p->>'always', ''), 500), left(coalesce(p->>'program', ''), 2000), me->>'name', now())
  on conflict (client_id) do update set always_show = excluded.always_show, program = excluded.program, updated_by = excluded.updated_by, updated_at = now();
  if coalesce(p->>'note', '') <> '' then
    insert into public.session_notes (day, session_id, client_id, by_staff, note)
    values (coalesce(app.ops_ymd(left(coalesce(p->>'date', ''), 10)), app_today()), app.ops_sess(p->>'sid'), cl, coalesce(nullif(me->>'trainer', ''), me->>'name'), left(p->>'note', 1000));
  end if;
  return '{}';
end $$;

-- app_intake { cid, name, data: { name, phone, email, area, complaint, painNow, flags, dx, plan, ... }, alert }: owner only
create or replace function public.api_app_intake(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner']); d jsonb := coalesce(p->'data', '{}'); lid text := upper(coalesce(p->>'cid', '')); cl uuid; nm text; c jsonb; cur text; al text;
begin
  nm := app.ops_clean(coalesce(nullif(p->>'name', ''), d->>'name'), 80);
  if lid = '' then
    if nm = '' or coalesce(d->>'phone', '') = '' then raise exception 'Name and phone needed for a new client'; end if;
    c := app.ops_client(nm, app.ops_clean(d->>'phone', 30), app.ops_clean(d->>'email', 120));
    lid := c->>'id'; cl := (c->>'uuid')::uuid;
  else
    cl := app.ops_cid(lid);
    if cl is null then raise exception 'Client % not found', lid; end if;
    lid := (select legacy_id from public.clients where id = cl);
  end if;
  insert into public.physio_intake (day, client_id, by_staff, body_area, complaint, pain_now, red_flags, impression, plan, form)
  values (app_today(), cl, me->>'name', app.ops_clean(d->>'area', 60), left(coalesce(d->>'complaint', ''), 500),
          case when coalesce(d->>'painNow', '') = '' then null else app.ops_num(d->'painNow')::int end,
          coalesce((select string_agg(x, ', ' order by n) from jsonb_array_elements_text(case when jsonb_typeof(d->'flags') = 'array' then d->'flags' else '[]' end) with ordinality t(x, n)), ''),
          left(coalesce(d->>'dx', ''), 500), left(coalesce(d->>'plan', ''), 500), d);
  al := p->>'alert';
  if coalesce(al, '') <> '' then        -- short warning shown to trainers on every booking
    select always_show into cur from public.client_notes where client_id = cl;
    if not found then
      insert into public.client_notes (client_id, always_show, program, updated_by) values (cl, left(al, 300), '', me->>'name');
    else
      update public.client_notes set always_show = case when coalesce(cur, '') <> '' and position(al in cur) = 0 then cur || ' | ' || al else coalesce(nullif(cur, ''), al) end,
        updated_by = me->>'name', updated_at = now() where client_id = cl;
    end if;
  end if;
  return jsonb_build_object('cid', lid);
end $$;

-- app_upload { cid, name, mime }: owner only. Placeholder: returns where to put the file in Storage
-- (the upload edge function sends the bytes and adds the client_files row).
create or replace function public.api_app_upload(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner']); cl uuid := app.ops_cid(p->>'cid'); nm text := coalesce(nullif(app.ops_clean(p->>'name', 120), ''), 'file');
begin
  if coalesce(p->>'cid', '') = '' then raise exception 'Nothing to upload'; end if;
  if cl is null then raise exception 'Client not found'; end if;
  return jsonb_build_object('bucket', 'client-files', 'path', cl || '/' || (extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || regexp_replace(nm, '[^\w.\-]', '_', 'g'), 'name', nm);
end $$;

-- app_notice_read { ids }: staff marks their own notices read
create or replace function public.api_app_notice_read(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); n int;
begin
  update public.notices set read_at = now()
   where read_at is null and for_staff = me->>'staff'
     and (legacy_id in (select jsonb_array_elements_text(coalesce(p->'ids', '[]'))) or id in (select app.ops_uuid(x) from jsonb_array_elements_text(coalesce(p->'ids', '[]')) x));
  get diagnostics n = row_count;
  return jsonb_build_object('read', n);
end $$;

-- =====================================================================
-- CLIENT ACTIONS (client app). Guests may only delete their account and read notices.
-- =====================================================================
create or replace function app.ops_client_only(cid uuid) returns jsonb language plpgsql stable as $$
declare c jsonb := app.need_client(cid);
begin
  if c->>'role' = 'guest' or (select kind from public.clients where id = cid) = 'guest' then raise exception 'unknown action'; end if;
  return c;
end $$;

-- app_cl_cancel { cid, id }
create or replace function public.api_app_cl_cancel(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cl uuid := app.ops_cid(p->>'cid'); me jsonb := app.ops_client_only(cl); s public.sessions := app.ops_session_ref(p);
begin
  return public.cancel_session(s.id, cl);
end $$;

-- app_cl_join { cid, date, time, trainer }
create or replace function public.api_app_cl_join(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cl uuid := app.ops_cid(p->>'cid'); me jsonb := app.ops_client_only(cl); r jsonb;
begin
  r := public.client_join(cl, (p->>'date')::date, (p->>'time')::time, coalesce(p->>'trainer', ''));
  return jsonb_build_object('id', r->>'id');
end $$;

-- app_cl_upgrade6 { cid }
create or replace function public.api_app_cl_upgrade6(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cl uuid := app.ops_cid(p->>'cid'); me jsonb := app.ops_client_only(cl);
begin
  return public.request_upgrade6(cl);
end $$;

-- app_cl_request { cid, kind: physio|reschedule|freeze|offer3|order|late|supp|session|invite, ... } (Client.gs clRequest_)
create or replace function public.api_app_cl_request(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cl uuid := app.ops_cid(p->>'cid'); me jsonb := app.ops_client_only(cl); nm text; k text := coalesce(p->>'kind', ''); note text := app.ops_clean(p->>'note', 400);
  nt text; pkg uuid; o jsonb; frm text; today date := app_today(); it jsonb; inv record; q numeric; lines text[] := '{}'; total numeric := 0; mins numeric; fn text; ph text;
  n int := app.setting_int('{windows,freezeDays}', 7); m3 numeric := (app.setting('{offers,m3Pct}') #>> '{}')::numeric;
begin
  select name into nm from public.clients where id = cl;
  nt := case when note <> '' then ' · ' || note else '' end;
  if k = 'physio' then
    if exists (select 1 from public.client_requests where client_id = cl and type = 'Physio visit' and status = 'New') then
      raise exception 'You already have a physio request waiting. % will confirm it soon.', app.desk_name();
    end if;
    if not app.ops_physio_free(app.ops_ymd(p->>'d'), coalesce(p->>'t', '')) then raise exception 'This time was just taken. Pick another one.'; end if;
    perform app.client_log(cl, nm, 'Physio visit', 'Physio visit with ' || app.fixed_trainer('Physio') || ', $' || app.jsnum((app.setting('{offers,physioPrice}') #>> '{}')::numeric)
      || ' (was $' || app.jsnum((app.setting('{offers,physioWas}') #>> '{}')::numeric) || ')' || nt, (p->>'d') || ' ' || (p->>'t'), null, 'New', jsonb_build_object('d', p->>'d', 't', p->>'t'));
    return '{}';
  end if;
  if k = 'reschedule' then
    if coalesce(p->>'when', '') = '' then raise exception 'Tell us what time suits you.'; end if;
    perform app.client_log(cl, nm, 'Reschedule', 'Wants: ' || app.ops_clean(p->>'when', 200) || nt, btrim(app.ops_clean(p->>'slabel', 80) || ' · ' || app.ops_clean(p->>'sid', 20)),
      app.ops_pkg(app.ops_clean(p->>'pkg', 20)), 'New', jsonb_build_object('sid', p->'sid', 'ref', p->'ref'));
    return '{}';
  end if;
  if k = 'freeze' then
    pkg := (select id from public.packages where id = app.ops_pkg(p->>'pkg') and client_id = cl);
    if pkg is null then raise exception 'Package not found.'; end if;
    if exists (select 1 from public.client_requests where type = 'Freeze' and package_id = pkg and status <> 'Declined') then raise exception 'This package already had its freeze.'; end if;
    frm := coalesce(p->>'from', '');
    if frm !~ '^\d{4}-\d{2}-\d{2}$' or frm < today::text then raise exception 'Pick a start date from today.'; end if;
    perform app.client_log(cl, nm, 'Freeze', n || ' days from ' || frm || ' to ' || (frm::date + n - 1) || nt, frm, pkg, 'New', jsonb_build_object('from', frm));
    return '{}';
  end if;
  if k = 'offer3' then
    o := app.offers(cl)->'m3';
    if o is null then raise exception 'This offer is not open on your package.'; end if;
    perform app.client_log(cl, nm, '3 month offer', '3 months of ' || (o->>'type') || ': $' || app.jsnum((o->>'p3')::numeric) || ' instead of $' || app.jsnum((o->>'t3')::numeric)
      || ' (' || app.jsnum(m3) || '% off, one payment), starts ' || (o->>'starts'), '', (o->>'pkgId')::uuid, 'New', o - 'pkgId');
    return '{}';
  end if;
  if k = 'order' then
    for it in select * from jsonb_array_elements(case when jsonb_typeof(p->'items') = 'array' then p->'items' else '[]' end) loop
      select i.item, i.price_cents / 100.0 as price, (select sum(greatest(0, stock)) from public.inventory x where x.item = i.item) as lft into inv
        from public.inventory i where i.item = it->>'n' and i.price_cents > 0;
      q := greatest(1, least(10, coalesce(nullif(app.ops_num(it->'q'), 0), 1)));
      continue when inv.item is null;
      lines := lines || (app.jsnum(q) || ' x ' || inv.item || ' ($' || app.jsnum(inv.price * q) || ')' || case when inv.lft < q then ' [to order in]' else '' end);
      total := total + inv.price * q;
    end loop;
    if cardinality(lines) = 0 then raise exception 'Your cart is empty.'; end if;
    perform app.client_log(cl, nm, 'Supplement order', array_to_string(lines, ', ') || ' · TOTAL $' || app.jsnum(total) || ' · pay and pick up at next session', '', null, 'New',
      jsonb_build_object('items', p->'items', 'total', total));
    return jsonb_build_object('total', total);
  end if;
  if k = 'late' then
    mins := greatest(5, least(60, coalesce(nullif(app.ops_num(p->'minutes'), 0), 10)));
    perform app.client_log(cl, nm, 'Running late', 'About ' || app.jsnum(mins) || ' min late' || nt, btrim(app.ops_clean(p->>'slabel', 80) || ' · ' || app.ops_clean(p->>'sid', 20)),
      app.ops_pkg(app.ops_clean(p->>'pkg', 20)), 'New', jsonb_build_object('sid', p->'sid', 'minutes', mins));
    return '{}';
  end if;
  if k = 'supp' then
    if note = '' then raise exception 'Tell us which supplement.'; end if;
    perform app.client_log(cl, nm, 'Supplement request', note, '', null, 'New', '{}');
    return '{}';
  end if;
  if k = 'session' then
    perform app.client_log(cl, nm, 'Session request', app.ops_clean(p->>'what', 60) || ' · ' || app.ops_clean(p->>'when', 200) || nt, '', app.ops_pkg(app.ops_clean(p->>'pkg', 20)), 'New', '{}');
    return '{}';
  end if;
  if k = 'invite' then
    fn := app.ops_clean(p->>'fname', 60); ph := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
    if fn = '' or length(ph) < 10 then raise exception 'Check the name and phone number.'; end if;
    perform app.client_log(cl, nm, 'Friend invite', nm || ' would like to invite ' || fn || ' (+' || ph || ') to Wellbe. Tap to send them the invite: '
      || 'https://wa.me/' || ph || '?text=' || app.ops_uri(left(coalesce(p->>'msg', ''), 300)), '', null, 'New', jsonb_build_object('fname', fn, 'phone', ph));
    return '{}';
  end if;
  raise exception 'Unknown request';
end $$;

-- app_cl_delete { cid }: deletion request for every account of this email, every older sign in stops working
create or replace function public.api_app_cl_delete(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cl uuid := app.ops_cid(p->>'cid'); me jsonb := app.need_client(cl); em text; ids text[]; uids uuid[]; names text; lid text; first_name text;
begin
  em := lower(coalesce(me->>'email', (select email from public.profiles where user_id = auth.uid()), (select email from public.clients where id = cl)));
  -- clients first; an email with no client row is a guest account (Client.gs clWho_)
  select array_agg(legacy_id order by legacy_id), array_agg(id order by legacy_id), string_agg(name, ', ' order by legacy_id) into ids, uids, names
    from public.clients where id in (select app.my_clients()) and kind = 'client';
  if ids is null then
    select array_agg(legacy_id order by legacy_id), array_agg(id order by legacy_id), string_agg(name, ', ' order by legacy_id) into ids, uids, names
      from public.clients where (id in (select app.my_clients()) or (me->>'role' = 'system' and id = cl));
  end if;
  first_name := split_part(coalesce(names, ''), ', ', 1);
  lid := app.next_legacy('DEL', 'public.deletion_requests', 4);
  insert into public.deletion_requests (legacy_id, email, client_ids, names, status) values (lid, coalesce(em, ''), coalesce(uids, '{}'), coalesce(names, ''), 'New');
  perform app.client_log(cl, coalesce(nullif(first_name, ''), upper(p->>'cid')), 'Delete account', 'Asked to delete their Wellbe app account and data (' || coalesce(em, '') || ' · '
    || array_to_string(coalesce(ids, '{}'), ', ') || '). Do it within 7 days and tick ' || lid || ' in DELETION REQUESTS. They are signed out of the app.', '', null, 'New',
    jsonb_build_object('email', em, 'ids', to_jsonb(coalesce(ids, '{}')), 'del', lid));
  -- every sign in of this email made before now stops working (Client.gs clDeny_): the API door's list (0008) when present,
  -- and the Supabase Auth refresh tokens
  if to_regprocedure('app.revoke_email(text)') is not null then execute 'select app.revoke_email($1)' using em; end if;
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id in (select id from auth.users where lower(email) = $1)' using em;
  end if;
  return jsonb_build_object('msg', 'We will delete your account and data within 7 days.');
end $$;

-- app_cl_notice_read { cid, ids }
create or replace function public.api_app_cl_notice_read(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cl uuid := app.ops_cid(p->>'cid'); me jsonb := app.need_client(cl); n int;
begin
  update public.notices set read_at = now()
   where read_at is null and for_client is not null and (for_client in (select app.my_clients()) or (me->>'role' = 'system' and for_client = cl))
     and (legacy_id in (select jsonb_array_elements_text(coalesce(p->'ids', '[]'))) or id in (select app.ops_uuid(x) from jsonb_array_elements_text(coalesce(p->'ids', '[]')) x));
  get diagnostics n = row_count;
  return jsonb_build_object('read', n);
end $$;

-- ---------------------------------------------------------------------
-- who may call what: the new internal helpers are closed, the api_ functions open to signed in users
-- (each checks the role itself). Only this file's own functions are touched.
-- ---------------------------------------------------------------------
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname like 'ops\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('api_app_att', 'api_app_change', 'api_app_book', 'api_app_week', 'api_app_pay', 'api_app_sell', 'api_app_lead',
              'api_app_expense', 'api_app_rec_add', 'api_app_rec_stop', 'api_app_pos', 'api_app_client', 'api_app_flag', 'api_app_disc', 'api_app_cedit', 'api_app_freeze',
              'api_app_req_done', 'api_app_ins_set', 'api_app_ins_submit', 'api_app_ins_paid', 'api_app_pkg_price', 'api_app_notes', 'api_app_intake', 'api_app_upload',
              'api_app_notice_read', 'api_app_cl_cancel', 'api_app_cl_join', 'api_app_cl_upgrade6', 'api_app_cl_request', 'api_app_cl_delete', 'api_app_cl_notice_read') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
