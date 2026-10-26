-- =====================================================================
-- WELLBE on Supabase: 0003 money and booking rules
-- Ported 1:1 from the Apps Script (App.gs, Client.gs, Wallet.gs, RunGame.gs, Levels.gs, Streak.gs).
-- Every value comes from the settings tables (staff, package_types, settings), never from constants here.
-- All functions are security definer and check who is calling first.
-- Messages to people (WhatsApp, email) are written to public.outbox and sent by a worker after commit.
-- =====================================================================

-- ---------------------------------------------------------------------
-- small helpers
-- ---------------------------------------------------------------------
-- a number the way JavaScript prints it: 7, 6.67, 130.2
create or replace function app.jsnum(x numeric) returns text language sql immutable as $$
  select case when x = trunc(x) then trunc(x)::text else rtrim(rtrim(round(x, 6)::text, '0'), '.') end
$$;
-- JavaScript Math.round (halves go up, also for negatives)
create or replace function app.jsround(x numeric) returns numeric language sql immutable as $$ select floor(x + 0.5) $$;
-- JavaScript Date.setMonth(+n): 31 Jan + 1 month = 3 Mar (the extra days roll over), same as today's expiry dates
create or replace function app.add_months_js(d date, n int) returns date language sql immutable as $$
  select ((date_trunc('month', d) + make_interval(months => n))::date + (extract(day from d)::int - 1))
$$;
create or replace function app.now_hm() returns text language sql stable as $$
  select to_char(now() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'), 'HH24:MI')
$$;
create or replace function app.ddmm() returns text language sql stable as $$
  select to_char(now() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'), 'DD/MM')
$$;
-- moment a session starts (Beirut wall clock -> timestamptz)
create or replace function app.at(d date, t time) returns timestamptz language sql stable as $$
  select (d + t) at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut')
$$;
create or replace function app.append_note(old text, add text) returns text language sql immutable as $$
  select case when coalesce(old, '') = '' then add else old || ' | ' || add end
$$;
-- next legacy ID like PKG-0174 (highest + 1, never reused). Callers hold the advisory lock for the prefix.
create or replace function app.next_legacy(prefix text, tbl regclass, pad int) returns text language plpgsql as $$
declare n bigint;
begin
  perform pg_advisory_xact_lock(hashtext('legacy:' || prefix));
  execute format('select coalesce(max(substring(legacy_id from %L)::bigint), 0) from %s where legacy_id ~ %L',
                 '^' || prefix || '-(\d+)$', tbl, '^' || prefix || '-\d+$') into n;
  return prefix || '-' || lpad((n + 1)::text, pad, '0');
end $$;

-- who is calling: role + staff id + the name written in notes ("Romy", "client app")
-- The database owner / service role without a login (workers, tests) counts as 'system'.
create or replace function app.caller() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; s public.staff;
begin
  select * into p from public.profiles where user_id = auth.uid();
  if p.user_id is null then
    if current_user in ('postgres', 'service_role', 'supabase_admin') then return jsonb_build_object('role', 'system', 'name', 'system'); end if;
    return jsonb_build_object('role', 'anon');
  end if;
  if p.staff_id is not null then
    select * into s from public.staff where id = p.staff_id and active;
    if s.id is null then return jsonb_build_object('role', 'anon'); end if;
    return jsonb_build_object('role', p.role, 'staff', s.id, 'trainer', s.trainer, 'name', s.name);
  end if;
  return jsonb_build_object('role', p.role, 'name', 'client app');
end $$;
create or replace function app.need(roles text[]) returns jsonb language plpgsql stable as $$
declare c jsonb := app.caller();
begin
  if c->>'role' = 'system' or c->>'role' = any(roles) then return c; end if;
  raise exception 'not allowed';
end $$;
create or replace function app.need_client(cid uuid) returns jsonb language plpgsql stable as $$
declare c jsonb := app.caller();
begin
  if c->>'role' = 'system' then return c; end if;
  if c->>'role' in ('client', 'guest') and app.is_mine(cid) then return c; end if;
  raise exception 'Not your account';
end $$;

-- settings shortcuts
create or replace function app.desk_name() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select split_part(name, ' ', 1) from public.staff where id = app.setting('{center,desk}') #>> '{}' and active),
                  (select split_part(name, ' ', 1) from public.staff where role = 'assistant' and active order by id limit 1), 'the front desk')
$$;
create or replace function app.desk_id() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select id from public.staff where id = app.setting('{center,desk}') #>> '{}' and active),
                  (select id from public.staff where role = 'assistant' and active order by id limit 1), '')
$$;
-- raw trainer text ('Joe Al Hosny', 'mel') -> trainer name ('Joe'): trainers first, then the others (Config.gs cfgTrainerName_)
create or replace function app.trainer_name(raw text) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select s.trainer from public.staff s
                    where s.trainer <> '' and s.match <> '' and position(s.match in lower(coalesce(raw, ''))) > 0
                    order by (s.role <> 'trainer'), s.sort, s.id limit 1), btrim(coalesce(raw, '')))
$$;
create or replace function app.fixed_trainer(kind text) returns text language sql stable security definer set search_path = public as $$
  select s.trainer from public.staff s where s.id = app.setting(array['services', kind, 'fixed']) #>> '{}'
$$;
create or replace function app.trainer_cap(trainer text) returns int language sql stable security definer set search_path = public as $$
  select coalesce((select cap from public.staff where trainer = $1 and trainer <> '' limit 1), 0)
$$;
-- kind of a package label: the types list first, the old name rules for old labels (App.gs appKind_)
create or replace function app.kind_of(label text) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select kind from public.package_types where name = label),
    case when label ~* '^1:3|trial|- 1:3 \(free\)' then '1:3'
         when label ~ '^1:2' then '1:2'
         when label ~* '^1:1|with mel|stretching' then '1:1'
         when label ~* 'prehab' then 'Prehab'
         when label ~* 'physio|assessment' then 'Physio'
         when label ~* 'osteo' then 'Osteo'
         when label ~* 'madero' then 'Madero'
         else '1:1' end)
$$;
-- staff to tell about a session: the trainer, the desk, the owners (App.gs appStaffFor_)
create or replace function app.staff_for(trainer text) returns setof text language sql stable security definer set search_path = public as $$
  select id from (
    select id, 1 as o from public.staff where active and trainer <> '' and trainer = $1
    union select app.desk_id(), 2 where app.desk_id() <> ''
    union select id, 3 from public.staff where active and role = 'owner') x
  group by id order by min(o), id
$$;
create or replace function app.notice(p_client uuid, p_staff text, p_type text, p_text text) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notices (legacy_id, for_client, for_staff, type, text)
  values (app.next_legacy('NT', 'public.notices', 5), p_client, p_staff, left(p_type, 60), left(p_text, 600));
end $$;
create or replace function app.ping_desk(msg text) returns void language sql security definer set search_path = public as $$
  insert into public.outbox (channel, to_staff, body) values ('whatsapp', app.desk_id(), msg)
$$;
-- CLIENT REQUESTS row (Client.gs clLog_); status New also pings the desk
create or replace function app.client_log(p_client uuid, p_name text, p_type text, p_details text, p_slot text, p_pkg uuid, p_status text, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  insert into public.client_requests (legacy_id, client_id, type, details, slot, package_id, status, data)
  values (app.next_legacy('REQ', 'public.client_requests', 4), p_client, p_type, left(coalesce(p_details, ''), 900), coalesce(p_slot, ''), p_pkg, p_status, coalesce(p_data, '{}'))
  returning id into rid;
  if p_status = 'New' then
    perform app.ping_desk('Wellbe app: ' || p_name || ' · ' || p_type || case when coalesce(p_slot, '') <> '' then ' · ' || p_slot else '' end
                          || E'\n' || left(coalesce(p_details, ''), 300) || E'\nOpen your To do in the staff app.');
  end if;
  return rid;
end $$;

-- ---------------------------------------------------------------------
-- PACKAGES: recount, sell (with wallet), pay
-- ---------------------------------------------------------------------
-- Used = number of Y pass flags (App.gs appRecount_)
create or replace function app.recount(p_pkg uuid) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from public.session_clients where package_id = p_pkg and pass = 'Y';
  update public.packages set used = n where id = p_pkg;
  return n;
end $$;

create or replace function app.wallet_balance(p_client uuid) returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_cents), 0)::int from public.wallet_ledger where client_id = p_client
$$;

