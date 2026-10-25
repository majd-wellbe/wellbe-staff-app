-- =====================================================================
-- WELLBE on Supabase: 0009 align with the Apps Script + the two sync doors
-- Run order in the SQL editor: 0005, 0006, 0007, 0009, then 0008 LAST (0008 locks every api_ function behind the door).
-- All "create or replace": safe to run again.
--
-- Aligned with the Apps Script (same behaviour staff and clients see today):
--  1. Freeze from a client request (handle_request): the end date used is Effective first, then Extended, then the
--     original end, like Client.gs clFreezeApply_. The error text is the same: "... fix it in the sheet first".
--  2. Physio slot check when a request is made or moved (app.ops_physio_free): busy times of the physio's Google
--     Calendar now count, like Client.gs clSlots_ (the calendar is copied here every 10 minutes by Supabase.gs).
--  3. A sale made in the app (api_app_pos) now fills "to" in the column the staff boot reads, so the POS list shows
--     who bought it, like the POS SALES sheet column D.
-- Still different on purpose: exact money in texts ($323.4, not $323.40000000000003), Romy does not receive staff pay,
-- messages go through the outbox after the save, sheet row numbers are replaced by IDs.
--
-- Sync doors for the Apps Script (Supabase.gs), protected by a shared secret:
--   public.wb_sync_calendar(secret, rows)   rows = [{id, s, e, allDay}] (s/e in ms) for the next physioDays
--   public.wb_sync_brand(secret, items)     items = profBrand_() output
--   The secret lives in app.secrets ('sync_secret') and in Script Properties SB_SYNC_SECRET. Only its value is compared.
-- =====================================================================

-- 1. freeze from a client request
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
      cur_end := coalesce(cur.effective_expiry, cur.extended_expiry, cur.expiry_date);
      if cur_end is null then raise exception 'Package % has no end date: fix it in the sheet first', cur.legacy_id; end if;
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

-- 2. physio slot: the calendar counts
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
  if exists (select 1 from public.calendar_busy b where not b.all_day and b.start_at < a + interval '1 hour' and b.end_at > a) then return false; end if;   -- the physio's Google Calendar (synced by Supabase.gs)
  return true;
end $$;

-- 3. sale from the app: "to" where the boot reads it
create or replace function public.api_app_pos(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); qty numeric := coalesce(nullif(app.ops_num(p->'qty'), 0), 1); each numeric := coalesce(app.ops_num(p->'price'), 0);
  iv public.inventory; cost numeric; lid text;
begin
  select * into iv from public.inventory where item = p->>'product' for update;
  if iv.item is null then raise exception 'Product not found'; end if;
  cost := coalesce(iv.cost_cents, 0) / 100.0;
  lid := app.next_legacy('POSS', 'public.pos_sales', 4);
  insert into public.pos_sales (legacy_id, at, item, to_name, buyer, qty, amount_cents, cost_cents, profit_cents, status, note, by_who)
  values (lid, now(), iv.item, app.ops_clean(p->>'to', 80), app.ops_clean(p->>'to', 80), qty, round(each * qty * 100), round(cost * 100), round((each * qty - cost * qty) * 100), 'Paid', 'via app (' || (me->>'name') || ')', me->>'name');
  update public.inventory set sold = (select coalesce(sum(x.qty), 0) from public.pos_sales x where x.item = iv.item), stock = stock - qty::int where item = iv.item;
  return jsonb_build_object('id', lid);
end $$;
update public.pos_sales set to_name = buyer where coalesce(to_name, '') = '' and coalesce(buyer, '') <> '';

-- which server the apps use (Config.gs backend.use, read by core/wb-backend.js). 'apps' until the switch.
insert into public.settings (key, value) values ('backend', '{"use":"apps"}'::jsonb) on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- sync doors (Apps Script -> Supabase)
-- ---------------------------------------------------------------------
create schema if not exists app;
create table if not exists app.secrets (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table app.secrets enable row level security;
revoke all on app.secrets from public, anon, authenticated;

create or replace function app.sync_ok(p_secret text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(length(p_secret) >= 24 and exists (select 1 from app.secrets s where s.key = 'sync_secret' and length(s.value) >= 24
                  and sha256(convert_to(s.value, 'UTF8')) = sha256(convert_to(p_secret, 'UTF8'))), false) $$;
revoke execute on function app.sync_ok(text) from public, anon, authenticated;

-- the physio calendar: the whole window is replaced in one go (events moved or deleted in Google disappear here too)
create or replace function public.wb_sync_calendar(secret text, rows jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare n int; r jsonb;
begin
  if not app.sync_ok(secret) then raise exception 'not allowed'; end if;
  if jsonb_typeof(rows) <> 'array' then raise exception 'rows must be a list'; end if;
  if jsonb_array_length(rows) > 2000 then raise exception 'too many rows'; end if;
  delete from public.calendar_busy where calendar = 'physio';
  insert into public.calendar_busy (calendar, source_id, start_at, end_at, all_day, synced_at)
  select 'physio', left(coalesce(x->>'id', ''), 300) || '|' || (x->>'s'), to_timestamp((x->>'s')::numeric / 1000), to_timestamp((x->>'e')::numeric / 1000),
         coalesce((x->>'allDay')::boolean, false), now()
    from jsonb_array_elements(rows) x
   where (x->>'s') ~ '^\d{10,14}$' and (x->>'e') ~ '^\d{10,14}$' and (x->>'e')::numeric >= (x->>'s')::numeric
  on conflict (source_id) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- the Wellbe The Brand catalog: an empty list (shop not reachable) keeps the last good one
create or replace function public.wb_sync_brand(secret text, items jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not app.sync_ok(secret) then raise exception 'not allowed'; end if;
  if jsonb_typeof(items) <> 'array' then raise exception 'items must be a list'; end if;
  if jsonb_array_length(items) = 0 then return jsonb_build_object('ok', true, 'n', 0, 'kept', true); end if;
  if jsonb_array_length(items) > 100 then raise exception 'too many items'; end if;
  insert into public.brand_cache (key, items, fetched_at) values ('brand', items, now())
  on conflict (key) do update set items = excluded.items, fetched_at = excluded.fetched_at;
  return jsonb_build_object('ok', true, 'n', jsonb_array_length(items));
end $$;
revoke execute on function public.wb_sync_calendar(text, jsonb) from public;
revoke execute on function public.wb_sync_brand(text, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.wb_sync_calendar(text, jsonb) to anon, authenticated;
    grant execute on function public.wb_sync_brand(text, jsonb) to anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.wb_sync_calendar(text, jsonb) to service_role;
    grant execute on function public.wb_sync_brand(text, jsonb) to service_role;
  end if;
end $$;

-- the secret: run ONCE with your own value (the same text you put in Script Properties SB_SYNC_SECRET):
--   insert into app.secrets (key, value) values ('sync_secret', 'PASTE_THE_SAME_LONG_RANDOM_TEXT')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