-- App.gs appSell_ + Wallet.gs walletSell_. Amounts in dollars like the app sends them (price, paid), stored in cents.
-- months 1 | 3 | 6 (monthly types only), discount % on the whole bundle, price = typed final price (wins over discount)
create or replace function public.sell_package(p_client uuid, p_type text, p_months int default 1, p_discount numeric default 0,
  p_price numeric default null, p_paid numeric default 0, p_start date default null, p_method text default 'Cash', p_use_wallet boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']);
  ty public.package_types; cl public.clients; months int := greatest(1, coalesce(p_months, 1));
  disc numeric := greatest(0, least(100, coalesce(p_discount, 0))); total numeric; each numeric; lft numeric; start_d date := coalesce(p_start, app_today());
  had_paid boolean; madero boolean; mine boolean; mel boolean; mel_s public.staff; mel_n text; mel_cut text;
  k int; price numeric; paid numeric; s_d date; exp date; nc boolean; lid text; note text; pid uuid; ids text[] := '{}'; uids uuid[] := '{}';
  over numeric; bal numeric; take numeric; used_w numeric := 0; due numeric;
begin
  select * into ty from public.package_types where name = p_type and active;
  if ty.id is null then raise exception 'Unknown package type'; end if;
  select * into cl from public.clients where id = p_client and deleted_at is null;
  if cl.id is null then raise exception 'Client not found'; end if;
  if months > 1 and not ty.monthly then raise exception '3 and 6 months only work with monthly packages'; end if;
  madero := ty.kind = 'Madero';
  if ty.mel and not cl.is_mel then update public.clients set is_mel = true where id = cl.id; cl.is_mel := true; end if;
  mine := not madero and cl.is_mel;
  total := app.jsround(ty.price_cents / 100.0 * months * (1 - disc / 100));
  if p_price is not null and p_price >= 0 then
    total := round(p_price * 100) / 100;
    disc := case when ty.price_cents * months > 0 then greatest(0, app.jsround((1 - total / (ty.price_cents / 100.0 * months)) * 10000) / 100) else 0 end;
  end if;
  each := app.jsround(total / months * 100) / 100;
  lft := least(total, coalesce(p_paid, 0));
  select exists (select 1 from public.packages where client_id = cl.id and price_cents > 0 and passes > 1) into had_paid;
  mel := madero or ty.mel;
  select * into mel_s from public.staff where trainer = app.fixed_trainer('Madero');
  mel_n := coalesce(mel_s.trainer, 'Melanie'); mel_cut := coalesce(mel_s.pay->>'cut', 'undefined');
  for k in 0 .. months - 1 loop
    price := case when k < months - 1 then each else app.jsround((total - each * (months - 1)) * 100) / 100 end;
    paid := least(price, lft); lft := app.jsround((lft - paid) * 100) / 100;
    s_d := start_d + 30 * k;
    exp := case when ty.valid_months is not null then app.add_months_js(s_d, ty.valid_months)
                else s_d + coalesce(ty.valid_days, case when ty.passes = 1 then 10 else 30 end) end;
    nc := k = 0 and not had_paid and total > 0 and ty.passes > 1 and not mel and not mine;
    lid := app.next_legacy('PKG', 'public.packages', 4);
    note := case when months > 1 then months || ' month bundle, month ' || (k + 1) || ' of ' || months || '. ' else '' end
         || case when madero then 'Madero (100% ' || mel_n || '). ' else '' end
         || case when mine then mel_n || '''s client (center gets $' || mel_cut || '/pass from ' || mel_n || '). ' else '' end
         || case when disc <> 0 then app.jsnum(disc) || '% off. ' else '' end
         || case when paid <> 0 then '$' || app.jsnum(paid) || ' ' || coalesce(nullif(p_method, ''), 'Cash') || ' ' || app.ddmm() else '' end
         || ' (' || (me->>'name') || ')';
    insert into public.packages (legacy_id, client_id, type_name, kind, passes, used, price_cents, paid_cents, discount_pct,
                                 start_date, expiry_date, effective_expiry, status, new_client, note, created_by)
    values (lid, cl.id, ty.name, ty.kind, ty.passes, 0, round(price * 100), round(paid * 100), round(disc, 2),
            s_d, exp, exp, 'Active', nc, note, me->>'name')
    returning id into pid;
    ids := ids || lid; uids := uids || pid;
  end loop;
  -- wallet: overpaid at the sale, then use the balance on what is still due
  over := app.jsround((coalesce(p_paid, 0) - total) * 100) / 100;
  if over > 0 then
    insert into public.wallet_ledger (day, client_id, amount_cents, reason, package_id, by_who)
    values (app_today(), cl.id, round(over * 100), 'Paid $' || app.jsnum(p_paid) || ' at the sale, package total $' || app.jsnum(total) || '. Extra kept for the next package.', uids[1], me->>'name');
  end if;
  if p_use_wallet then
    bal := app.wallet_balance(cl.id) / 100.0;
    for k in 1 .. array_length(uids, 1) loop
      exit when bal <= 0;
      select greatest(0, price_cents - paid_cents) / 100.0 into due from public.packages where id = uids[k];
      take := least(bal, due);
      continue when take <= 0;
      perform public.pay_package(uids[k], take, 'Wallet', null);
      insert into public.wallet_ledger (day, client_id, amount_cents, reason, package_id, by_who) values (app_today(), cl.id, -round(take * 100), 'Used on ' || ids[k], uids[k], me->>'name');
      bal := app.jsround((bal - take) * 100) / 100; used_w := used_w + take;
    end loop;
  end if;
  return jsonb_build_object('id', ids[1], 'ids', to_jsonb(ids), 'uuids', to_jsonb(uids), 'total', total, 'walletUsed', app.jsround(used_w * 100) / 100);
end $$;

-- App.gs appPay_ + Wallet.gs walletPay_: anything above what the package still needs goes to the wallet
create or replace function public.pay_package(p_pkg uuid, p_amount numeric, p_method text default 'Cash', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); p public.packages; due numeric; on_pkg numeric; extra numeric;
begin
  if not (p_amount > 0) then raise exception 'Amount missing'; end if;
  select * into p from public.packages where id = p_pkg for update;
  if p.id is null then raise exception 'Package not found'; end if;
  due := greatest(0, (p.price_cents - p.paid_cents) / 100.0);
  on_pkg := least(p_amount, due); extra := app.jsround((p_amount - on_pkg) * 100) / 100;
  if on_pkg > 0 then
    update public.packages set paid_cents = paid_cents + round(on_pkg * 100),
      note = app.append_note(note, '$' || app.jsnum(on_pkg) || ' ' || coalesce(nullif(p_method, ''), 'Cash') || ' ' || app.ddmm() || ' (' || (me->>'name') || ')' || case when coalesce(p_note, '') <> '' then ': ' || left(p_note, 200) else '' end)
     where id = p.id;
  end if;
  if extra > 0 then
    insert into public.wallet_ledger (day, client_id, amount_cents, reason, package_id, by_who)
    values (app_today(), p.client_id, round(extra * 100), 'Paid $' || app.jsnum(p_amount) || ' ' || coalesce(nullif(p_method, ''), 'Cash') || ', $' || app.jsnum(on_pkg) || ' was needed for ' || coalesce(p.legacy_id, p.id::text) || '. Extra kept for the next package.', p.id, me->>'name');
    update public.packages set note = app.append_note(note, '+$' || app.jsnum(extra) || ' extra to wallet (' || (me->>'name') || ')') where id = p.id;
  end if;
  return jsonb_build_object('paid', (select paid_cents / 100.0 from public.packages where id = p.id), 'extra', extra, 'wallet', app.wallet_balance(p.client_id) / 100.0);
end $$;

-- ---------------------------------------------------------------------
-- SESSIONS: book, attendance, cancel
-- ---------------------------------------------------------------------
-- clients a trainer has in one hour across 1:1, 1:2, 1:3 (Code.gs trainerLoad_: rows whose status says cancel do not count)
create or replace function app.trainer_load(p_trainer text, p_day date, p_hour int) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.sessions s join public.session_clients sc on sc.session_id = s.id
   where s.kind in ('1:1', '1:2', '1:3') and s.trainer = p_trainer and s.day = p_day and extract(hour from s.start_time) = p_hour
     and s.status not ilike '%cancel%'
$$;
create or replace function app.cap_check(p_trainer text, p_day date, p_time time, p_adding int) returns void language plpgsql stable as $$
declare name text := app.trainer_name(p_trainer); cap int := app.trainer_cap(name); n int;
begin
  if cap = 0 then return; end if;
  n := app.trainer_load(name, p_day, extract(hour from p_time)::int);
  if n + p_adding > cap then raise exception '% already has % clients at % on %. Max is %.', name, n, to_char(p_time, 'HH24:MI'), p_day, cap; end if;
end $$;
create or replace function app.kind_ok(p_kind text, p_pkg uuid) returns void language plpgsql stable security definer set search_path = public as $$
declare pk text; lid text;
begin
  select kind, legacy_id into pk, lid from public.packages where id = p_pkg;
  if pk is null then raise exception 'Package not found'; end if;
  if not (pk = any(case when p_kind in ('Physio', 'Prehab') then array['Prehab', 'Physio'] when p_kind = 'Osteo' then array['Osteo']
                        when p_kind = 'Madero' then array['Madero'] else array['1:1', '1:2', '1:3'] end)) then
    raise exception 'Package % is a % package, it cannot be used for a % session. Pick the right package.', lid, pk,
      case when p_kind in ('Physio', 'Prehab') then 'PP' else p_kind end;
  end if;
end $$;
create or replace function app.slots_of(p_kind text) returns int language sql immutable as $$
  select case p_kind when '1:2' then 2 when '1:3' then 3 else 1 end
$$;
create or replace function app.prefix_of(p_kind text) returns text language sql immutable as $$
  select case p_kind when '1:1' then 'S11' when '1:2' then 'S12' when '1:3' then 'S13' when 'Osteo' then 'SOT' when 'Madero' then 'SMD' else 'SPP' end
$$;

-- App.gs appBookInto_: joins an open session (same day, hour, trainer, free spot) or creates a new one
create or replace function app.book_into(p_kind text, p_day date, p_time time, p_trainer text, p_pkg uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare fixed text := app.fixed_trainer(p_kind); tr text; s record; free int; sid uuid; lid text; cid uuid;
begin
  if p_pkg is null then raise exception 'No package for this client: sell one first'; end if;
  perform app.kind_ok(p_kind, p_pkg);
  if fixed is null or fixed = '' then perform app.cap_check(p_trainer, p_day, p_time, 1); end if;
  tr := coalesce(nullif(fixed, ''), app.trainer_name(p_trainer));
  select client_id into cid from public.packages where id = p_pkg;
  perform pg_advisory_xact_lock(hashtext('slot:' || p_kind || p_day || p_time));
  for s in select * from public.sessions x where x.kind = p_kind and x.day = p_day and x.start_time = p_time and x.status not ilike '%cancel%'
             and (coalesce(fixed, '') <> '' or x.trainer = tr) order by x.legacy_id, x.id loop
    if exists (select 1 from public.session_clients where session_id = s.id and package_id = p_pkg) then
      return jsonb_build_object('id', s.legacy_id, 'session', s.id, 'joined', true);
    end if;
    if app.slots_of(p_kind) = 1 then continue; end if;
    select min(g) into free from generate_series(0, app.slots_of(p_kind) - 1) g where not exists (select 1 from public.session_clients where session_id = s.id and slot = g);
    if free is not null then
      insert into public.session_clients (session_id, slot, package_id, client_id, name) values (s.id, free, p_pkg, cid, left(coalesce(p_name, ''), 80));
      return jsonb_build_object('id', s.legacy_id, 'session', s.id, 'joined', true);
    end if;
  end loop;
  lid := app.next_legacy(app.prefix_of(p_kind), 'public.sessions', 4);
  insert into public.sessions (legacy_id, kind, day, start_time, end_time, trainer, room, status, pay_source)
  values (lid, p_kind, p_day, p_time, p_time + interval '1 hour', tr, coalesce(app.setting(array['services', p_kind, 'room']) #>> '{}', ''), 'Scheduled',
          case when p_kind in ('Physio', 'Prehab') then 'Client Direct' else '' end)
  returning id into sid;
  insert into public.session_clients (session_id, slot, package_id, client_id, name) values (sid, 0, p_pkg, cid, left(coalesce(p_name, ''), 80));
  return jsonb_build_object('id', lid, 'session', sid, 'joined', false);
end $$;

-- App.gs appPkgDates_: a bundle month starts on its first session; a session after the end with passes left moves the end
create or replace function app.pkg_dates(p_pkg uuid, p_day date, p_restart boolean) returns void language plpgsql security definer set search_path = public as $$
declare p public.packages; e0 date; len int;
begin
  select * into p from public.packages where id = p_pkg for update;
  e0 := coalesce(p.effective_expiry, p.expiry_date);
  if p_restart and p.used = 0 then
    len := case when p.start_date is not null and e0 is not null then e0 - p.start_date else 30 end;
    if not (len > 0) then len := 30; end if;
    update public.packages set start_date = p_day, expiry_date = p_day + len, effective_expiry = p_day + len, status = 'Active' where id = p.id;
    return;
  end if;
  if e0 is not null and p_day > e0 and p.used < p.passes then
    update public.packages set expiry_date = p_day, effective_expiry = p_day, status = 'Active',
      note = coalesce(note, '') || ' · End moved ' || e0 || ' to ' || p_day || ' to finish passes.' where id = p.id;
  end if;
end $$;

-- staff: book a client (App.gs appBook_)
create or replace function public.book_session(p_kind text, p_day date, p_time time, p_trainer text, p_pkg uuid, p_name text, p_restart boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']);
begin
  if p_kind not in ('1:1', '1:2', '1:3', 'Physio', 'Prehab', 'Osteo', 'Madero') then raise exception 'Unknown session type'; end if;
  perform app.pkg_dates(p_pkg, p_day, p_restart);
  return app.book_into(p_kind, p_day, p_time, p_trainer, p_pkg, p_name);
end $$;

-- the session status from its clients (App.gs appSessObj_ / appSetAtt_ rules)
--  1:2: nobody marked = Scheduled; everyone Early Cancel = Cancelled; all marked or someone Present = Done
--  1:3: Done once someone is marked; Cancelled when every client cancelled
--  one client: Done (Present), Late Cancel, No Show, Cancelled (Early Cancel), Scheduled (not marked)
create or replace function app.session_status(p_session uuid) returns text language sql stable security definer set search_path = public as $$
  with c as (select att, pass from public.session_clients where session_id = p_session), s as (select kind, status from public.sessions where id = p_session)
  select case
    when (select count(*) from c) = 0 then (select status from s)
    when (select bool_and(att = 'Early Cancel') from c) then 'Cancelled'
    when (select kind from s) = '1:2' then case when (select count(*) from c where pass <> '') = 0 then 'Scheduled'
                                                 when (select bool_and(pass <> '') from c) or (select bool_or(att = 'Present') from c) then 'Done' else 'Scheduled' end
    when (select kind from s) = '1:3' then case when (select bool_or(att <> '') from c) then 'Done' else 'Scheduled' end
    else (select case att when 'Present' then 'Done' when '' then 'Scheduled' when 'Early Cancel' then 'Cancelled' else att end from c limit 1)
  end
$$;

-- App.gs app12EarlyCancel_: a 1:2 early cancel by one client cancels the whole session for both, nobody pays.
-- The partner and the trainer get a notice, the desk and the owners too; the desk also gets a WhatsApp when p_ping.
create or replace function app.cancel_pair(p_session uuid, p_slot int, p_by text, p_reason text, p_all boolean, p_ping boolean)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessions; who text; first text; when_t text; names text; staff_txt text; r record; desk text := app.desk_name();
begin
  select * into s from public.sessions where id = p_session for update;
  update public.session_clients set att = 'Early Cancel', pass = 'N', gcal_event = null where session_id = s.id;
  update public.sessions set status = 'Cancelled' where id = s.id;
  select name into who from public.session_clients where session_id = s.id and slot = p_slot;
  who := btrim(coalesce(who, '')); first := coalesce(nullif(split_part(who, ' ', 1), ''), 'Your partner');
  when_t := s.day || ' at ' || to_char(s.start_time, 'HH24:MI');
  update public.sessions set note = app.append_note(note, who || ': Early Cancel, whole 1:2 session cancelled, no pass used'
    || case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end || ' via app, ' || p_by) where id = s.id;
  for r in select * from public.session_clients where session_id = s.id order by slot loop
    continue when r.slot = p_slot and not p_all;
    perform app.notice(r.client_id, null, '1:2 cancelled', case when p_all
      then 'Your 1:2 session on ' || when_t || ' with ' || s.trainer || ' is cancelled by Wellbe. No pass was used. Message ' || desk || ' to book another time.'
      else 'Your 1:2 session on ' || when_t || ' with ' || s.trainer || ' is cancelled: ' || first || ' cancelled a day or more before. No pass was used. Message ' || desk || ' to book another time.' end);
  end loop;
  select string_agg(btrim(name), ' + ' order by slot) into names from public.session_clients where session_id = s.id;
  staff_txt := '1:2 ' || names || ' on ' || when_t || ' with ' || s.trainer || ' is CANCELLED: '
    || case when p_all then 'cancelled for both by ' || p_by else who || ' cancelled early (' || p_by || ')' end || '. No pass used. Rebook them if they want.';
  perform app.notice(null, x, '1:2 cancelled', staff_txt) from app.staff_for(s.trainer) x;
  if p_ping then perform app.ping_desk('Wellbe: ' || staff_txt); end if;
  perform app.recount(package_id) from public.session_clients where session_id = s.id;
end $$;

-- App.gs appSetAtt_: att Present | Late Cancel | No Show | Early Cancel | '' (back to scheduled)
create or replace function app.set_att(p_session uuid, p_slot int, p_att text, p_by text, p_reason text default '', p_all boolean default false, p_ping boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.sessions; c public.session_clients; flag text; deducts jsonb := '{"Present":1,"Done":1,"Late Cancel":1,"No Show":1}';
begin
  if p_att not in ('', 'Present', 'Late Cancel', 'No Show', 'Early Cancel') then raise exception 'Unknown attendance'; end if;
  select * into s from public.sessions where id = p_session for update;
  select * into c from public.session_clients where session_id = p_session and slot = p_slot;
  if c.package_id is null then raise exception 'No client in that spot'; end if;
  if s.kind = '1:2' and p_att = 'Early Cancel' then perform app.cancel_pair(s.id, p_slot, p_by, p_reason, p_all, p_ping); return c.package_id; end if;
  flag := case when p_att = '' then '' when deducts ? p_att then 'Y' else 'N' end;
  update public.session_clients set att = p_att, pass = flag where session_id = s.id and slot = p_slot;
  if s.kind = '1:2' and (p_att in ('Late Cancel', 'No Show')) and coalesce(p_reason, '') = '' then
    update public.sessions set note = app.append_note(note, btrim(c.name) || ': ' || p_att || ' via app, ' || p_by) where id = s.id;
  end if;
  if s.kind = '1:3' then        -- per client attendance: the row becomes Done once someone is marked
    if p_att <> '' and s.status in ('Scheduled', '') then update public.sessions set status = 'Done' where id = s.id; end if;
  elsif s.kind = '1:2' then     -- never Done before someone is Present (or both are marked)
    update public.sessions set status = app.session_status(s.id) where id = s.id;
  else                          -- one client: the status carries the attendance
    update public.sessions set status = case p_att when '' then 'Scheduled' when 'Present' then 'Done' when 'Early Cancel' then 'Cancelled' else p_att end where id = s.id;
  end if;
  if p_att = 'Early Cancel' or coalesce(p_reason, '') <> '' then
    update public.sessions set note = app.append_note(note, c.name || ': ' || p_att || case when coalesce(p_reason, '') <> '' then ' (exception: ' || p_reason || ')' else '' end || ' via app, ' || p_by) where id = s.id;
  end if;
  return c.package_id;
end $$;

-- staff: mark attendance (App.gs appAtt_). Trainers only on their own sessions.
create or replace function public.mark_attendance(p_session uuid, p_slot int, p_att text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); pkg uuid; tr text;
begin
  if me->>'role' = 'trainer' then
    select trainer into tr from public.sessions where id = p_session;
    if tr is distinct from me->>'trainer' then raise exception 'Not your session'; end if;
  end if;
  pkg := app.set_att(p_session, p_slot, p_att, me->>'name');
  return jsonb_build_object('pkg', pkg, 'used', app.recount(pkg));
end $$;

-- 21:30 job: everyone not marked today is Present (App.gs appDefaultPresent)
create or replace function public.default_present() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  perform app.need(array['owner']);
  for r in select sc.session_id, sc.slot, sc.package_id from public.sessions s join public.session_clients sc on sc.session_id = s.id
            where s.day = app_today() and s.status not ilike '%cancel%' and sc.att = '' and sc.pass = '' order by s.legacy_id, sc.slot loop
    perform app.set_att(r.session_id, r.slot, 'Present', 'auto 21:30'); perform app.recount(r.package_id); n := n + 1;
  end loop;
  return n;
end $$;

-- client: cancel a session (Client.gs clCancel_). Early = a day or more before (kept), Late = same day (counts as done).
create or replace function public.cancel_session(p_session uuid, p_client uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client); s public.sessions; c public.session_clients; kind text; whole boolean; pkg uuid; desk text := app.desk_name();
begin
  select * into s from public.sessions where id = p_session for update;
  select * into c from public.session_clients where session_id = p_session and client_id = p_client order by slot limit 1;
  if s.id is null or c.package_id is null then raise exception 'This session is not on your account.'; end if;
  if app.at(s.day, s.start_time) <= now() then raise exception 'This session already started. Message %.', desk; end if;
  if s.kind = '1:3' and c.att <> '' then raise exception 'Already marked. Message %.', desk; end if;
  if s.kind = '1:2' and c.pass <> '' then raise exception 'Already marked. Message %.', desk; end if;
  if s.status ilike '%cancel%' then raise exception 'Already cancelled.'; end if;
  kind := case when s.day > app_today() then 'Early Cancel' else 'Late Cancel' end;
  whole := s.kind = '1:2' and kind = 'Early Cancel';
  pkg := app.set_att(s.id, c.slot, kind, 'client app', '', false, false);
  if s.kind = '1:3' and not exists (select 1 from public.session_clients where session_id = s.id and att not ilike '%cancel%') then
    update public.sessions set status = 'Cancelled' where id = s.id;
  end if;
  perform app.recount(pkg);
  perform app.client_log(p_client, c.name, 'Cancelled', kind || case when kind = 'Late Cancel' then ' (same day, counts as done)'
      when whole then ' (whole 1:2 session cancelled, partner and trainer told in the app)' else ' (session kept)' end || ' · '
      || case when s.kind in ('Physio', 'Prehab') then 'PP' else s.kind end || ' with ' || s.trainer,
    s.day || ' ' || to_char(s.start_time, 'HH24:MI') || ' · ' || s.legacy_id, pkg, 'New', '{}');
  return jsonb_build_object('kind', kind, 'whole', whole);
end $$;

-- client: take a free chair in a running 1:3 (Client.gs clJoin_)
create or replace function public.client_join(p_client uuid, p_day date, p_time time, p_trainer text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client); tr text := app.trainer_name(p_trainer); min_h int := app.setting_int('{windows,joinMinH}', 48);
  join_days int := app.setting_int('{windows,joinDays}', 10); ahead int := app.setting_int('{windows,ahead}', 35); desk text := app.desk_name();
  pick record; res jsonb;
begin
  if app.at(p_day, p_time) - now() < make_interval(hours => min_h) then raise exception 'Less than % hours away: message % to add you.', min_h, desk; end if;
  if not exists (select 1 from public.sessions s where s.kind = '1:3' and s.day = p_day and s.start_time = p_time and s.trainer = tr
                   and s.status not ilike '%cancel%' and (select count(*) from public.session_clients where session_id = s.id) < 3) then
    raise exception 'This spot was just taken. Pick another one.';
  end if;
  -- the 1:3 package that covers that day with a pass left that is not already booked
  if not exists (select 1 from public.packages p where p.client_id = p_client and p.status = 'Active' and app.kind_of(p.type_name) = '1:3'
                   and not (p.start_date > p_day) and not (coalesce(p.effective_expiry, p.expiry_date) is not null and p_day > coalesce(p.effective_expiry, p.expiry_date))
                   and p.passes - p.used > 0) then
    raise exception 'No group sessions left on your package. Message % to renew.', desk;
  end if;
  select p.id, (select name from public.clients where id = p.client_id) as name into pick
    from public.packages p
   where p.client_id = p_client and p.status = 'Active' and app.kind_of(p.type_name) = '1:3'
     and not (p.start_date > p_day) and not (coalesce(p.effective_expiry, p.expiry_date) is not null and p_day > coalesce(p.effective_expiry, p.expiry_date))
     and p.passes - p.used - (select count(*) from public.session_clients sc join public.sessions s on s.id = sc.session_id
                               where sc.package_id = p.id and sc.att = '' and s.status <> 'Cancelled'
                                 and s.day between app_today() - 1 and app_today() + greatest(ahead, join_days) + 1
                                 and app.at(s.day, s.start_time) > now() - interval '1 hour') > 0
   order by p.legacy_id limit 1;
  if pick.id is null then raise exception 'Every session left on your package is already booked. Cancel one, or message % to renew.', desk; end if;
  res := app.book_into('1:3', p_day, p_time, tr, pick.id, pick.name);
  perform app.client_log(p_client, pick.name, 'Joined a spot', '1:3 with ' || tr, p_day || ' ' || to_char(p_time, 'HH24:MI') || ' · ' || (res->>'id'), pick.id, 'New', '{}');
  return jsonb_build_object('id', res->>'id', 'session', res->'session');
end $$;

-- ---------------------------------------------------------------------
-- OFFERS: 3 months (one payment) and the 6 month upgrade (Client.gs clOffers_)
-- ---------------------------------------------------------------------
create or replace function app.pkg_phase(p public.packages, today date) returns text language sql stable as $$
  select case when p.status ~* 'cancel' then 'past'
              when p.status = 'Active' and p.start_date > today then 'future'
              when p.status = 'Active' and p.passes > 0 and not (coalesce(p.effective_expiry, p.expiry_date) < today and p.used >= p.passes) then 'current'
              else 'past' end
$$;
create or replace function app.offers(p_client uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare today date := app_today(); out jsonb := '{}'; t text; rows public.packages[]; n int; i int; k int; mo numeric; r1 public.packages; r3 public.packages; d int;
  extended boolean; asked boolean; paid3 numeric; p6 numeric; due numeric; cur public.packages; half boolean; m3 numeric := (app.setting('{offers,m3Pct}'))::text::numeric;
  m6 numeric := (app.setting('{offers,m6Pct}'))::text::numeric; bundle int := app.setting_int('{offers,bundleDays}', 70); lbl text; has_future boolean; p3 numeric;
begin
  for t in select distinct type_name from public.packages where client_id = p_client and type_name ~ 'x/month \(\$\d+' and status !~* 'cancel' and start_date is not null order by 1 loop
    select array_agg(p order by p.start_date) into rows from public.packages p where p.client_id = p_client and p.type_name = t and p.status !~* 'cancel' and p.start_date is not null;
    n := array_length(rows, 1); mo := substring(t from '\(\$(\d+)')::numeric; i := -1;
    lbl := regexp_replace(t, '\s*\(\$[^)]*\)', '');
    k := n - 3;
    while k >= 0 loop
      if rows[k + 3].start_date - rows[k + 1].start_date <= bundle then i := k; exit; end if;
      k := k - 1;
    end loop;
    if i > -1 and exists (select 1 from unnest(rows[i + 1:]) x where app.pkg_phase(x, today) <> 'past') then
      r1 := rows[i + 1]; r3 := rows[i + 3]; d := today - r1.start_date; extended := n > i + 3;
      asked := exists (select 1 from public.client_requests q where q.client_id = p_client and q.type = '6 month upgrade' and q.package_id = r1.id and q.status <> 'Declined');
      if not extended and not asked and d between 52 and 68 then
        paid3 := r1.price_cents / 100.0 + rows[i + 2].price_cents / 100.0 + r3.price_cents / 100.0;
        p6 := app.jsround(mo * 6 * (100 - m6) / 100); due := p6 - paid3;
        if due > 0 then
          out := out || jsonb_build_object('m6', jsonb_build_object('pkg', r1.legacy_id, 'pkgId', r1.id, 'type', regexp_replace(r1.type_name, '\s*\(\$[^)]*\)', ''), 'mo', mo, 't6', mo * 6, 'p6', p6,
                   'paid3', paid3, 'due', due, 'each', app.jsround(due / 3), 'save', mo * 6 - p6, 'starts', r3.start_date + 30));
        end if;
      end if;
      continue;
    end if;
    select x.* into cur from unnest(rows) x where app.pkg_phase(x, today) = 'current' order by x.start_date desc limit 1;
    has_future := exists (select 1 from unnest(rows) x where app.pkg_phase(x, today) = 'future');
    if cur.id is null or has_future then continue; end if;
    half := cur.used >= cur.passes / 2.0 or today - cur.start_date >= 15;
    asked := exists (select 1 from public.client_requests q where q.client_id = p_client and q.type = '3 month offer' and q.package_id = cur.id and q.status <> 'Declined');
    if half and not asked then
      p3 := app.jsround(mo * 3 * (100 - m3) / 100);
      out := out || jsonb_build_object('m3', jsonb_build_object('pkg', cur.legacy_id, 'pkgId', cur.id, 'type', lbl, 'mo', mo, 't3', mo * 3, 'p3', p3, 'save', mo * 3 - p3,
               'starts', coalesce(cur.effective_expiry, cur.expiry_date)));
    end if;
  end loop;
  return out;
end $$;

-- client: ask for the 6 month upgrade. Nothing is created now: the desk accepts it (Client.gs clUpgrade6_)
create or replace function public.request_upgrade6(p_client uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client); o jsonb := app.offers(p_client)->'m6'; nm text;
begin
  if o is null then raise exception 'The 6 month upgrade is not open on your package right now.'; end if;
  select name into nm from public.clients where id = p_client;
  o := o || jsonb_build_object('ptype', (select type_name from public.packages where id = (o->>'pkgId')::uuid));
  perform app.client_log(p_client, nm, '6 month upgrade', 'Wants the 6 month upgrade: pays $' || app.jsnum((o->>'due')::numeric) || ' at the center ('
    || app.jsnum((app.setting('{offers,m6Pct}'))::text::numeric) || '% off, $' || app.jsnum((o->>'each')::numeric) || ' a month for months 4 to 6, starting ' || (o->>'starts')
    || '). Accept to add months 4, 5 and 6.', '', (o->>'pkgId')::uuid, 'New', o);
  return jsonb_build_object('due', (o->>'due')::numeric, 'ids', '[]'::jsonb);
end $$;

-- same row as appSell_ for packages made from a request (Client.gs clAddPkg_)
create or replace function app.add_pkg(p_client uuid, p_type text, p_price numeric, p_start date, p_disc_frac numeric, p_note text) returns text language plpgsql security definer set search_path = public as $$
declare t public.package_types; total int; lid text := app.next_legacy('PKG', 'public.packages', 4);
begin
  select * into t from public.package_types where name = p_type; total := coalesce(t.passes, 12);
  insert into public.packages (legacy_id, client_id, type_name, kind, passes, used, price_cents, paid_cents, discount_pct, start_date, expiry_date, effective_expiry, status, new_client, note)
  values (lid, p_client, p_type, app.kind_of(p_type), total, 0, round(p_price * 100), 0, p_disc_frac * 100, p_start, p_start + 30, p_start + 30, 'Active', false, p_note);
  return lid;
end $$;

-- desk: handle a request from the To do (Client.gs appReqDone_): done | decline | accept
create or replace function public.handle_request(p_request uuid, p_act text, p_day date default null, p_time time default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); q public.client_requests; out jsonb := '{}'; o jsonb; cur public.packages; each numeric; made text[] := '{}'; k int;
  sold jsonb; bk jsonb; nm text; d date; t time; m6 numeric := (app.setting('{offers,m6Pct}'))::text::numeric; m3 numeric := (app.setting('{offers,m3Pct}'))::text::numeric;
  frz int := app.setting_int('{windows,freezeDays}', 7); cur_end date; new_end date;
begin
  select * into q from public.client_requests where id = p_request for update;
  if q.id is null then raise exception 'Request not found, refresh'; end if;
  if q.status <> 'New' then raise exception 'Already handled by %', coalesce(q.handled_by, 'someone'); end if;
  select name into nm from public.clients where id = q.client_id;
  if p_act = 'accept' then
    if q.type = 'Physio visit' then
      d := coalesce(p_day, split_part(q.slot, ' ', 1)::date); t := coalesce(p_time, split_part(q.slot, ' ', 2)::time);
      sold := public.sell_package(q.client_id, app.setting('{offers,physioType}') #>> '{}', 1, (app.setting('{offers,physioPct}'))::text::numeric, null, 0, d);
      bk := app.book_into('Physio', d, t, app.fixed_trainer('Physio'), (sold->'uuids'->>0)::uuid, nm);
      out := jsonb_build_object('pkg', sold->>'id', 'session', bk->>'id');
    elsif q.type = 'Freeze' then
      select * into cur from public.packages where id = q.package_id for update;
      cur_end := coalesce(cur.extended_expiry, cur.effective_expiry, cur.expiry_date);
      if cur_end is null then raise exception 'Package % has no end date: fix it first', cur.legacy_id; end if;
      new_end := cur_end + frz;
      update public.packages set extended_expiry = new_end, effective_expiry = new_end,
        note = app.append_note(note, 'Frozen ' || frz || ' days from ' || coalesce(q.data->>'from', '') || ', ends ' || new_end || ' (' || (me->>'name') || ')') where id = cur.id;
      out := jsonb_build_object('end', new_end);
    elsif q.type = '3 month offer' then
      o := q.data; select * into cur from public.packages where id = q.package_id;
      if cur.id is null then raise exception 'Package not found'; end if;
      each := app.jsround((o->>'p3')::numeric / 3);
      for k in 0 .. 2 loop
        made := made || app.add_pkg(q.client_id, cur.type_name, case when k < 2 then each else (o->>'p3')::numeric - each * 2 end,
          coalesce((o->>'starts')::date, coalesce(cur.effective_expiry, cur.expiry_date)) + 30 * k, m3 / 100,
          '3 month bundle (' || app.jsnum(m3) || '% off, one payment), month ' || (k + 1) || ' of 3. From the client app.');
      end loop;
      out := jsonb_build_object('ids', to_jsonb(made));
    elsif q.type = '6 month upgrade' then
      o := q.data; select * into cur from public.packages where id = q.package_id;
      if cur.id is null then raise exception 'Package not found'; end if;
      if not (coalesce((o->>'due')::numeric, 0) > 0) or o->>'starts' is null then raise exception 'This request has no offer details: add months 4 to 6 by hand'; end if;
      if exists (select 1 from public.packages where client_id = q.client_id and type_name = coalesce(o->>'ptype', cur.type_name) and start_date = (o->>'starts')::date) then
        raise exception 'Months 4 to 6 already exist for this client (made before this update). Tap done instead.';
      end if;
      each := coalesce(nullif((o->>'each')::numeric, 0), app.jsround((o->>'due')::numeric / 3));
      for k in 0 .. 2 loop
        made := made || app.add_pkg(q.client_id, coalesce(o->>'ptype', cur.type_name), case when k < 2 then each else (o->>'due')::numeric - each * 2 end,
          (o->>'starts')::date + 30 * k, m6 / 100, '6 month upgrade (' || app.jsnum(m6) || '% off), month ' || (4 + k) || ' of 6. Accepted by ' || (me->>'name') || ' from the client app.');
      end loop;
      out := jsonb_build_object('ids', to_jsonb(made));
    end if;
  end if;
  update public.client_requests set status = case when p_act = 'decline' then 'Declined' else 'Done' end, handled_by = me->>'name', handled_at = now() where id = q.id;
  return out;
end $$;

-- ---------------------------------------------------------------------
-- NOTICES and LEADS
-- ---------------------------------------------------------------------
create or replace function public.notice_read(p_ids uuid[]) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.notices set read_at = now()
   where id = any(p_ids) and read_at is null
     and ((for_staff is not null and for_staff = app.my_staff()) or (for_client is not null and app.is_mine(for_client)));
  get diagnostics n = row_count; return n;
end $$;

-- a lead that came in during quiet hours (settings leads.quietFrom to quietTo, Beirut) starts at quietTo; null = not held (App.gs appLeadStart_)
create or replace function app.lead_start(sub timestamptz) returns timestamptz language plpgsql stable as $$
declare f numeric := (app.setting('{leads,quietFrom}'))::text::numeric; t numeric := (app.setting('{leads,quietTo}'))::text::numeric;
  loc timestamp := sub at time zone 'Asia/Beirut'; h numeric; d date;
begin
  if f is null or t is null or f = t then return null; end if;
  h := extract(hour from loc) + extract(minute from loc) / 60.0; d := loc::date;
  if not (case when f > t then (h >= f or h < t) else (h >= f and h < t) end) then return null; end if;
  if f > t and h >= f then d := d + 1; end if;
  return (d + make_interval(hours => t::int)) at time zone 'Asia/Beirut';
end $$;
-- ad leads that still need a call: No Booking, or Pending with no package. Stage = oldest step passed (App.gs appLeadFollowups_)
create or replace view public.lead_followups with (security_invoker = true) as
  select x.id, x.legacy_id, x.name, x.phone, x.status, x.submitted_at, x.trial_date, x.trial_time,
         case when now() - x.base >= interval '72 hours' then '72h' when now() - x.base >= interval '24 hours' then '24h' else '15m' end as stage
    from (select l.*, coalesce(app.lead_start(l.submitted_at), l.submitted_at) as base, app.lead_start(l.submitted_at) is not null as held
            from public.leads l
           where (l.status = 'No Booking' or (l.status = 'Pending' and l.package_id is null))) x
   where now() - x.base >= case when x.held then interval '0' else interval '15 minutes' end
     and now() - x.submitted_at <= interval '30 days'
   order by x.submitted_at;

-- ---------------------------------------------------------------------
-- GAME: Corniche Run (RunGame.gs clRun_ + Levels.gs)
-- ---------------------------------------------------------------------
create or replace function app.lv_need(n int) returns int language sql immutable as $$ select app.jsround(330 * power(least(n, 12), 0.9))::int $$;
create or replace function app.lv_of(xp bigint) returns jsonb language plpgsql stable as $$
declare l int := 1; lft bigint := greatest(0, coalesce(xp, 0)); mx int := app.setting_int('{game,levelMax}', 50);
begin
  while l < mx and lft >= app.lv_need(l) loop lft := lft - app.lv_need(l); l := l + 1; end loop;
  return jsonb_build_object('level', l, 'into', case when l < mx then lft else 0 end, 'need', case when l < mx then app.lv_need(l) else 0 end, 'total', greatest(0, coalesce(xp, 0)));
end $$;
create or replace function app.lv_has(owned jsonb, level int, k text) returns boolean language sql stable as $$
  select app.setting(array['game', 'shop', k]) is not null
     and (level >= (app.setting(array['game', 'shop', k, 'lv']))::text::int or coalesce((owned->>k)::numeric, 0) > 0)
$$;
-- 3 missions a day, the same for everyone (RunGame.gs runToday_)
create or replace function app.missions_today(d date) returns jsonb language plpgsql stable as $$
declare seed bigint := to_char(d, 'YYYYMMDD')::bigint % 2147483647; pool jsonb := app.setting('{game_rules,missions}'); out jsonb := '[]'; idx int;
begin
  while jsonb_array_length(out) < 3 and jsonb_array_length(pool) > 0 loop
    seed := (seed * 48271) % 2147483647; idx := (seed % jsonb_array_length(pool))::int;
    out := out || jsonb_build_array(pool->idx); pool := pool - idx;
  end loop;
  return out;
end $$;
create or replace function app.trained_on(p_client uuid, d1 date, d2 date) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.session_clients sc join public.sessions s on s.id = sc.session_id
                  where sc.client_id = p_client and s.day between d1 and d2 and s.status <> 'Cancelled' and sc.att ~* 'present|done')
$$;

-- the game's leaderboards: day, week, all time; hidden players are left out except yourself
create or replace function app.boards(p_client uuid) returns jsonb language sql stable security definer set search_path = public as $$
  with base as (
    select g.*, (g.client_id = p_client) as me,
           case when array_length(regexp_split_to_array(btrim(g.name), '\s+'), 1) > 1
                then split_part(btrim(g.name), ' ', 1) || ' ' || left((regexp_split_to_array(btrim(g.name), '\s+'))[array_length(regexp_split_to_array(btrim(g.name), '\s+'), 1)], 1) || '.'
                else coalesce(nullif(btrim(g.name), ''), 'Runner') end as short
      from public.game_players g
     where g.client_id = p_client or coalesce((g.owned->>'lbHide')::boolean, false) = false),
  d as (select short, day_best as s, me, row_number() over (order by day_best desc, created_at, client_id) i from base where day_key = app_today() and day_best > 0),
  w as (select short, week_best as s, me, row_number() over (order by week_best desc, created_at, client_id) i from base where week_key = date_trunc('week', app_today())::date and week_best > 0),
  a as (select short, best_score as s, me, row_number() over (order by best_score desc, created_at, client_id) i from base where best_score > 0)
  select jsonb_build_object(
    'lists', jsonb_build_object(
      'day', coalesce((select jsonb_agg(jsonb_build_object('n', short, 's', s, 'me', me, 'i', i) order by i) from d where i <= 10), '[]'),
      'week', coalesce((select jsonb_agg(jsonb_build_object('n', short, 's', s, 'me', me, 'i', i) order by i) from w where i <= 10), '[]'),
      'all', coalesce((select jsonb_agg(jsonb_build_object('n', short, 's', s, 'me', me, 'i', i) order by i) from a where i <= 10), '[]'),
      'totals', jsonb_build_object('day', (select count(*) from d), 'week', (select count(*) from w), 'all', (select count(*) from a))),
    'rank', jsonb_build_object('day', coalesce((select i from d where me), 0), 'week', coalesce((select i from w where me), 0), 'all', coalesce((select i from a where me), 0)))
$$;

-- op save: one finished run. The phone sends {secs, m, coins, score, spent, ev:{...}}; the server decides everything.
create or replace function public.game_save_run(p_client uuid, p_run jsonb, p_lbhide boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client); g public.game_players; today date := app_today(); wk date := date_trunc('week', app_today())::date;
  secs int := greatest(0, coalesce((p_run->>'secs')::numeric, 0))::int; m int := greatest(0, app.jsround(coalesce((p_run->>'m')::numeric, 0)))::int;
  coins int := greatest(0, app.jsround(coalesce((p_run->>'coins')::numeric, 0)))::int; score int := greatest(0, app.jsround(coalesce((p_run->>'score')::numeric, 0)))::int;
  spent int := greatest(0, app.jsround(coalesce((p_run->>'spent')::numeric, 0)))::int; ev jsonb := coalesce(p_run->'ev', '{}');
  t1500 boolean := coalesce((ev->>'t1500')::numeric, 0) > 0; t500 boolean := coalesce((ev->>'t500')::numeric, 0) > 0;
  ran int; v_owned jsonb; v_up jsonb; v_ms jsonb; v_badges jsonb; boost boolean; got jsonb; earned int; mi jsonb; cur numeric; mdone jsonb := '[]'; lt int; ce int := 0;
  cash jsonb := app.setting('{game,cash}'); rules jsonb := app.setting('{game_rules}'); xpg int; before int; after int; l int; ups jsonb := '[]'; chest int; gotl jsonb; sk text;
  newb jsonb := '[]'; rec boolean; boards jsonb; tot jsonb; rk jsonb; lu int;
begin
  select * into g from public.game_players where client_id = p_client for update;
  if g.client_id is null then
    insert into public.game_players (client_id, name) values (p_client, (select btrim(name) from public.clients where id = p_client)) returning * into g;
  end if;
  v_owned := g.owned; v_up := g.upgrades; v_badges := g.badges;
  if coalesce((v_owned->>'_m')::int, 0) = 0 then         -- players who bought an upgrade keep that power (Levels.gs lvMigrate_)
    select v_owned || coalesce(jsonb_object_agg(k, 1), '{}') into v_owned from unnest(array['magnet', 'jet', 'shoes']) k where coalesce((v_up->>k)::numeric, 0) > 0;
    v_owned := v_owned || '{"_m":1}';
  end if;
  v_ms := case when g.missions->>'d' = today::text then g.missions else jsonb_build_object('d', today, 'st', '{}'::jsonb, 'done', '[]'::jsonb, 'bonus', 0) end;
  if g.day_key is distinct from today then g.day_key := today; g.day_best := 0; end if;
  if g.week_key is distinct from wk then g.week_key := wk; g.week_best := 0; end if;
  boost := app.trained_on(p_client, today - 1, today);
  ran := greatest(0, m - case when t1500 then 1500 else 0 end);       -- meters actually run: a head start never counts for credit or XP
  if t1500 and not (coalesce((v_owned->>'t1500')::numeric, 0) > 0) then raise exception 'No start at 1,500 m ticket left.'; end if;
  if t500 and not (coalesce((v_owned->>'t500')::numeric, 0) > 0) then raise exception 'No 500 coin run ticket left.'; end if;
  if secs < 3 or secs > 3600 then raise exception 'That run is not possible.'; end if;
  if ran > secs * 19.5 + 30 or coins > ran * 0.6 * (case when t500 then 2 else 1 end) + 80 or score > m * 5 + coins * 5 + 50 then raise exception 'That run is not possible.'; end if;
  if g.last_run_at is not null and now() - g.last_run_at < make_interval(secs => secs * 0.7) then raise exception 'Slow down, one run at a time.'; end if;
  got := jsonb_build_object('coins', coins, 'm', m, 'score', score, 'runs', 1,
    'jumps', greatest(0, least(app.jsround(coalesce((ev->>'jumps')::numeric, 0)), secs * 3)), 'slides', greatest(0, least(app.jsround(coalesce((ev->>'slides')::numeric, 0)), secs * 3)),
    'roof', greatest(0, least(app.jsround(coalesce((ev->>'roof')::numeric, 0)), m)), 'powers', greatest(0, least(app.jsround(coalesce((ev->>'powers')::numeric, 0)), floor(m / 40.0) + 2)),
    'clean', greatest(0, least(app.jsround(coalesce((ev->>'clean')::numeric, 0)), m)), 'mult', greatest(0, least(app.jsround(coalesce((ev->>'mult')::numeric, 0)), 5)));
  earned := coins * case when boost then 2 else 1 end;
  for mi in select * from jsonb_array_elements(app.missions_today(today)) loop
    cur := coalesce((v_ms->'st'->>(mi->>'k'))::numeric, 0);
    v_ms := jsonb_set(v_ms, array['st', mi->>'k'], to_jsonb(case when mi->>'m' = 'sum' then cur + (got->>(mi->>'s'))::numeric else greatest(cur, (got->>(mi->>'s'))::numeric) end));
    if not (v_ms->'done' ? (mi->>'k')) and (v_ms->'st'->>(mi->>'k'))::numeric >= (mi->>'n')::numeric then
      v_ms := jsonb_set(v_ms, '{done}', (v_ms->'done') || to_jsonb(mi->>'k')); earned := earned + (mi->>'r')::int;
      mdone := mdone || jsonb_build_array(jsonb_build_object('t', mi->>'t', 'r', (mi->>'r')::int));
    end if;
  end loop;
  if jsonb_array_length(v_ms->'done') >= 3 and coalesce((v_ms->>'bonus')::int, 0) = 0 then
    v_ms := v_ms || '{"bonus":1}'; earned := earned + (rules->>'allBonus')::int; mdone := mdone || jsonb_build_array(jsonb_build_object('t', 'All 3 missions done', 'r', (rules->>'allBonus')::int));
  end if;
  lt := greatest(0, least(app.jsround(coalesce((ev->>'letters')::numeric, 0)), case when m >= 800 then 2 when m >= 350 then 1 else 0 end));
  if lt > 0 then
    v_ms := v_ms || jsonb_build_object('wl', least(7, coalesce((v_ms->>'wl')::int, 0) + lt));
    if (v_ms->>'wl')::int >= 7 and coalesce((v_ms->>'wb')::int, 0) = 0 then
      v_ms := v_ms || '{"wb":1}'; earned := earned + (rules->>'wordBonus')::int; mdone := mdone || jsonb_build_array(jsonb_build_object('t', 'WELLBE complete', 'r', (rules->>'wordBonus')::int));
    end if;
  end if;
  -- Wellbe Credit: CENTS for a run that passes MIN_M (once per run), max DAY_MAX a day. Every player earns.
  if ran >= (cash->>'MIN_M')::int then
    ce := greatest(0, least((cash->>'CENTS')::int, (cash->>'DAY_MAX')::int - coalesce((v_ms->>'cash')::int, 0)));
    v_ms := v_ms || jsonb_build_object('cash', coalesce((v_ms->>'cash')::int, 0) + ce);
    g.credit_cents := g.credit_cents + ce; g.credit_earned_cents := g.credit_earned_cents + ce;
    if ce > 0 then insert into public.credit_ledger (client_id, delta_cents, reason) values (p_client, ce, 'Run over ' || (cash->>'MIN_M') || ' m'); end if;
  end if;
  -- XP: meters run, missions, training at the center today (once a day)
  xpg := floor(ran * (rules->'xp'->>'PER_M')::numeric)::int + jsonb_array_length(mdone) * (rules->'xp'->>'MISSION')::int;
  if coalesce((v_ms->>'trx')::int, 0) = 0 and app.trained_on(p_client, today, today) then v_ms := v_ms || '{"trx":1}'; xpg := xpg + (rules->'xp'->>'TRAINED')::int; end if;
  if t1500 then v_owned := v_owned || jsonb_build_object('t1500', (v_owned->>'t1500')::numeric - 1); end if;
  if t500 then v_owned := v_owned || jsonb_build_object('t500', (v_owned->>'t500')::numeric - 1); end if;
  before := (app.lv_of(g.xp)->>'level')::int; g.xp := g.xp + greatest(0, xpg); after := (app.lv_of(g.xp)->>'level')::int;
  for l in before + 1 .. after loop
    chest := 100 + 25 * l; g.coins := g.coins + chest; gotl := '[]';
    for sk in select key from jsonb_each(app.setting('{game,shop}')) loop
      if app.setting(array['game', 'shop', sk, 'kind']) #>> '{}' = 'once' and (app.setting(array['game', 'shop', sk, 'lv']))::text::int = l then gotl := gotl || to_jsonb(app.setting(array['game', 'shop', sk, 'n']) #>> '{}'); end if;
      if app.setting(array['game', 'shop', sk, 'kind']) #>> '{}' = 'ticket' and l >= (app.setting(array['game', 'shop', sk, 'lv']))::text::int then
        v_owned := v_owned || jsonb_build_object(sk, coalesce((v_owned->>sk)::numeric, 0) + 1); gotl := gotl || to_jsonb('1 ' || (app.setting(array['game', 'shop', sk, 'n']) #>> '{}'));
      end if;
    end loop;
    if l = app.setting_int('{game,badgeLv}', 50) then gotl := gotl || '"Gold Wellbe Runner badge"'; end if;
    ups := ups || jsonb_build_array(jsonb_build_object('level', l, 'chest', chest, 'got', gotl));
  end loop;
  if coalesce((ev->>'lifeUsed')::numeric, 0) <> 0 and coalesce((v_up->>'life')::numeric, 0) > 0 then
    lu := least(app.jsround(coalesce(nullif((ev->>'lifeUsed')::numeric, 0), 1)), case when app.lv_has(v_owned, (app.lv_of(g.xp)->>'level')::int, 'life2') then 2 else 1 end);
    v_up := v_up || jsonb_build_object('life', greatest(0, (v_up->>'life')::numeric - lu));
  end if;
  g.coins := greatest(0, g.coins + earned - spent); g.earned_total := g.earned_total + earned;
  g.runs := g.runs + 1; g.total_m := g.total_m + m;
  rec := score > g.best_score; if rec then g.best_score := score; end if;
  g.best_m := greatest(g.best_m, m); g.day_best := greatest(g.day_best, score); g.week_best := greatest(g.week_best, score); g.last_run_at := now();
  if not v_badges ? 'first' then v_badges := v_badges || '"first"'; newb := newb || to_jsonb(rules->'badges'->>'first'); end if;
  if m >= 1000 and not v_badges ? 'km1' then v_badges := v_badges || '"km1"'; newb := newb || to_jsonb(rules->'badges'->>'km1'); end if;
  if m >= 5000 and not v_badges ? 'km5' then v_badges := v_badges || '"km5"'; newb := newb || to_jsonb(rules->'badges'->>'km5'); end if;
  if m >= 10000 and not v_badges ? 'km10' then v_badges := v_badges || '"km10"'; newb := newb || to_jsonb(rules->'badges'->>'km10'); end if;
  if g.runs >= 10 and not v_badges ? 'runs10' then v_badges := v_badges || '"runs10"'; newb := newb || to_jsonb(rules->'badges'->>'runs10'); end if;
  if g.runs >= 50 and not v_badges ? 'runs50' then v_badges := v_badges || '"runs50"'; newb := newb || to_jsonb(rules->'badges'->>'runs50'); end if;
  if g.runs >= 100 and not v_badges ? 'runs100' then v_badges := v_badges || '"runs100"'; newb := newb || to_jsonb(rules->'badges'->>'runs100'); end if;
  if g.earned_total >= 10000 and not v_badges ? 'rich' then v_badges := v_badges || '"rich"'; newb := newb || to_jsonb(rules->'badges'->>'rich'); end if;
  if boost and not v_badges ? 'boost' then v_badges := v_badges || '"boost"'; newb := newb || to_jsonb(rules->'badges'->>'boost'); end if;
  if p_lbhide is not null then v_owned := v_owned || jsonb_build_object('lbHide', p_lbhide); end if;
  update public.game_players set name = g.name, best_score = g.best_score, best_m = g.best_m, coins = g.coins, runs = g.runs, total_m = g.total_m,
    day_key = g.day_key, day_best = g.day_best, week_key = g.week_key, week_best = g.week_best, upgrades = v_up, missions = v_ms, badges = v_badges,
    last_run_at = g.last_run_at, earned_total = g.earned_total, credit_cents = g.credit_cents, credit_earned_cents = g.credit_earned_cents, xp = g.xp, owned = v_owned, updated_at = now()
   where client_id = p_client;
  -- rank v_badges only count once enough people are playing
  boards := app.boards(p_client); tot := boards->'lists'->'totals'; rk := boards->'rank';
  if (rk->>'day')::int = 1 and (tot->>'day')::int >= 3 and not v_badges ? 'day1' then v_badges := v_badges || '"day1"'; newb := newb || to_jsonb(rules->'badges'->>'day1'); end if;
  if (rk->>'week')::int = 1 and (tot->>'week')::int >= 5 and not v_badges ? 'week1' then v_badges := v_badges || '"week1"'; newb := newb || to_jsonb(rules->'badges'->>'week1'); end if;
  if (rk->>'week')::int between 1 and 10 and (tot->>'week')::int >= 12 and not v_badges ? 'week10' then v_badges := v_badges || '"week10"'; newb := newb || to_jsonb(rules->'badges'->>'week10'); end if;
  if (rk->>'all')::int between 1 and 3 and (tot->>'all')::int >= 10 and not v_badges ? 'all3' then v_badges := v_badges || '"all3"'; newb := newb || to_jsonb(rules->'badges'->>'all3'); end if;
  if (rk->>'all')::int = 1 and (tot->>'all')::int >= 10 and not v_badges ? 'all1' then v_badges := v_badges || '"all1"'; newb := newb || to_jsonb(rules->'badges'->>'all1'); end if;
  update public.game_players set badges = v_badges where client_id = p_client;
  insert into public.game_runs (client_id, secs, m, ran_m, coins, score, spent, earned, credit_cents, xp, ev) values (p_client, secs, m, ran, coins, score, spent, earned, ce, xpg, ev);
  insert into public.coin_ledger (client_id, delta, reason) values (p_client, earned - spent, 'Run');
  return jsonb_build_object('earned', earned, 'boosted', boost, 'cashEarned', ce, 'xpGain', xpg, 'levelUps', ups, 'record', rec, 'newBadges', newb, 'mdone', mdone,
    'coins', g.coins, 'best', g.best_score, 'bestM', g.best_m, 'runs', g.runs, 'cash', jsonb_build_object('bal', g.credit_cents, 'total', g.credit_earned_cents, 'today', coalesce((v_ms->>'cash')::int, 0)),
    'lv', app.lv_of(g.xp), 'boards', boards->'lists', 'rank', boards->'rank');
end $$;

-- every game call first brings the player row to today (RunGame.gs clRun_: missions of the day, day / week keys, lvMigrate_)
create or replace function app.game_touch(p_client uuid) returns void language plpgsql security definer set search_path = public as $$
declare today date := app_today(); wk date := date_trunc('week', app_today())::date;
begin
  insert into public.game_players (client_id, name) values (p_client, (select btrim(name) from public.clients where id = p_client)) on conflict do nothing;
  update public.game_players g set
    owned = case when coalesce((g.owned->>'_m')::int, 0) = 0
                 then g.owned || coalesce((select jsonb_object_agg(k, 1) from unnest(array['magnet', 'jet', 'shoes']) k where coalesce((g.upgrades->>k)::numeric, 0) > 0), '{}') || '{"_m":1}'
                 else g.owned end,
    missions = case when g.missions->>'d' = today::text then g.missions else jsonb_build_object('d', today, 'st', '{}'::jsonb, 'done', '[]'::jsonb, 'bonus', 0) end,
    day_best = case when g.day_key is distinct from today then 0 else g.day_best end, day_key = today,
    week_best = case when g.week_key is distinct from wk then 0 else g.week_best end, week_key = wk
   where g.client_id = p_client;
end $$;

-- op redeem: send Wellbe Credit to the desk (max REDEEM_MAX at a time, one at a time)
create or replace function public.game_redeem(p_client uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client); g public.game_players; cash jsonb := app.setting('{game,cash}'); pend int; amt int; rid uuid;
begin
  perform app.game_touch(p_client);
  select * into g from public.game_players where client_id = p_client for update;
  select coalesce(sum((data->>'cents')::int), 0) into pend from public.client_requests where client_id = p_client and type = 'Game cash' and status = 'New';
  if pend > 0 then raise exception 'You already have $% waiting for your next renewal.', to_char(pend / 100.0, 'FM990.00'); end if;
  amt := least(coalesce(g.credit_cents, 0), (cash->>'REDEEM_MAX')::int);
  if amt < (cash->>'REDEEM_MIN')::int then raise exception 'You need at least $% Wellbe Credit.', to_char((cash->>'REDEEM_MIN')::int / 100.0, 'FM990.00'); end if;
  update public.game_players set credit_cents = credit_cents - amt where client_id = p_client;
  rid := app.client_log(p_client, g.name, 'Game cash', g.name || ' used $' || to_char(amt / 100.0, 'FM990.00') || ' Wellbe Credit (Corniche Run): take it off their first or next package, or an online workout (max $20 at a time).', '', null, 'New', jsonb_build_object('cents', amt));
  insert into public.credit_ledger (client_id, delta_cents, reason, request_id) values (p_client, -amt, 'Sent to the desk', rid);
  return jsonb_build_object('redeemed', amt);
end $$;

-- op shop: buy with coins (Levels.gs lvBuy_); the Gold Wellbe Runner badge is never in the shop
create or replace function public.game_shop(p_client uuid, p_item text) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client); g public.game_players; s jsonb := app.setting(array['game', 'shop', p_item]);
begin
  if s is null then raise exception 'Not in the shop'; end if;
  perform app.game_touch(p_client);
  select * into g from public.game_players where client_id = p_client for update;
  if g.client_id is null then raise exception 'Not enough coins'; end if;
  if s->>'kind' = 'once' and app.lv_has(g.owned, (app.lv_of(g.xp)->>'level')::int, p_item) then raise exception 'You already have %', s->>'n'; end if;
  if g.coins < (s->>'coins')::int then raise exception 'Not enough coins'; end if;
  update public.game_players set coins = coins - (s->>'coins')::int, owned = owned || jsonb_build_object(p_item, coalesce((owned->>p_item)::numeric, 0) + 1) where client_id = p_client;
  insert into public.coin_ledger (client_id, delta, reason) values (p_client, -(s->>'coins')::int, 'Shop: ' || (s->>'n'));
  return jsonb_build_object('bought', s->>'n');
end $$;

-- ---------------------------------------------------------------------
-- STREAK: days in a row of all 3 keys = 1 free session (Streak.gs clStreak_)
-- ---------------------------------------------------------------------
create or replace function app.streak_count(days date[], today date, after date) returns int language plpgsql immutable as $$
declare d date := case when today = any(days) then today else today - 1 end; n int := 0;
begin
  while d = any(days) and (after is null or d > after) loop n := n + 1; d := d - 1; end loop;
  return n;
end $$;
create or replace function public.streak_tick(p_client uuid, p_keys boolean[] default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client); s public.streaks; today date := app_today(); v_keys boolean[]; all_k boolean; cnt int; goal int := app.setting_int('{streak,days}', 30);
  valid int := app.setting_int('{streak,validDays}', 90); cur public.packages; kind text; lid text; pid uuid; unlocked boolean := false; nm text;
begin
  insert into public.streaks (client_id) values (p_client) on conflict do nothing;
  select * into s from public.streaks where client_id = p_client for update;
  v_keys := case when s.keys_day = today then s.keys else array[false, false, false] end;
  if p_keys is not null then
    v_keys := array[coalesce(p_keys[1], false), coalesce(p_keys[2], false), coalesce(p_keys[3], false)];
    all_k := v_keys[1] and v_keys[2] and v_keys[3];
    if all_k and not today = any(s.done_days) then s.done_days := s.done_days || today; end if;
    if not all_k and today = any(s.done_days) then s.done_days := array_remove(s.done_days, today); end if;
    select coalesce(array_agg(d order by d), '{}') into s.done_days from (select d from unnest(s.done_days) d order by d desc limit 120) x;
    update public.streaks set done_days = s.done_days, keys_day = today, keys = v_keys where client_id = p_client;
  end if;
  cnt := app.streak_count(s.done_days, today, s.last_reward);
  if cnt >= goal then
    select p.* into cur from public.packages p where p.client_id = p_client and app.pkg_phase(p, today) = 'current' order by p.legacy_id limit 1;
    if cur.id is not null then
      -- same as Streak.gs: a 1:1 package earns a 1:1 reward, everything else a 1:3 reward
      kind := case when cur.kind = '1:1' then '1:1' else '1:3' end;
      select name into nm from public.clients where id = p_client;
      lid := app.next_legacy('PKG', 'public.packages', 4);
      insert into public.packages (legacy_id, client_id, type_name, kind, passes, used, price_cents, start_date, expiry_date, effective_expiry, status, note)
      values (lid, p_client, 'Streak Reward - ' || kind || ' (Free)', kind, 1, 0, 0, today, today + valid, today + valid, 'Active', goal || ' day promise streak reward (client app). Free, 1 session.')
      returning id into pid;
      perform app.client_log(p_client, nm, 'Streak reward', nm || ' kept their promise ' || goal || ' days in a row! Free ' || kind || ' session added (' || lid || '). Message them to book it.', '', pid, 'New', jsonb_build_object('pkg', lid));
      update public.streaks set last_reward = today, reward_pkg = pid, rewards = rewards + 1 where client_id = p_client;
      s.last_reward := today; cnt := 0; unlocked := true;
    end if;
  end if;
  return jsonb_build_object('keys', to_jsonb(v_keys), 'streak', app.streak_count(s.done_days, today, null), 'count', cnt, 'goal', goal,
    'reward', case when s.last_reward is not null then jsonb_build_object('date', s.last_reward) end, 'unlocked', unlocked);
end $$;

-- what the apps receive as d.cfg (Config.gs cfgPublic_): staff never get emails/phones except the owner, clients never get pay
create or replace function public.public_cfg() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c jsonb := app.caller(); v_role text := c->>'role'; client boolean := v_role in ('client', 'guest'); out jsonb := '{"v":1}';
begin
  if v_role = 'anon' then raise exception 'signin'; end if;
  select out || jsonb_object_agg(key, value) into out from public.settings where key not in ('trial', 'game_rules') and (not client or key not in ('pay', 'lists', 'insurance'));
  out := out || jsonb_build_object('staff', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'name', name, 'role', s.role, 'trainer', trainer,
      'cap', cap, 'train', case when train then true end, 'nameAr', name_ar,
      'pay', case when not client and (v_role in ('owner', 'assistant', 'system') or id = c->>'staff') then pay end,
      'email', case when v_role in ('owner', 'system') then coalesce(email, '') end, 'phone', case when v_role in ('owner', 'system') then coalesce(phone, '') end)) order by s.sort, s.id)
    from public.staff s where active));
  out := out || jsonb_build_object('types', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', name, 'passes', passes, 'price', price_cents / 100.0, 'kind', kind,
      'days', valid_days, 'months', valid_months, 'mel', case when mel then true end, 'trial', case when trial then true end, 'free', case when free then true end,
      'shop', case when shop then true end)) order by sort) from public.package_types where active));
  out := out #- '{center,tz}';
  if out #> '{services,1:3}' is not null and app.setting('{trial,trainer}') is not null then
    out := jsonb_set(out, '{services,1:3,trainer}', app.setting('{trial,trainer}'));
  end if;
  return out;
end $$;

grant execute on function public.sell_package, public.pay_package, public.book_session, public.mark_attendance, public.cancel_session, public.client_join,
  public.request_upgrade6, public.handle_request, public.notice_read, public.game_save_run, public.game_redeem, public.game_shop, public.streak_tick, public.public_cfg
  to authenticated;
revoke execute on function public.default_present() from authenticated;
grant select on public.lead_followups to authenticated;

-- ---------------------------------------------------------------------
-- who may call what. Postgres lets everyone run a new function by default: close that first,
-- then open only the API functions above and the small helpers the security rules use.
-- (The app schema is not exposed by the Supabase API either; this is the second lock.)
-- ---------------------------------------------------------------------
revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function app.setting(text[]), app.setting_int(text[], int), app.me(), app.my_role(), app.my_staff(), app.my_trainer(),
  app.is_owner(), app.is_desk(), app.is_staff(), app.my_clients(), app.is_mine(uuid), app.trainer_sees(uuid), app.can_see_client(uuid),
  app.staff_sees_client(uuid), app.in_my_session(uuid), app.my_trainer_session(uuid), app.staff_pay(text), app.lead_start(timestamptz) to authenticated;
grant execute on function public.app_today() to authenticated;
grant execute on function public.sell_package, public.pay_package, public.book_session, public.mark_attendance, public.cancel_session, public.client_join,
  public.request_upgrade6, public.handle_request, public.notice_read, public.game_save_run, public.game_redeem, public.game_shop, public.streak_tick, public.public_cfg
  to authenticated;
