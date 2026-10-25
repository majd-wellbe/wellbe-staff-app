-- =====================================================================
-- WELLBE on Supabase: 0006 features (part B of the port)
-- Workouts (Workout.gs), nutrition (Nutrition.gs), landing page (Code.gs), guests (Guest.gs),
-- the game screen (RunGame.gs, Levels.gs), streak, promise + keys, profile, session editor (App.gs).
-- Every Apps Script action is public.api_<action>(p jsonb) -> jsonb with the same answer as before (without "ok"),
-- reached through public.wb_call (0008). Legacy IDs in and out. Ported 1:1; differences are listed in the port report.
-- =====================================================================
-- ---------------------------------------------------------------------
-- SCHEMA ADDITIONS (only additions, nothing renamed)
-- ---------------------------------------------------------------------
-- row order of the old tabs (several rows share one now(): the order decides "latest")
alter table public.wo_logs add column if not exists seq bigserial;
alter table public.wo_logs add column if not exists session_ref text;              -- session ID as typed (kept when it is not a known session)
alter table public.client_body add column if not exists seq bigserial;
alter table public.nutrition_weighins add column if not exists seq bigserial;
alter table public.wo_exercises add column if not exists seq bigserial;
alter table public.leads add column if not exists seq bigserial;
-- guest app: what the guest already asked for (APP GUESTS "Asked")
alter table public.clients add column if not exists guest_asked jsonb not null default '{}'::jsonb;
-- promise rewrites per client per day (Client.gs clGoalPre_: 6 a day, was the script cache)
create table if not exists public.goal_edits (
  client_id uuid not null references public.clients(id) on delete cascade, day date not null, n int not null default 0, primary key (client_id, day));
alter table public.goal_edits enable row level security;
drop policy if exists goal_edits_owner on public.goal_edits;
create policy goal_edits_owner on public.goal_edits for select using (app.is_owner());   -- written only by api_app_cl_goal; the owner can read it

-- ---------------------------------------------------------------------
-- SMALL HELPERS (JavaScript semantics the old code relied on)
-- ---------------------------------------------------------------------
create or replace function app.js_trim(t text) returns text language sql immutable as $$
  select btrim(coalesce(t, ''), E' \t\n\r\f' || chr(11) || chr(160) || chr(65279))
$$;
-- Number(v): null = NaN
create or replace function app.js_num(v jsonb) returns float8 language plpgsql immutable as $$
declare t text;
begin
  if v is null then return null; end if;
  case jsonb_typeof(v)
    when 'number' then return (v #>> '{}')::float8;
    when 'boolean' then return case when (v #>> '{}')::boolean then 1 else 0 end;
    when 'null' then return 0;
    when 'string' then
      t := app.js_trim(v #>> '{}');
      if t = '' then return 0; end if;
      if t ~ '^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$' then return t::float8; end if;
      return null;
    else return null;
  end case;
end $$;
-- Number(v) || 0
create or replace function app.n0(v jsonb) returns float8 language sql immutable as $$ select coalesce(app.js_num(v), 0) $$;
-- !!v
create or replace function app.truthy(v jsonb) returns boolean language sql immutable as $$
  select case when v is null then false else case jsonb_typeof(v)
    when 'null' then false when 'boolean' then (v #>> '{}')::boolean when 'number' then (v #>> '{}')::float8 <> 0
    when 'string' then (v #>> '{}') <> '' else true end end
$$;
-- Math.round
create or replace function app.jr(x float8) returns float8 language sql immutable as $$ select floor(x + 0.5) $$;
-- an array, or [] for anything else
create or replace function app.arr(v jsonb) returns jsonb language sql immutable as $$ select case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end $$;
-- clean_(): one line, trimmed, cut; a leading = + - @ kept as text (the sheet stored one character less)
create or replace function app.clean(v jsonb, n int) returns text language sql immutable as $$
  select case when s ~ '^[=+\-@]' then left(s, n - 1) else left(s, n) end
    from (select app.js_trim(regexp_replace(case when v is null or jsonb_typeof(v) = 'null' then '' when jsonb_typeof(v) = 'string' then v #>> '{}' else v::text end, '[\r\n]+', ' ', 'g')) as s) x
$$;
-- clean_() for text kept inside JSON (answers): the ' before = + - @ stays, like the sheet JSON cell
create or replace function app.clean_json(v jsonb, n int) returns text language sql immutable as $$
  select left(case when s ~ '^[=+\-@]' then '''' || s else s end, n)
    from (select app.js_trim(regexp_replace(case when v is null or jsonb_typeof(v) = 'null' then '' when jsonb_typeof(v) = 'string' then v #>> '{}' else v::text end, '[\r\n]+', ' ', 'g')) as s) x
$$;
-- phone as the import stores it: digits, country code first (import.js phone())
create or replace function app.phone_norm(t text) returns text language plpgsql immutable as $$
declare d text := regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''), '[^\d+]', '', 'g'), '^\+', ''), '^00', ''); cc text := '961';
begin
  if d = '' then return null; end if;
  if d ~ '^0\d{6,8}$' then d := cc || substr(d, 2); elsif d ~ '^[1-9]\d{6,7}$' then d := cc || d; end if;
  return d;
end $$;
-- 'dd/MM/yyyy HH:mm' Beirut, like the sheets
create or replace function app.stamp(t timestamptz) returns text language sql stable as $$
  select case when t is null then '' else to_char(t at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'), 'DD/MM/YYYY HH24:MI') end
$$;
create or replace function app.client_by_legacy(x text) returns uuid language sql stable security definer set search_path = public as $$
  select id from public.clients where legacy_id = upper(app.js_trim(x)) limit 1
$$;
create or replace function app.legacy(cid uuid) returns text language sql stable security definer set search_path = public as $$
  select legacy_id from public.clients where id = cid
$$;
-- WhatsApp to the owner(s) and the desk + email to the owner(s), sent after commit (Code.gs alert_)
create or replace function app.alert_all(msg text) returns void language sql security definer set search_path = public as $$
  insert into public.outbox (channel, to_staff, body)
  select 'whatsapp', id, msg from public.staff where active and role = 'owner'
  union all select 'whatsapp', app.desk_id(), msg where app.desk_id() <> '' and app.desk_id() not in (select id from public.staff where active and role = 'owner')
  union all select 'email', id, msg from public.staff where active and role = 'owner'
$$;

-- ---------------------------------------------------------------------
-- WORKOUTS (Workout.gs)
-- ---------------------------------------------------------------------
-- client name the way the workout screens show it (CLIENTS names; guests and unknown IDs show the ID)
create or replace function app.wo_name(cid text) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select btrim(name) from public.clients where legacy_id = cid and cid ~ '^C\d+$'), cid)
$$;
-- training sessions of one client between two days: [{sid, date, start, trainer, att, status, choice}] in time order
create or replace function app.wo_sess(p_client uuid, d1 date, d2 date) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('sid', s.legacy_id, 'date', s.day, 'start', to_char(s.start_time, 'HH24:MI'), 'trainer', s.trainer, 'att', sc.att,
      'status', s.status, 'choice', coalesce((select d.choice from public.wo_decisions d where d.session_id = s.id and d.client_id = p_client), ''))
      order by s.day, s.start_time, s.legacy_id), '[]'::jsonb)
    from public.session_clients sc join public.sessions s on s.id = sc.session_id
   where sc.client_id = p_client and s.kind in ('1:1', '1:2', '1:3') and s.day between d1 and d2
$$;
-- trainers see clients they trained in the last trainerSee days or have booked; everybody else sees all (woCanSee_)
create or replace function app.wo_can_see(me jsonb, list jsonb, today date) returns boolean language sql stable as $$
  select me->>'role' <> 'trainer' or exists (select 1 from jsonb_array_elements(list) s
    where s->>'trainer' = me->>'trainer' and (s->>'date')::date >= today - app.setting_int('{windows,trainerSee}', 60) and s->>'status' <> 'Cancelled')
$$;
create or replace function app.wo_mine(me jsonb, cu uuid) returns void language plpgsql stable as $$
declare today date := app_today();
begin
  if me->>'role' = 'trainer' and not app.wo_can_see(me, case when cu is null then '[]'::jsonb
      else app.wo_sess(cu, today - app.setting_int('{windows,trainerSee}', 60), today + app.setting_int('{windows,ahead}', 35)) end, today) then
    raise exception 'This client is not one of yours';
  end if;
end $$;
create or replace function app.wo_add_len(d date, n float8, u text) returns date language sql immutable as $$
  select case u when 'm' then app.add_months_js(d, trunc(n)::int) when 'w' then d + trunc(n * 7)::int else d + trunc(n)::int end
$$;
create or replace function app.wo_phases(prog jsonb) returns jsonb language plpgsql stable as $$
declare s date; out jsonb := '[]'; p jsonb; i int := 0; e date;
begin
  s := case when prog->>'start' ~ '^\d{4}-\d{2}-\d{2}$' then (prog->>'start')::date end;
  for p in select x from jsonb_array_elements(app.arr(prog->'phases')) with ordinality t(x, o) order by o loop
    e := app.wo_add_len(s, greatest(1, coalesce(nullif(app.js_num(p->'len'), 0), 1)), p->>'unit');
    out := out || jsonb_build_array(jsonb_build_object('i', i, 'name', coalesce(nullif(p->>'name', ''), 'Phase ' || (i + 1)), 'start', s, 'end', e - 1,
      'len', p->'len', 'unit', p->'unit', 'workouts', app.arr(p->'workouts')));
    s := e; i := i + 1;
  end loop;
  return out;
end $$;
create or replace function app.wo_wname(ph jsonb, w int) returns text language sql immutable as $$
  select coalesce(nullif(ph->'workouts'->w->>'name', ''), 'Workout ' || (w + 1))
$$;
-- replays the sessions since the program started (woPlan_): workouts in order, misses kept, catch-up questions
create or replace function app.wo_plan(prog jsonb, list jsonb, today date) returns jsonb language plpgsql stable as $$
declare ph jsonb := app.wo_phases(prog); cur int := -1; ptr int := 0; miss jsonb := null; items jsonb := '[]'; asks jsonb := '[]';
  s jsonb; pi int; k int; n int; missed boolean; choice text; w int; catchup boolean; st text; att text; d date;
begin
  for s in select x from jsonb_array_elements(list) with ordinality t(x, o) order by o loop
    att := coalesce(s->>'att', ''); d := (s->>'date')::date;
    continue when s->>'status' = 'Cancelled' or att ~* 'early';
    pi := -1;
    for k in 0 .. jsonb_array_length(ph) - 1 loop
      if d >= (ph->k->>'start')::date and d <= (ph->k->>'end')::date then pi := k; exit; end if;
    end loop;
    continue when pi < 0;
    if pi <> cur then cur := pi; ptr := 0; miss := null; end if;
    n := jsonb_array_length(ph->pi->'workouts');
    continue when n = 0;
    missed := att ~* 'late cancel|no show'; choice := coalesce(s->>'choice', ''); catchup := false;
    if miss is not null and not missed and choice = 'catch' then
      w := (miss->>'w')::int; catchup := true; miss := null;
    else
      if miss is not null and not missed and choice = '' and d >= today and att = '' then
        asks := asks || jsonb_build_array(jsonb_build_object('sid', s->'sid', 'date', s->'date', 'start', s->'start',
          'missed', jsonb_build_object('w', (miss->>'w')::int, 'name', app.wo_wname(ph->pi, (miss->>'w')::int), 'date', miss->'date'),
          'now', jsonb_build_object('w', ptr % n, 'name', app.wo_wname(ph->pi, ptr % n))));
      end if;
      if not missed then miss := null; end if;
      w := ptr % n; ptr := ptr + 1;
    end if;
    if missed then miss := jsonb_build_object('w', w, 'date', s->'date'); end if;
    st := case when missed then 'missed' when att <> '' or d < today then 'done' when d = today then 'today' else 'planned' end;
    items := items || jsonb_build_array(jsonb_build_object('sid', s->'sid', 'date', s->'date', 'start', s->'start', 'trainer', s->'trainer', 'phase', pi, 'w', w,
      'name', app.wo_wname(ph->pi, w), 'state', st, 'catchUp', catchup));
  end loop;
  return jsonb_build_object('phases', ph, 'items', items, 'asks', asks);
end $$;
create or replace function app.wo_cur_phase(ph jsonb, today date) returns int language plpgsql immutable as $$
declare i int;
begin
  for i in 0 .. jsonb_array_length(ph) - 1 loop
    if today >= (ph->i->>'start')::date and today <= (ph->i->>'end')::date then return i; end if;
  end loop;
  if jsonb_array_length(ph) > 0 and today < (ph->0->>'start')::date then return 0; end if;
  return -1;
end $$;
-- sets [{kg, reps}] -> '60x10, 62.5x8' (old rows that could not be read keep their text)
create or replace function app.wo_sets_text(s jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(case when x ? 'kg' then app.jsnum((x->>'kg')::numeric) || 'x' || app.jsnum((x->>'reps')::numeric) else coalesce(x->>'raw', '') end, ', ' order by o), '')
    from jsonb_array_elements(app.arr(s)) with ordinality t(x, o)
$$;
-- woSets_: max 10 sets, kg to 0.25 (0..500), reps 0..200, empty sets dropped
create or replace function app.wo_sets(s jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('kg', kg, 'reps', reps) order by o), '[]'::jsonb) from (
    select o, greatest(0, least(500, app.jr(app.n0(x->'kg') * 4) / 4)) + 0 as kg, greatest(0, least(200, app.jr(app.n0(x->'reps')))) + 0 as reps
      from jsonb_array_elements(app.arr(s)) with ordinality t(x, o) where o <= 10) z
   where not (kg = 0 and reps = 0)
$$;
create or replace function app.wo_top(s text) returns float8 language sql immutable as $$
  select greatest(0, coalesce(max(substring(app.js_trim(p) from '^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?')::float8), 0))
    from unnest(string_to_array(s, ',')) p
$$;
-- one client's logs: newest day first, one entry per session + exercise (woLogsAll_)
create or replace function app.wo_logs_of(p_client uuid) returns jsonb language sql stable security definer set search_path = public as $$
  with l as (select l.*, coalesce(s.legacy_id, l.session_ref, '') as sid from public.wo_logs l left join public.sessions s on s.id = l.session_id where l.client_id = p_client),
       d as (select distinct on (sid, exercise) * from l order by sid, exercise, seq desc)
  select coalesce(jsonb_agg(jsonb_build_object('date', day, 'sid', sid, 'w', coalesce(workout, ''), 'ex', exercise, 'sets', app.wo_sets_text(sets), 'by', coalesce(by_who, ''))
      order by day desc, seq), '[]'::jsonb) from d
$$;
-- { exercise: { last, date, history: [{date, sets, top}] } } (woLogMap_)
create or replace function app.wo_log_map(logs jsonb) returns jsonb language plpgsql immutable as $$
declare m jsonb := '{}'; l jsonb; x jsonb; ex text;
begin
  for l in select e from jsonb_array_elements(logs) with ordinality t(e, o) order by o loop
    continue when coalesce(l->>'sets', '') = '';
    ex := l->>'ex'; x := m->ex;
    if x is null then x := jsonb_build_object('last', l->'sets', 'date', l->'date', 'history', '[]'::jsonb); end if;
    if jsonb_array_length(x->'history') < 12 then
      x := jsonb_set(x, '{history}', (x->'history') || jsonb_build_array(jsonb_build_object('date', l->'date', 'sets', l->'sets', 'top', app.wo_top(l->>'sets'))));
    end if;
    m := m || jsonb_build_object(ex, x);
  end loop;
  return m;
end $$;
-- latest body numbers + weight history (woBodies_)
create or replace function app.wo_body(p_client uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b jsonb := jsonb_build_object('weight', 0, 'height', 0, 'birth', 0, 'sex', '', 'date', '', 'history', '[]'::jsonb); r record; h jsonb := '[]';
begin
  for r in select * from public.client_body where client_id = p_client order by seq loop
    if coalesce(r.weight_kg, 0) <> 0 then
      b := b || jsonb_build_object('weight', r.weight_kg::float8, 'date', r.day);
      h := h || jsonb_build_array(jsonb_build_object('date', r.day, 'kg', r.weight_kg::float8));
    end if;
    if coalesce(r.height_cm, 0) <> 0 then b := b || jsonb_build_object('height', r.height_cm::float8); end if;
    if coalesce(r.birth_year, 0) <> 0 then b := b || jsonb_build_object('birth', r.birth_year); end if;
    if coalesce(r.sex, '') <> '' then b := b || jsonb_build_object('sex', r.sex); end if;
  end loop;
  select coalesce(jsonb_agg(e order by o), '[]') into h from jsonb_array_elements(h) with ordinality t(e, o) where o > jsonb_array_length(h) - 20;
  return b || jsonb_build_object('history', h);
end $$;
-- Mifflin St Jeor x activity from sessions per week (woBmr_)
create or replace function app.wo_bmr(b jsonb, per_week float8) returns jsonb language plpgsql stable as $$
declare age int; bmr float8; f float8; w float8 := (b->>'weight')::float8; h float8 := (b->>'height')::float8; y int := (b->>'birth')::int;
begin
  if coalesce(w, 0) = 0 or coalesce(h, 0) = 0 or coalesce(y, 0) = 0 or coalesce(b->>'sex', '') = '' then return null; end if;
  age := extract(year from app_today())::int - y;
  bmr := app.jr(10 * w + 6.25 * h - 5 * age + case when b->>'sex' = 'M' then 5 else -161 end);
  f := case when per_week >= 5 then 1.55 when per_week >= 2 then 1.465 when per_week >= 1 then 1.375 else 1.2 end;
  return jsonb_build_object('bmr', bmr, 'daily', app.jr(bmr * f), 'perWeek', app.jr(per_week * 10) / 10, 'age', age);
end $$;
create or replace function app.wo_per_week(list jsonb, today date) returns float8 language sql stable as $$
  select count(*)::float8 / 4 from jsonb_array_elements(list) s
   where (s->>'date')::date between today - 28 and today and coalesce(nullif(s->>'att', ''), 'present') ~* 'present|done'
     and s->>'status' <> 'Cancelled' and coalesce(s->>'att', '') !~* 'cancel|no show'
$$;
-- library + exercises the trainers added (woLib_)
create or replace function app.wo_lib() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare lib jsonb := app.wo_lib_base(); r record; g text; e text;
begin
  for r in select group_name, exercise from public.wo_exercises order by seq loop
    g := app.js_trim(r.group_name); e := app.js_trim(r.exercise);
    continue when g = '' or e = '';
    if not coalesce(lib->g, '[]'::jsonb) ? e then lib := lib || jsonb_build_object(g, coalesce(lib->g, '[]'::jsonb) || to_jsonb(e)); end if;
  end loop;
  return lib;
end $$;
-- one client's program page (woDetail_)
create or replace function app.wo_detail(cid text, prow public.wo_programs, list jsonb, plan jsonb, today date) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb; cu uuid := app.client_by_legacy(cid); body jsonb;
begin
  out := jsonb_build_object('cid', cid, 'name', app.wo_name(cid), 'today', today, 'prog', prow.program, 'ver', coalesce(prow.version, 0),
    'by', case when prow.client_id is null then '' else coalesce(prow.updated_by, '') end, 'updated', app.stamp(prow.updated_at));
  if plan is not null then
    out := out || jsonb_build_object(
      'phases', (select coalesce(jsonb_agg(jsonb_build_object('name', x->'name', 'start', x->'start', 'end', x->'end') order by o), '[]') from jsonb_array_elements(plan->'phases') with ordinality t(x, o)),
      'items', (select coalesce(jsonb_agg(x order by o), '[]') from jsonb_array_elements(plan->'items') with ordinality t(x, o) where (x->>'date')::date >= today - 30),
      'asks', plan->'asks');
  end if;
  body := app.wo_body(cu);
  return out || jsonb_build_object('body', body, 'bmr', app.wo_bmr(body, app.wo_per_week(list, today)), 'logs', app.wo_log_map(app.wo_logs_of(cu)));
end $$;
-- woClean_: only known fields, sane sizes
create or replace function app.wo_t(v jsonb, n int) returns text language sql immutable as $$
  select left(app.js_trim(regexp_replace(case when v is null or jsonb_typeof(v) = 'null' then '' when jsonb_typeof(v) = 'string' then v #>> '{}' else v::text end, '[\r\n]+', ' ', 'g')), n)
$$;
create or replace function app.wo_mv(m jsonb, sets boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object('ex', app.wo_t(m->'ex', 80), 'reps', app.wo_t(m->'reps', 30), 'det', app.wo_t(m->'det', 200))
      || case when sets then jsonb_build_object('sets', app.wo_t(m->'sets', 10)) else '{}'::jsonb end
$$;
create or replace function app.wo_clean(p jsonb) returns jsonb language plpgsql immutable as $$
declare phases jsonb := '[]'; ph jsonb; i int := 0; unit text; len float8; mx int; wos jsonb; wk jsonb; j int; main jsonb; b jsonb; typ text; moves jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p->>'start', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Pick the start date of the program'; end if;
  for ph in select x from jsonb_array_elements(app.arr(p->'phases')) with ordinality t(x, o) where o <= 20 order by o loop
    unit := case when jsonb_typeof(ph->'unit') = 'string' and ph->>'unit' in ('d', 'w', 'm') then ph->>'unit' else 'w' end;
    len := greatest(1, least(case unit when 'm' then 24 when 'w' then 104 else 365 end, app.jr(coalesce(nullif(app.js_num(ph->'len'), 0), 1))));
    wos := '[]'; j := 0;
    for wk in select x from jsonb_array_elements(app.arr(ph->'workouts')) with ordinality t(x, o) where o <= 10 order by o loop
      main := '[]';
      for b in select x from jsonb_array_elements(app.arr(wk->'main')) with ordinality t(x, o) where o <= 30 order by o loop
        typ := case when jsonb_typeof(b->'type') = 'string' and b->>'type' in ('single', 'superset', 'circuit') then b->>'type' else 'single' end;
        mx := case typ when 'single' then 1 when 'superset' then 3 else 10 end;
        select coalesce(jsonb_agg(app.wo_mv(m, true) order by o), '[]') into moves
          from jsonb_array_elements(app.arr(b->'moves')) with ordinality t(m, o) where o <= mx and app.wo_t(m->'ex', 80) <> '';
        if jsonb_array_length(moves) > 0 then
          main := main || jsonb_build_array(jsonb_build_object('type', typ, 'rounds', app.wo_t(b->'rounds', 10), 'rest', app.wo_t(b->'rest', 20), 'moves', moves));
        end if;
      end loop;
      wos := wos || jsonb_build_array(jsonb_build_object('name', coalesce(nullif(app.wo_t(wk->'name', 60), ''), 'Workout ' || (j + 1)),
        'warm', (select coalesce(jsonb_agg(app.wo_mv(m, false) order by o), '[]') from jsonb_array_elements(app.arr(wk->'warm')) with ordinality t(m, o) where o <= 30 and app.wo_t(m->'ex', 80) <> ''),
        'main', main,
        'abs', (select coalesce(jsonb_agg(app.wo_mv(m, true) order by o), '[]') from jsonb_array_elements(app.arr(wk->'abs')) with ordinality t(m, o) where o <= 20 and app.wo_t(m->'ex', 80) <> ''),
        'stretch', (select coalesce(jsonb_agg(jsonb_build_object('ex', app.wo_t(m->'ex', 80), 'det', app.wo_t(m->'det', 200)) order by o), '[]')
                      from jsonb_array_elements(app.arr(wk->'stretch')) with ordinality t(m, o) where o <= 20 and app.wo_t(m->'ex', 80) <> '')));
      j := j + 1;
    end loop;
    phases := phases || jsonb_build_array(jsonb_build_object('name', coalesce(nullif(app.wo_t(ph->'name', 60), ''), 'Phase ' || (i + 1)), 'len', len::int, 'unit', unit,
      'note', app.wo_t(ph->'note', 200), 'workouts', wos));
    i := i + 1;
  end loop;
  if jsonb_array_length(phases) = 0 then raise exception 'Add at least one phase'; end if;
  return jsonb_build_object('start', p->>'start', 'goal', app.wo_t(p->'goal', 200), 'phases', phases);
end $$;
-- WORKOUT LOG rows (woWriteLogs_): max 40, empty exercise names skipped
create or replace function app.wo_write_logs(p_client uuid, p_sid text, p_day date, p_wname text, p_entries jsonb, p_by text) returns int language plpgsql security definer set search_path = public as $$
declare e jsonb; ex text; n int := 0; sess uuid;
begin
  select id into sess from public.sessions where legacy_id = p_sid;
  for e in select x from jsonb_array_elements(app.arr(p_entries)) with ordinality t(x, o) where o <= 40 order by o loop
    ex := app.clean(e->'ex', 80);
    continue when ex = '';
    insert into public.wo_logs (day, client_id, session_id, session_ref, workout, exercise, sets, by_who) values (p_day, p_client, sess, p_sid, p_wname, ex, app.wo_sets(e->'sets'), p_by);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Nothing to save'; end if;
  return n;
end $$;

-- action app_wo_list { full? }: my clients, who has a program, who needs an answer (woList_)
create or replace function public.api_app_wo_list(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); today date := app_today(); see int := app.setting_int('{windows,trainerSee}', 60);
  ahead int := app.setting_int('{windows,ahead}', 35); f date; c record; list jsonb; prow public.wo_programs; plan jsonb; ci int; rw jsonb; nx jsonb;
  rlist jsonb := '[]'; fullm jsonb := null; ph jsonb; lastend date; cid text;
begin
  f := today - see;
  select least(f, coalesce(min((program->>'start')::date) filter (where program->>'start' ~ '^\d{4}-\d{2}-\d{2}$'), f)) into f from public.wo_programs;
  f := greatest(f, today - 400);
  if app.truthy(p->'full') then fullm := '{}'; end if;
  for c in select x.id from (select sc.client_id as id from public.session_clients sc join public.sessions s on s.id = sc.session_id
                               where s.kind in ('1:1', '1:2', '1:3') and s.day between f and today + ahead
                             union select client_id from public.wo_programs) x loop
    list := app.wo_sess(c.id, f, today + ahead);
    continue when not app.wo_can_see(me, list, today);
    prow := null; select * into prow from public.wo_programs where client_id = c.id;
    continue when prow.client_id is null and not exists (select 1 from jsonb_array_elements(list) s where (s->>'date')::date >= today - see);
    cid := app.legacy(c.id);
    rw := jsonb_build_object('cid', cid, 'name', app.wo_name(cid), 'has', prow.client_id is not null, 'asks', 0, 'next', null, 'phase', '');
    plan := null;
    if prow.client_id is not null then
      plan := app.wo_plan(prow.program, list, today); ph := plan->'phases'; ci := app.wo_cur_phase(ph, today);
      lastend := (ph->(jsonb_array_length(ph) - 1)->>'end')::date;
      rw := rw || jsonb_build_object('asks', jsonb_array_length(plan->'asks'),
        'phase', case when ci > -1 then ph->ci->>'name' when today > lastend then 'Program ended' else '' end, 'ended', ci < 0 and coalesce(today > lastend, false));
      nx := null;
      select x into nx from jsonb_array_elements(plan->'items') with ordinality t(x, o) where (x->>'date')::date >= today and x->>'state' in ('today', 'planned') order by o limit 1;
      if nx is not null then rw := rw || jsonb_build_object('next', jsonb_build_object('date', nx->'date', 'start', nx->'start', 'name', nx->'name')); end if;
      rw := rw || jsonb_build_object('by', coalesce(prow.updated_by, ''), 'updated', app.stamp(prow.updated_at));
    end if;
    if fullm is not null then fullm := fullm || jsonb_build_object(cid, app.wo_detail(cid, prow, list, plan, today)); end if;
    rw := rw || jsonb_build_object('trainers', (select coalesce(jsonb_agg(t order by o), '[]') from (
      select s->>'trainer' as t, min(o) as o from jsonb_array_elements(list) with ordinality x(s, o)
       where (s->>'date')::date >= today - see and coalesce(s->>'trainer', '') <> '' group by 1) z));
    rlist := rlist || jsonb_build_array(rw);
  end loop;
  select coalesce(jsonb_agg(r order by (r->>'asks')::int desc, (r->>'has')::boolean, r->>'name' collate "C"), '[]') into rlist from jsonb_array_elements(rlist) r;
  return jsonb_build_object('clients', rlist, 'lib', app.wo_lib(), 'today', today, 'full', fullm);
end $$;

-- action app_wo_get { cid, copy? } (woGet_)
create or replace function public.api_app_wo_get(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); today date := app_today(); see int := app.setting_int('{windows,trainerSee}', 60);
  cid text := upper(coalesce(p->>'cid', '')); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); prow public.wo_programs; f date; list jsonb; plan jsonb;
begin
  if cu is not null then select * into prow from public.wo_programs where client_id = cu; end if;
  f := case when prow.client_id is not null and prow.program->>'start' < (today - see)::text then (prow.program->>'start')::date else today - see end;
  list := case when cu is null then '[]'::jsonb else app.wo_sess(cu, f, today + app.setting_int('{windows,ahead}', 35)) end;
  if not app.wo_can_see(me, list, today) then raise exception 'This client is not one of yours'; end if;
  if app.truthy(p->'copy') then
    return jsonb_build_object('cid', cid, 'name', app.wo_name(cid), 'today', today, 'prog', prow.program, 'ver', coalesce(prow.version, 0),
      'by', case when prow.client_id is null then '' else coalesce(prow.updated_by, '') end, 'updated', app.stamp(prow.updated_at));
  end if;
  if prow.client_id is not null then plan := app.wo_plan(prow.program, list, today); end if;
  return app.wo_detail(cid, prow, list, plan, today);
end $$;

-- action app_wo_save { cid, ver, prog | remove } (woSave_)
create or replace function public.api_app_wo_save(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cid text := upper(coalesce(p->>'cid', '')); cu uuid; prow public.wo_programs; v float8; prog jsonb; nv int;
begin
  if cid !~ '^C\d+$' then raise exception 'Client missing'; end if;
  cu := app.client_by_legacy(cid);
  if cu is null then raise exception 'Client missing'; end if;
  perform app.wo_mine(me, cu);
  select * into prow from public.wo_programs where client_id = cu for update;
  v := case when app.truthy(p->'ver') then app.js_num(p->'ver') else 0 end;
  if prow.client_id is not null and (v is null or v <> prow.version) then
    raise exception '% changed this program at %. Reload it, then make your change again.', coalesce(nullif(prow.updated_by, ''), 'Someone'), app.stamp(prow.updated_at);
  end if;
  if app.truthy(p->'remove') then delete from public.wo_programs where client_id = cu; return jsonb_build_object('ver', 0); end if;
  prog := app.wo_clean(p->'prog');
  if length(prog::text) > 48000 then raise exception 'This program is too long. Split it, or remove some notes.'; end if;
  nv := coalesce(prow.version, 0) + 1;
  insert into public.wo_programs (client_id, program, version, updated_by, updated_at) values (cu, prog, nv, me->>'name', now())
  on conflict (client_id) do update set program = excluded.program, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return jsonb_build_object('ver', nv, 'prog', prog);
end $$;

-- action app_wo_decide { cid, sid, choice, missed } (woDecide_): after a miss, catch = do the missed workout now, keep = plan stays
create or replace function public.api_app_wo_decide(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', '')));
  choice text := case when p->>'choice' = 'catch' then 'catch' else 'keep' end; sid uuid;
begin
  if not app.truthy(p->'sid') then raise exception 'Session missing'; end if;
  perform app.wo_mine(me, cu);
  if cu is null then raise exception 'Client missing'; end if;
  select id into sid from public.sessions where legacy_id = p->>'sid';
  if sid is null then raise exception 'Session % not found, refresh', p->>'sid'; end if;
  insert into public.wo_decisions (session_id, client_id, choice, missed_workout, decided_by, decided_at) values (sid, cu, choice, app.clean(p->'missed', 60), me->>'name', now())
  on conflict (session_id, client_id) do update set choice = excluded.choice, missed_workout = excluded.missed_workout, decided_by = excluded.decided_by, decided_at = excluded.decided_at;
  return jsonb_build_object('choice', choice);
end $$;

-- action app_wo_log { cid, sid, date, wname, entries:[{ex, sets:[{kg, reps}]}] } (woLog_)
create or replace function public.api_app_wo_log(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); n int;
begin
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Date missing'; end if;
  perform app.wo_mine(me, cu);
  if cu is null then raise exception 'Client missing'; end if;
  n := app.wo_write_logs(cu, app.clean(p->'sid', 20), (p->>'date')::date, app.clean(p->'wname', 60), p->'entries', coalesce(nullif(me->>'trainer', ''), me->>'name'));
  return jsonb_build_object('saved', n, 'logs', app.wo_log_map(app.wo_logs_of(cu)));
end $$;

-- action app_wo_ex { group, name }: a new exercise in the shared library (woEx_)
create or replace function public.api_app_wo_ex(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); g text := app.clean(p->'group', 40); e text := app.clean(p->'name', 80); lib jsonb;
begin
  if g = '' or e = '' then raise exception 'Group and exercise name needed'; end if;
  lib := app.wo_lib();
  if exists (select 1 from jsonb_array_elements_text(app.arr(lib->g)) x where lower(x) = lower(e)) then return jsonb_build_object('lib', lib); end if;
  insert into public.wo_exercises (group_name, exercise, added_by, day) values (g, e, me->>'name', app_today()) on conflict do nothing;
  return jsonb_build_object('lib', app.wo_lib());
end $$;

-- action app_cl_wo { cid, op: get | log {sid, entries} | body {weight, height, birth, sex} } (clWo_)
create or replace function public.api_app_cl_wo(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cid text := upper(coalesce(p->>'cid', '')); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; today date := app_today();
  op text := coalesce(nullif(p->>'op', ''), 'get'); w float8; h float8; y float8; sx text; yr int; prow public.wo_programs; f date; list jsonb; body jsonb; out jsonb;
  plan jsonb; ph jsonb; cur jsonb; it jsonb; ci int; logs jsonb; logged jsonb; lastend date; days int := 7;
begin
  me := app.need_client(cu);
  if (select kind from public.clients where id = cu) = 'guest' then raise exception 'unknown action'; end if;
  if op = 'body' then
    w := app.n0(p->'weight'); h := app.n0(p->'height'); y := app.n0(p->'birth'); sx := case when p->>'sex' in ('M', 'F') then p->>'sex' else '' end; yr := extract(year from today)::int;
    if w <> 0 and (w < 25 or w > 300) then raise exception 'Check your weight (kg)'; end if;
    if h <> 0 and (h < 100 or h > 230) then raise exception 'Check your height (cm)'; end if;
    if y <> 0 and (y < 1920 or y > yr - 10) then raise exception 'Check your birth year'; end if;
    if w = 0 and h = 0 and y = 0 and sx = '' then raise exception 'Nothing to save'; end if;
    insert into public.client_body (day, client_id, weight_kg, height_cm, birth_year, sex, by_who) values (today, cu, nullif(w, 0), nullif(h, 0), nullif(y, 0)::int, nullif(sx, ''), 'client app');
  end if;
  select * into prow from public.wo_programs where client_id = cu;
  f := case when prow.client_id is not null and prow.program->>'start' ~ '^\d{4}-\d{2}-\d{2}$' then (prow.program->>'start')::date else today - 30 end;
  if f > today - 30 then f := today - 30; end if;
  list := app.wo_sess(cu, f, today + app.setting_int('{windows,ahead}', 35));
  body := app.wo_body(cu);
  out := jsonb_build_object('today', today, 'body', body, 'bmr', app.wo_bmr(body, app.wo_per_week(list, today)));
  if prow.client_id is null then
    if op = 'log' then return out || '{"has":false}'; end if;
    return out || '{"has":false}';
  end if;
  plan := app.wo_plan(prow.program, list, today); ph := plan->'phases';
  select x into cur from jsonb_array_elements(plan->'items') with ordinality t(x, o) where (x->>'date')::date = today and x->>'state' <> 'missed' order by o limit 1;
  if cur is null then select x into cur from jsonb_array_elements(plan->'items') with ordinality t(x, o) where (x->>'date')::date > today and x->>'state' = 'planned' order by o limit 1; end if;
  if op = 'log' then
    select x into it from jsonb_array_elements(plan->'items') with ordinality t(x, o) where x->>'sid' = coalesce(p->>'sid', '') order by o limit 1;
    if it is null then raise exception 'This session is not in your program'; end if;
    if (it->>'date')::date > today or (it->>'date')::date < today - days then raise exception 'You can log a workout on its day, up to 7 days after'; end if;
    perform app.wo_write_logs(cu, it->>'sid', (it->>'date')::date, it->>'name', p->'entries', 'client');
  end if;
  out := out || '{"has":true}';
  ci := app.wo_cur_phase(ph, today);
  if ci > -1 then
    out := out || jsonb_build_object('phase', jsonb_build_object('name', ph->ci->'name', 'start', ph->ci->'start', 'end', ph->ci->'end', 'n', ci + 1, 'of', jsonb_array_length(ph),
      'note', coalesce(nullif(prow.program->'phases'->ci->>'note', ''), ''),
      'workouts', (select coalesce(jsonb_agg(x->'name' order by o), '[]') from jsonb_array_elements(ph->ci->'workouts') with ordinality t(x, o)),
      'done', (select count(*) from jsonb_array_elements(plan->'items') x where (x->>'phase')::int = ci and x->>'state' = 'done')));
  else
    lastend := (ph->(jsonb_array_length(ph) - 1)->>'end')::date;
    out := out || jsonb_build_object('ended', coalesce(today > lastend, false));
  end if;
  if cur is not null then
    out := out || jsonb_build_object('workout', jsonb_build_object('sid', cur->'sid', 'date', cur->'date', 'start', cur->'start', 'trainer', cur->'trainer', 'name', cur->'name',
      'n', (cur->>'w')::int + 1, 'catchUp', cur->'catchUp', 'w', ph->((cur->>'phase')::int)->'workouts'->((cur->>'w')::int)));
  end if;
  out := out || jsonb_build_object('recent', (select coalesce(jsonb_agg(jsonb_build_object('sid', x->'sid', 'date', x->'date', 'name', x->'name',
      'w', ph->((x->>'phase')::int)->'workouts'->((x->>'w')::int)) order by o desc), '[]')
    from jsonb_array_elements(plan->'items') with ordinality t(x, o) where (x->>'date')::date < today and (x->>'date')::date >= today - days and x->>'state' = 'done'));
  logs := app.wo_logs_of(cu);
  select coalesce(jsonb_object_agg(k, v), '{}') into logged from (
    select distinct on (l->>'sid', l->>'ex') (l->>'sid') || '|' || (l->>'ex') as k, l->'sets' as v from jsonb_array_elements(logs) with ordinality t(l, o)
     where (l->>'date')::date >= today - days order by l->>'sid', l->>'ex', o desc) z;
  return out || jsonb_build_object('logs', app.wo_log_map(logs), 'logged', logged);
end $$;
-- exercise library (Workout.gs WO.LIB), group order kept in app.wo_lib_order()
create or replace function app.wo_lib_base() returns jsonb language sql immutable as $$ select '{"Warm up":["Jumping jacks","Bike","Rower","Treadmill walk","Arm circles","Leg swings","Hip circles","Cat cow","World''s greatest stretch","Inchworm","Glute bridge","Band pull apart","Bodyweight squat","Walking lunge","Thoracic rotation","Dead bug"],"Chest":["Barbell bench press","Dumbbell bench press","Incline dumbbell press","Incline barbell press","Decline press","Machine chest press","Push up","Incline push up","Dumbbell fly","Cable fly","Pec deck","Dips (chest)"],"Back":["Pull up","Assisted pull up","Lat pulldown","Close grip pulldown","Seated cable row","Bent over barbell row","One arm dumbbell row","Chest supported row","T bar row","Inverted row","Straight arm pulldown","Face pull","Back extension","Deadlift"],"Shoulders":["Overhead barbell press","Seated dumbbell press","Arnold press","Landmine press","Lateral raise","Cable lateral raise","Front raise","Rear delt fly","Reverse pec deck","Upright row","Shrugs"],"Biceps":["Barbell curl","Dumbbell curl","Hammer curl","Incline dumbbell curl","Preacher curl","Cable curl","Concentration curl"],"Triceps":["Triceps pushdown","Overhead cable extension","Skull crusher","Close grip bench press","Dips (triceps)","Bench dips","Kickback"],"Quads":["Back squat","Front squat","Goblet squat","Leg press","Hack squat","Bulgarian split squat","Reverse lunge","Walking lunge (loaded)","Step up","Leg extension","Wall sit","Sissy squat"],"Hamstrings":["Romanian deadlift","Single leg RDL","Lying leg curl","Seated leg curl","Nordic curl","Good morning","Swiss ball leg curl","Kettlebell swing"],"Glutes":["Hip thrust","Barbell glute bridge","Single leg hip thrust","Cable kickback","Hip abduction machine","Banded lateral walk","Sumo deadlift","Frog pump","Clamshell"],"Calves":["Standing calf raise","Seated calf raise","Single leg calf raise","Tibialis raise"],"Abs":["Plank","Side plank","Dead bug","Bird dog","Hollow hold","Crunch","Reverse crunch","Hanging knee raise","Hanging leg raise","Cable crunch","Pallof press","Russian twist","Ab wheel rollout","Mountain climbers","Bicycle crunch","Farmer carry","Suitcase carry"],"Conditioning":["Burpees","Battle ropes","Sled push","Box jump","Jump squat","Skipping","Assault bike sprint","Rower sprint","Thrusters","Wall balls","Kettlebell clean"],"Stretching":["Hamstring stretch","Quad stretch","Hip flexor stretch","Pigeon stretch","Glute stretch (figure 4)","Adductor stretch","Calf stretch","Chest doorway stretch","Lat stretch","Child pose","Cobra","Thread the needle","Neck stretch","Triceps stretch","Shoulder cross body stretch","90/90 hip switch"]}'::jsonb $$;
create or replace function app.wo_lib_order() returns text[] language sql immutable as $$ select '{"Warm up","Chest","Back","Shoulders","Biceps","Triceps","Quads","Hamstrings","Glutes","Calves","Abs","Conditioning","Stretching"}'::text[] $$;
-- the nutrition questionnaire sent to the phone (Nutrition.gs nutQuestions_())
create or replace function app.nut_questions() returns jsonb language sql immutable as $$ select '[{"step":1,"t":{"en":"Your goal","ar":"هدفك"},"q":[{"k":"goal","type":"one","t":{"en":"What do you want most?","ar":"شو بدك أكتر شي؟"},"opts":[{"v":"lose","en":"Lose fat","ar":"خسارة دهون"},{"v":"tone","en":"Tone up and keep my weight","ar":"شد الجسم مع الحفاظ على الوزن"},{"v":"gain","en":"Build muscle and gain weight","ar":"بناء عضل وزيادة وزن"},{"v":"health","en":"Eat healthier, feel better","ar":"أكل صحي أكتر"}]},{"k":"why","type":"text","max":200,"t":{"en":"Why now? (one sentence)","ar":"ليش هلق؟ (جملة وحدة)"}},{"k":"pace","type":"one","t":{"en":"Which pace suits you?","ar":"أي سرعة بتناسبك؟"},"opts":[{"v":"slow","en":"Steady and easy to keep","ar":"ثابتة وسهلة"},{"v":"fast","en":"Faster, I am very motivated","ar":"أسرع، أنا متحمس كتير"}]},{"k":"event","type":"text","max":80,"t":{"en":"Any date you are aiming for? (wedding, summer, trip)","ar":"في تاريخ معين؟ (عرس، صيف، سفر)"}}]},{"step":2,"t":{"en":"Your day","ar":"نهارك"},"q":[{"k":"job","type":"one","t":{"en":"Your work day is mostly","ar":"شغلك بالنهار"},"opts":[{"v":"desk","en":"Sitting (desk, car)","ar":"قاعد (مكتب، سيارة)"},{"v":"mixed","en":"On my feet part of the day","ar":"واقف جزء من النهار"},{"v":"active","en":"Physical work, moving all day","ar":"شغل جسدي طول النهار"}]},{"k":"train_days","type":"one","t":{"en":"Training days per week (Wellbe + other)","ar":"كم يوم تمرين بالأسبوع"},"opts":[{"v":"1","en":"1","ar":"1"},{"v":"2","en":"2","ar":"2"},{"v":"3","en":"3","ar":"3"},{"v":"4","en":"4","ar":"4"},{"v":"5","en":"5+","ar":"5+"}]},{"k":"train_time","type":"one","t":{"en":"You usually train","ar":"عادة بتتمرن"},"opts":[{"v":"am","en":"Morning","ar":"الصبح"},{"v":"mid","en":"Midday","ar":"الضهر"},{"v":"pm","en":"Evening","ar":"المسا"}]},{"k":"wake","type":"time","t":{"en":"You wake up at","ar":"بتفيق الساعة"}},{"k":"sleep","type":"one","t":{"en":"Hours of sleep","ar":"ساعات النوم"},"opts":[{"v":"5","en":"Under 6","ar":"أقل من 6"},{"v":"6","en":"6 to 7","ar":"6 لـ 7"},{"v":"8","en":"7 to 8+","ar":"7 لـ 8+"}]}]},{"step":3,"t":{"en":"How you eat","ar":"كيف بتاكل"},"q":[{"k":"meals","type":"one","t":{"en":"Meals per day that suit you","ar":"كم وجبة بالنهار بتناسبك"},"opts":[{"v":"2","en":"2 meals","ar":"وجبتين"},{"v":"3","en":"3 meals","ar":"3 وجبات"},{"v":"3s","en":"3 meals + 1 snack","ar":"3 وجبات + سناك"},{"v":"4s","en":"3 meals + 2 snacks","ar":"3 وجبات + سناكين"}]},{"k":"breakfast","type":"one","t":{"en":"Breakfast","ar":"الترويقة"},"opts":[{"v":"yes","en":"I eat breakfast","ar":"بترويق"},{"v":"late","en":"Late, around noon","ar":"متأخر، عالضهر"},{"v":"no","en":"I skip it","ar":"ما بترويق"}]},{"k":"cook","type":"one","t":{"en":"Who cooks your food?","ar":"مين بيطبخ أكلك؟"},"opts":[{"v":"me","en":"Me","ar":"أنا"},{"v":"family","en":"Family / home cooking","ar":"البيت / العيلة"},{"v":"out","en":"Mostly delivery or eating out","ar":"دليفري أو برا"}]},{"k":"cook_time","type":"one","t":{"en":"Time to prepare food per day","ar":"وقت التحضير باليوم"},"opts":[{"v":"10","en":"10 min or less","ar":"10 دقايق أو أقل"},{"v":"30","en":"About 30 min","ar":"حوالي نص ساعة"},{"v":"60","en":"I like cooking","ar":"بحب الطبخ"}]},{"k":"out","type":"one","t":{"en":"Delivery / eating out per week","ar":"دليفري أو أكل برا بالأسبوع"},"opts":[{"v":"0","en":"Rarely","ar":"نادراً"},{"v":"2","en":"1 to 2 times","ar":"مرة لمرتين"},{"v":"4","en":"3 to 5 times","ar":"3 لـ 5 مرات"},{"v":"7","en":"Almost daily","ar":"تقريباً كل يوم"}]},{"k":"budget","type":"one","t":{"en":"Food budget","ar":"ميزانية الأكل"},"opts":[{"v":"low","en":"Tight, keep it cheap","ar":"محدودة"},{"v":"mid","en":"Normal","ar":"عادية"},{"v":"high","en":"Not an issue","ar":"مش مشكلة"}]}]},{"step":4,"t":{"en":"What you eat now","ar":"شو بتاكل هلق"},"q":[{"k":"now_day","type":"text","max":400,"t":{"en":"Describe a normal day of eating (what and roughly when)","ar":"خبرنا عن نهار عادي من الأكل"}},{"k":"often","type":"many","t":{"en":"Things you eat a lot of","ar":"أكلات بتاكلها كتير"},"opts":[{"v":"bread","en":"Bread / man2oushe","ar":"خبز / منقوشة"},{"v":"rice","en":"Rice","ar":"رز"},{"v":"pasta","en":"Pasta","ar":"معكرونة"},{"v":"sweets","en":"Sweets / chocolate","ar":"حلو / شوكولا"},{"v":"chips","en":"Chips / snacks","ar":"شيبس / سناكات"},{"v":"fastfood","en":"Fast food","ar":"فاست فود"},{"v":"fruit","en":"Fruit","ar":"فواكه"},{"v":"dairy","en":"Labneh / cheese / laban","ar":"لبنة / جبنة / لبن"},{"v":"chicken","en":"Chicken","ar":"دجاج"},{"v":"meat","en":"Red meat","ar":"لحمة"},{"v":"fish","en":"Fish","ar":"سمك"},{"v":"eggs","en":"Eggs","ar":"بيض"}]},{"k":"love","type":"many","t":{"en":"Lebanese dishes you love","ar":"أكلات لبنانية بتحبها"},"opts":[{"v":"tabbouleh","en":"Tabbouleh / fattoush","ar":"تبولة / فتوش"},{"v":"mjadra","en":"Mjadra","ar":"مجدرة"},{"v":"loubieh","en":"Loubieh / bamieh / fasoulia","ar":"لوبية / بامية / فاصوليا"},{"v":"kibbeh","en":"Kibbeh","ar":"كبة"},{"v":"shawarma","en":"Shawarma / taouk","ar":"شاورما / طاووق"},{"v":"grills","en":"Mashawi","ar":"مشاوي"},{"v":"foul","en":"Foul / hummus / balila","ar":"فول / حمص / بليلة"},{"v":"mloukhieh","en":"Mloukhieh","ar":"ملوخية"},{"v":"mehshi","en":"Mehshi / warak enab","ar":"محشي / ورق عنب"},{"v":"manakish","en":"Manakish","ar":"مناقيش"},{"v":"fatteh","en":"Fatteh","ar":"فتة"},{"v":"samke","en":"Samke harra / sayadieh","ar":"سمكة حرة / صيادية"}]},{"k":"love_other","type":"text","max":150,"t":{"en":"Other foods you love","ar":"أكلات تانية بتحبها"}},{"k":"dislike","type":"text","max":150,"t":{"en":"Foods you do not eat or dislike","ar":"أكلات ما بتاكلها أو ما بتحبها"}}]},{"step":5,"t":{"en":"Allergies and rules","ar":"حساسية وقواعد"},"q":[{"k":"allergy","type":"many","t":{"en":"Allergies or intolerances","ar":"حساسية أو عدم تحمل"},"opts":[{"v":"none","en":"None","ar":"ولا شي"},{"v":"lactose","en":"Lactose","ar":"لاكتوز"},{"v":"gluten","en":"Gluten","ar":"غلوتين"},{"v":"nuts","en":"Nuts","ar":"مكسرات"},{"v":"peanut","en":"Peanuts","ar":"فول سوداني"},{"v":"eggs","en":"Eggs","ar":"بيض"},{"v":"seafood","en":"Fish / seafood","ar":"سمك / بحريات"},{"v":"sesame","en":"Sesame / tahini","ar":"سمسم / طحينة"},{"v":"soy","en":"Soy","ar":"صويا"}]},{"k":"allergy_other","type":"text","max":100,"t":{"en":"Other allergy","ar":"حساسية تانية"}},{"k":"rules","type":"many","t":{"en":"Food rules you follow","ar":"قواعد بتتبعها"},"opts":[{"v":"halal","en":"Halal","ar":"حلال"},{"v":"nopork","en":"No pork","ar":"بلا خنزير"},{"v":"vegetarian","en":"Vegetarian","ar":"نباتي"},{"v":"vegan","en":"Vegan","ar":"نباتي صرف"},{"v":"ramadan","en":"I fast in Ramadan","ar":"بصوم رمضان"},{"v":"lent","en":"I fast in Lent","ar":"بصوم الصوم الكبير"}]},{"k":"digest","type":"many","t":{"en":"Digestion","ar":"الهضم"},"opts":[{"v":"ok","en":"All good","ar":"تمام"},{"v":"bloat","en":"Bloating","ar":"نفخة"},{"v":"reflux","en":"Reflux / heartburn","ar":"حرقة"},{"v":"ibs","en":"IBS / sensitive stomach","ar":"قولون حساس"},{"v":"const","en":"Constipation","ar":"إمساك"}]}]},{"step":6,"t":{"en":"Drinks and habits","ar":"مشروبات وعادات"},"q":[{"k":"coffee","type":"one","t":{"en":"Coffee per day","ar":"قهوة باليوم"},"opts":[{"v":"0","en":"None","ar":"ولا شي"},{"v":"2","en":"1 to 2","ar":"1 لـ 2"},{"v":"4","en":"3+","ar":"3+"}]},{"k":"sugar_drinks","type":"one","t":{"en":"Soft drinks / juice / sweet coffee","ar":"مشروبات غازية / عصير / قهوة محلاية"},"opts":[{"v":"0","en":"Rarely","ar":"نادراً"},{"v":"1","en":"Once a day","ar":"مرة باليوم"},{"v":"3","en":"Several a day","ar":"كذا مرة"}]},{"k":"alcohol","type":"one","t":{"en":"Alcohol","ar":"كحول"},"opts":[{"v":"0","en":"Never","ar":"أبداً"},{"v":"1","en":"Weekends","ar":"ويكند"},{"v":"3","en":"Several times a week","ar":"كذا مرة بالأسبوع"}]},{"k":"water","type":"one","t":{"en":"Water per day","ar":"مي باليوم"},"opts":[{"v":"1","en":"Under 1 L","ar":"أقل من ليتر"},{"v":"2","en":"1 to 2 L","ar":"1 لـ 2 ليتر"},{"v":"3","en":"2 L+","ar":"أكتر من 2"}]},{"k":"cravings","type":"one","t":{"en":"When do cravings hit?","ar":"إيمتى بتجيك الشهوة للأكل؟"},"opts":[{"v":"none","en":"Not really","ar":"مش كتير"},{"v":"afternoon","en":"Afternoon","ar":"بعد الضهر"},{"v":"night","en":"Late night","ar":"آخر الليل"},{"v":"stress","en":"When stressed","ar":"لما كون متوتر"}]},{"k":"weekend","type":"one","t":{"en":"Weekends","ar":"الويكند"},"opts":[{"v":"same","en":"Same as weekdays","ar":"متل باقي الأيام"},{"v":"family","en":"Big family lunches","ar":"غدا عيلة كبير"},{"v":"out","en":"Out with friends","ar":"طلعات مع رفقات"}]},{"k":"supps","type":"many","t":{"en":"Supplements you take","ar":"مكملات بتاخدها"},"opts":[{"v":"none","en":"None","ar":"ولا شي"},{"v":"whey","en":"Whey protein","ar":"بروتين واي"},{"v":"creatine","en":"Creatine","ar":"كرياتين"},{"v":"multi","en":"Multivitamin","ar":"فيتامينات"},{"v":"omega","en":"Omega 3","ar":"أوميغا 3"},{"v":"vitd","en":"Vitamin D","ar":"فيتامين د"}]}]},{"step":7,"t":{"en":"Your health","ar":"صحتك"},"note":{"en":"This keeps you safe. A coach will look at your plan personally if any of these apply.","ar":"هيدا لسلامتك. إذا شي من هول بينطبق عليك، المدرب رح يشوف خطتك شخصياً."},"q":[{"k":"health","type":"many","t":{"en":"Does any of this apply to you?","ar":"شي من هول بينطبق عليك؟"},"opts":[{"v":"none","en":"None of these","ar":"ولا شي"},{"v":"pregnant","en":"Pregnant or breastfeeding","ar":"حامل أو عم رضع"},{"v":"diabetes","en":"Diabetes or pre-diabetes","ar":"سكري"},{"v":"kidney","en":"Kidney problems","ar":"مشاكل كلى"},{"v":"liver","en":"Liver problems","ar":"مشاكل كبد"},{"v":"thyroid","en":"Thyroid problems","ar":"مشاكل غدة"},{"v":"meds","en":"Medication that changes appetite","ar":"دوا بيغير الشهية"},{"v":"ed","en":"Past eating disorder","ar":"اضطراب أكل سابقاً"}]}]}]'::jsonb $$;

-- ---------------------------------------------------------------------
-- NUTRITION (Nutrition.gs). The numbers are code (never AI); the AI worker only writes the meals.
-- ---------------------------------------------------------------------
create or replace function app.nut_flags(age int, ans jsonb) returns jsonb language sql immutable as $$
  select (case when coalesce(age, 0) > 0 and age < 18 then '["minor"]'::jsonb else '[]'::jsonb end)
      || coalesce((select jsonb_agg(k order by i) from unnest(array['pregnant', 'ed', 'kidney', 'diabetes', 'thyroid', 'liver', 'meds']) with ordinality u(k, i)
                    where jsonb_typeof(ans->'health') = 'array' and ans->'health' ? k), '[]'::jsonb)
$$;
create or replace function app.nut_factor(ans jsonb) returns float8 language sql immutable as $$
  select app.jr(((case ans->>'job' when 'desk' then 1.2 when 'mixed' then 1.35 when 'active' then 1.5 else 1.25 end)::float8
                 + least(5::float8, app.n0(ans->'train_days')) * 0.045::float8) * 1000) / 1000
$$;
-- '2027-05-03' -> '3 May 2027' / '3 أيار 2027'
create or replace function app.nut_day(d date, ar boolean) returns text language sql immutable as $$
  select extract(day from d)::int || ' ' || (case when ar then array['كانون التاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين التاني', 'كانون الأول']
    else array['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] end)[extract(month from d)::int]
    || ' ' || to_char(d, 'YYYY')
$$;
create or replace function app.fnum(x float8) returns text language sql immutable as $$ select app.jsnum(x::numeric) $$;
-- a RANGE and a date window, never a promise (nutProject_)
create or replace function app.nut_project(w float8, target float8, rate float8, dir text, today date, td float8) returns jsonb language plpgsql immutable as $$
declare gap float8; vfast float8; vslow float8; mid float8; wk float8; d_early date; d_late date; d_at date; sgn int; lo float8; hi float8; va float8; vb float8; tds text := app.fnum(td);
begin
  if dir = 'keep' or not (rate > 0) then
    return jsonb_build_object('dir', 'keep', 'text', jsonb_build_object(
      'en', 'Keep your weight and build a stronger shape: follow the plan and train ' || tds || ' times a week.',
      'ar', 'حافظ عوزنك وابني جسم أقوى: اتبع الخطة وتمرن ' || tds || ' مرات بالأسبوع.'));
  end if;
  gap := abs(target - w); vfast := rate * 1.15::float8; vslow := rate * 0.8::float8; mid := rate;
  wk := gap / mid;
  d_early := today + app.jr(gap / vfast * 7)::int; d_late := today + app.jr(gap / vslow * 7)::int; d_at := today + app.jr(wk * 7)::int;
  sgn := case when dir = 'lose' then -1 else 1 end; lo := w + sgn * wk * vslow; hi := w + sgn * wk * vfast;
  va := app.jr(least(lo, hi) * 2) / 2; vb := app.jr(greatest(lo, hi) * 2) / 2;
  if dir = 'lose' then va := greatest(va, target); else vb := least(vb, target); end if;
  return jsonb_build_object('dir', dir, 'weeks', app.jr(wk), 'at', d_at, 'early', d_early, 'late', d_late, 'low', va, 'high', vb,
    'in4', app.jr((w + sgn * 4 * mid) * 2) / 2, 'in12', app.jr((w + sgn * least(12 * mid, gap)) * 2) / 2, 'perWeek', app.jr(mid * 100) / 100,
    'text', jsonb_build_object(
      'en', 'Train ' || tds || ' times a week and follow this plan: about ' || app.fnum(va) || ' to ' || app.fnum(vb) || ' kg around ' || app.nut_day(d_at, false)
            || '. Most people like you reach ' || app.fnum(target) || ' kg between ' || app.nut_day(d_early, false) || ' and ' || app.nut_day(d_late, false) || '.',
      'ar', 'تمرن ' || tds || ' مرات بالأسبوع واتبع الخطة: حوالي ' || app.fnum(va) || ' لـ ' || app.fnum(vb) || ' كيلو تقريباً بـ ' || app.nut_day(d_at, true)
            || '. معظم الناس متلك بيوصلوا لـ ' || app.fnum(target) || ' كيلو بين ' || app.nut_day(d_early, true) || ' و ' || app.nut_day(d_late, true) || '.'));
end $$;
-- p: {weight, height, age, sex, bf, target, pace, ans} -> calories and macros (nutCalc_, same float math as JavaScript)
create or replace function app.nut_calc(prof jsonb, today date) returns jsonb language plpgsql immutable as $$
declare ans jsonb := coalesce(prof->'ans', '{}'); out jsonb; flags jsonb; w float8 := app.n0(prof->'weight'); h float8 := app.n0(prof->'height');
  age float8 := app.n0(prof->'age'); sx text := coalesce(prof->>'sex', ''); bf float8 := app.n0(prof->'bf'); hm float8; target float8; lbm float8; bmr float8; tdee float8;
  dir text; pace text; rate float8; kcal float8; fl float8; prot float8; fat float8; carb float8; floorhit boolean := false;
begin
  flags := app.nut_flags(age::int, ans);
  out := jsonb_build_object('ok', false, 'flags', flags);
  if not (w > 25) or not (h > 100) or not (age > 0) or sx = '' then
    return out || jsonb_build_object('missing', true, 'msg', 'Add your weight, height, birth year and sex first.');
  end if;
  if exists (select 1 from jsonb_array_elements_text(flags) f where f in ('minor', 'pregnant', 'ed', 'kidney')) then
    return out || jsonb_build_object('coach', true, 'msg', 'A Wellbe coach will set your numbers with you personally.');
  end if;
  out := out || '{"coach":false}';
  hm := h / 100; target := coalesce(nullif(app.n0(prof->'target'), 0), w);
  out := out || jsonb_build_object('bmi', app.jr(w / (hm * hm) * 10) / 10);
  if target / (hm * hm) < 18.5 then
    return out || jsonb_build_object('blocked', true, 'msg', 'This target is under a healthy weight for your height. Your coach will set a safe target with you.', 'safeMin', ceil(18.5::float8 * hm * hm));
  end if;
  lbm := case when bf > 3 and bf < 60 then w * (1 - bf / 100) else 0 end;
  bmr := case when lbm <> 0 then 370 + 21.6::float8 * lbm else 10 * w + 6.25::float8 * h - 5 * age + case when sx = 'M' then 5 else -161 end end;
  tdee := bmr * app.nut_factor(ans);
  dir := case when target - w < -0.5 then 'lose' when target - w > 0.5 then 'gain' else 'keep' end;
  pace := case when prof->>'pace' = 'fast' then 'fast' else 'slow' end;
  rate := case dir when 'lose' then (case pace when 'fast' then 0.0075 else 0.005 end)::float8 * w
                   when 'gain' then (case pace when 'fast' then 0.005 else 0.0025 end)::float8 * w else 0 end;
  kcal := tdee + (case when dir = 'lose' then -1 else 1 end) * rate * 7700 / 7;
  fl := greatest(case when sx = 'M' then 1500 else 1200 end, bmr * 1.0::float8);
  if dir = 'lose' and kcal < fl then kcal := fl; rate := greatest(0, (tdee - kcal) * 7 / 7700); floorhit := true; end if;
  kcal := app.jr(kcal / 10) * 10;
  prot := app.jr(2 * target / 5) * 5; fat := app.jr(kcal * 0.28::float8 / 9); carb := app.jr((kcal - prot * 4 - fat * 9) / 4 / 5) * 5;
  if carb < 60 then fat := app.jr(kcal * 0.25::float8 / 9); carb := greatest(40, app.jr((kcal - prot * 4 - fat * 9) / 4 / 5) * 5); end if;
  if floorhit then out := out || '{"floorHit":true}'; end if;
  return out || jsonb_build_object('ok', true, 'dir', dir, 'bmr', app.jr(bmr), 'tdee', app.jr(tdee), 'kcal', kcal, 'p', prot, 'f', fat, 'c', carb,
    'rateKg', app.jr(rate * 100) / 100, 'method', case when lbm <> 0 then 'Katch-McArdle' else 'Mifflin St Jeor' end, 'weight', w, 'target', target,
    'check', exists (select 1 from jsonb_array_elements_text(flags) f where f in ('diabetes', 'thyroid', 'liver', 'meds')),
    'projection', app.nut_project(w, target, rate, dir, today, coalesce(nullif(app.n0(ans->'train_days'), 0), 3)));
end $$;
-- NUTRITION INTAKE as the old code read it: {answers, step, done, ver, target, comp, flags}
create or replace function app.nut_intake(cu uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('answers', answers, 'step', step, 'done', done, 'ver', version, 'target', coalesce(target_kg::float8, 0),
      'comp', coalesce(body_comp, '{}'::jsonb), 'flags', coalesce(to_jsonb(array_remove(string_to_array(coalesce(flags, ''), ','), '')), '[]'::jsonb))
      from public.nutrition_intake where client_id = cu),
    '{"answers":{},"step":0,"done":false,"ver":0,"target":0,"comp":{},"flags":[]}'::jsonb)
$$;
create or replace function app.nut_save_intake(cu uuid, it jsonb) returns void language sql security definer set search_path = public as $$
  insert into public.nutrition_intake (client_id, answers, step, done, version, target_kg, body_comp, flags, updated_at)
  values (cu, it->'answers', (it->>'step')::int, (it->>'done')::boolean, (it->>'ver')::int, nullif((it->>'target')::numeric, 0), it->'comp',
          (select string_agg(x, ',' order by i) from jsonb_array_elements_text(it->'flags') with ordinality t(x, i)), now())
  on conflict (client_id) do update set answers = excluded.answers, step = excluded.step, done = excluded.done, version = excluded.version,
    target_kg = excluded.target_kg, body_comp = excluded.body_comp, flags = excluded.flags, updated_at = excluded.updated_at
$$;
create or replace function app.nut_weighins(cu uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('date', day, 'kg', weight_kg::float8) order by day, seq), '[]'::jsonb) from public.nutrition_weighins where client_id = cu
$$;
-- nutProfile_: latest weigh-in when it is not older than the body numbers
create or replace function app.nut_profile(cu uuid, it jsonb, today date) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare body jsonb := app.wo_body(cu); lastw record; w float8; birth int;
begin
  select day, weight_kg::float8 as kg into lastw from public.nutrition_weighins where client_id = cu order by day desc, seq desc limit 1;
  w := case when lastw.day is not null and (coalesce(body->>'date', '') = '' or lastw.day::text >= body->>'date') then lastw.kg else (body->>'weight')::float8 end;
  birth := (body->>'birth')::int;
  return jsonb_build_object('weight', coalesce(w, 0), 'height', body->'height', 'age', case when birth <> 0 then extract(year from today)::int - birth else 0 end,
    'sex', body->'sex', 'bf', app.n0(it->'comp'->'bf'), 'target', it->'target', 'pace', it->'answers'->'pace', 'ans', it->'answers');
end $$;
-- full plan = a current paid package (no trial, assessment or free)
create or replace function app.nut_paid(cu uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(app.legacy(cu) ~ '^C\d+$', false) and exists (select 1 from public.packages p where p.client_id = cu
    and app.pkg_phase(p, app_today()) = 'current' and p.type_name !~* 'trial|assessment|free')
$$;
-- one NUTRITION PLANS row the way the old code read it
create or replace function app.nut_plan_obj(r public.nutrition_plans) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.legacy_id, 'cid', app.legacy(r.client_id), 'name', (select name from public.clients where id = r.client_id), 'created', app.stamp(r.created_at),
    'status', r.status, 'macros', r.macros, 'plan', r.plan, 'ver', coalesce(r.intake_version, 0), 'weight', coalesce(r.weight_at_plan::float8, 0), 'target', coalesce(r.target::float8, 0),
    'by', coalesce(r.by_who, ''), 'decided', app.stamp(r.decided_at), 'note', coalesce(r.coach_note, ''), 'error', coalesce(r.error, ''), 'attempts', r.attempts,
    'since', coalesce(floor(extract(epoch from r.writing_since) * 1000), 0))
$$;
-- nutNewPlan_: older open plans of this client are replaced
create or replace function app.nut_new_plan(cu uuid, st text, macros jsonb, it jsonb, w float8, who text) returns text language plpgsql security definer set search_path = public as $$
declare lid text;
begin
  update public.nutrition_plans set status = 'Replaced' where client_id = cu and status in ('Queued', 'Writing', 'Pending', 'Coach review', 'Failed');
  lid := app.next_legacy('NP', 'public.nutrition_plans', 4);
  insert into public.nutrition_plans (legacy_id, client_id, status, macros, intake_version, weight_at_plan, target, by_who)
  values (lid, cu, st, coalesce(macros, '{}'), (it->>'ver')::int, nullif(w, 0), nullif((it->>'target')::numeric, 0), who);
  return lid;
end $$;
create or replace function app.nut_auto_replan(cu uuid, it jsonb, why text) returns text language plpgsql security definer set search_path = public as $$
declare calc jsonb;
begin
  if not app.nut_paid(cu) or not (it->>'done')::boolean then return ''; end if;
  calc := app.nut_calc(app.nut_profile(cu, it, app_today()), app_today());
  if not (calc->>'ok')::boolean then return ''; end if;
  return app.nut_new_plan(cu, 'Queued', calc, it, (calc->>'weight')::float8, 'auto: ' || why);
end $$;
-- nutNum_: one decimal, inside the range, else 0
create or replace function app.nut_num(v jsonb, lo float8, hi float8) returns float8 language sql immutable as $$
  select case when x >= lo and x <= hi then x else 0 end from (select app.jr(app.n0(v) * 10) / 10 as x) z
$$;
-- staff: trainers only their own clients (nutCanSee_)
create or replace function app.nut_can_see(me jsonb, cu uuid) returns boolean language sql stable as $$
  select me->>'role' <> 'trainer' or (cu is not null and app.wo_can_see(me, app.wo_sess(cu, app_today() - app.setting_int('{windows,trainerSee}', 60), app_today() + app.setting_int('{windows,ahead}', 35)), app_today()))
$$;
-- closes the matching To do item (nutCloseReq_)
create or replace function app.nut_close_req(plan_id text, who text, st text) returns void language sql security definer set search_path = public as $$
  update public.client_requests set status = st, handled_by = who, handled_at = now() where type = 'Nutrition plan' and status = 'New' and data->>'plan' = plan_id
$$;

-- action app_cl_nut { cid, op: intake_get | intake_save | body | upload | calc | generate | get | weigh } (nutClient_)
create or replace function public.api_app_cl_nut(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cid text := upper(coalesce(p->>'cid', '')); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; op text := coalesce(nullif(p->>'op', ''), 'intake_get');
  today date := app_today(); it jsonb; out jsonb := '{}'; qs jsonb := app.nut_questions(); q record; v jsonb; ok_v jsonb; miss text[]; w float8; h float8; y float8; sx text; tg float8;
  yr int := extract(year from app_today())::int; c jsonb; old_t float8; kg float8; ap public.nutrition_plans; calc jsonb; prof jsonb; lid text; st text; nm text; lastp public.nutrition_plans; paid boolean;
begin
  me := app.need_client(cu);
  it := app.nut_intake(cu);
  nm := (select name from public.clients where id = cu);
  if op = 'intake_save' then
    for q in select x as qq from jsonb_array_elements(qs) s, jsonb_array_elements(s->'q') x loop
      continue when not (coalesce(p->'answers', '{}'::jsonb) ? (q.qq->>'k'));
      v := p->'answers'->(q.qq->>'k');
      if q.qq->>'type' = 'many' then
        select coalesce(jsonb_agg(o->'v'), '[]') into ok_v from jsonb_array_elements(q.qq->'opts') o;
        select coalesce(jsonb_agg(x order by i), '[]') into v from jsonb_array_elements(app.arr(v)) with ordinality t(x, i) where ok_v @> jsonb_build_array(x) and i <= 20;
        if jsonb_array_length(v) > 1 then select coalesce(jsonb_agg(x order by i), '[]') into v from jsonb_array_elements(v) with ordinality t(x, i) where x <> '"none"'::jsonb; end if;
      elsif q.qq->>'type' = 'one' then
        continue when jsonb_typeof(v) <> 'string' or not exists (select 1 from jsonb_array_elements(q.qq->'opts') o where o->>'v' = v #>> '{}');
      elsif q.qq->>'type' = 'time' then
        v := to_jsonb(case when jsonb_typeof(v) = 'string' and v #>> '{}' ~ '^\d{2}:\d{2}$' then v #>> '{}' else '' end);
      else
        v := to_jsonb(app.clean_json(v, coalesce((q.qq->>'max')::int, 200)));
      end if;
      it := jsonb_set(it, array['answers', q.qq->>'k'], v);
    end loop;
    it := it || jsonb_build_object('step', greatest((it->>'step')::int, least(7, app.n0(p->'step'))::int));
    if app.truthy(p->'done') then
      select array_agg(k order by i) into miss from unnest(array['goal', 'job', 'train_days', 'meals', 'allergy', 'health']) with ordinality u(k, i)
       where it->'answers'->k is null or jsonb_typeof(it->'answers'->k) = 'null' or it->'answers'->k in ('""'::jsonb, '[]'::jsonb);
      if miss is not null then raise exception 'A few answers are missing: %', array_to_string(miss, ', '); end if;
      it := it || jsonb_build_object('done', true, 'ver', (it->>'ver')::int + 1);
    end if;
    it := it || jsonb_build_object('flags', app.nut_flags((app.nut_profile(cu, it, today)->>'age')::int, it->'answers'));
    perform app.nut_save_intake(cu, it);
  end if;
  if op = 'body' then
    w := app.n0(p->'weight'); h := app.n0(p->'height'); y := app.n0(p->'birth'); sx := case when p->>'sex' in ('M', 'F') then p->>'sex' else '' end; tg := app.n0(p->'target');
    if w <> 0 and (w < 25 or w > 300) then raise exception 'Check your weight (kg)'; end if;
    if h <> 0 and (h < 100 or h > 230) then raise exception 'Check your height (cm)'; end if;
    if y <> 0 and (y < 1920 or y > yr - 8) then raise exception 'Check your birth year'; end if;
    if tg <> 0 and (tg < 30 or tg > 250) then raise exception 'Check your target weight (kg)'; end if;
    if w <> 0 or h <> 0 or y <> 0 or sx <> '' then
      insert into public.client_body (day, client_id, weight_kg, height_cm, birth_year, sex, by_who) values (today, cu, nullif(w, 0), nullif(h, 0), nullif(y, 0)::int, nullif(sx, ''), 'client app');
    end if;
    if app.truthy(p->'comp') then
      c := p->'comp';
      it := it || jsonb_build_object('comp', jsonb_build_object('bf', app.nut_num(c->'bf', 3, 60), 'smm', app.nut_num(c->'smm', 5, 80), 'visceral', app.nut_num(c->'visceral', 1, 30),
        'date', case when jsonb_typeof(c->'date') = 'string' and c->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then c->>'date' else today::text end, 'file', app.clean_json(c->'file', 300)));
    end if;
    old_t := (it->>'target')::float8;
    if tg <> 0 then it := it || jsonb_build_object('target', tg); end if;
    perform app.nut_save_intake(cu, it);
    if tg <> 0 and old_t <> 0 and tg <> old_t then out := out || jsonb_build_object('replan', app.nut_auto_replan(cu, it, 'New target ' || app.fnum(tg) || ' kg')); end if;
  end if;
  if op = 'upload' then          -- the upload function stores the file and reads the report first, then calls this with {upload: {file, read}}
    if coalesce(jsonb_typeof(p->'upload'), '') <> 'object' then raise exception 'Nothing to upload'; end if;
    out := out || jsonb_build_object('file', p->'upload'->'file', 'read', p->'upload'->'read');
  end if;
  if op = 'weigh' then
    kg := app.n0(p->'kg');
    if kg < 25 or kg > 300 then raise exception 'Check the weight (kg)'; end if;
    insert into public.nutrition_weighins (day, client_id, weight_kg, by_who) values (today, cu, kg, 'client app');
    select * into ap from public.nutrition_plans where client_id = cu and status = 'Approved' order by created_at desc, legacy_id desc limit 1;
    if ap.id is not null and abs(kg - coalesce(ap.weight_at_plan::float8, 0)) > 2 then
      out := out || jsonb_build_object('replan', app.nut_auto_replan(cu, it, 'Weight changed to ' || app.fnum(kg) || ' kg'));
    end if;
  end if;
  if op = 'generate' then
    if not app.nut_paid(cu) then raise exception 'Your full plan comes with your Wellbe subscription. Message % to start.', app.desk_name(); end if;
    if not (it->>'done')::boolean then raise exception 'Finish the questionnaire first.'; end if;
    prof := app.nut_profile(cu, it, today); calc := app.nut_calc(prof, today);
    if app.truthy(calc->'missing') or app.truthy(calc->'blocked') then raise exception '%', calc->>'msg'; end if;
    if exists (select 1 from public.nutrition_plans where client_id = cu and status in ('Queued', 'Writing', 'Pending', 'Coach review')) and not app.truthy(p->'force') then
      raise exception 'Your plan is already being prepared. A coach checks it before you see it.';
    end if;
    st := case when app.truthy(calc->'coach') then 'Coach review' else 'Queued' end;
    lid := app.nut_new_plan(cu, st, calc, it, coalesce(nullif(app.n0(calc->'weight'), 0), app.n0(prof->'weight')), 'client app');
    if st = 'Coach review' then
      perform app.client_log(cu, nm, 'Nutrition plan', nm || ' asked for a nutrition plan. Health answers need a coach: build it with them personally ('
        || (select string_agg(x, ', ' order by i) from jsonb_array_elements_text(it->'flags') with ordinality t(x, i)) || '). Plan ' || lid, '', null, 'New', jsonb_build_object('plan', lid));
    end if;
    out := out || jsonb_build_object('status', st);
  end if;
  -- every op answers with the full state of the screen
  prof := app.nut_profile(cu, it, today); paid := app.nut_paid(cu);
  select * into lastp from public.nutrition_plans where client_id = cu and status <> 'Replaced' order by created_at desc, legacy_id desc limit 1;
  if op = 'intake_get' then out := out || jsonb_build_object('questions', qs); end if;
  out := out || jsonb_build_object('answers', it->'answers', 'step', it->'step', 'done', it->'done', 'target', it->'target', 'comp', it->'comp', 'flags', it->'flags',
    'body', jsonb_build_object('weight', prof->'weight', 'height', prof->'height', 'age', prof->'age', 'sex', prof->'sex'),
    'calc', app.nut_calc(prof, today), 'paid', paid,
    'weighins', (select coalesce(jsonb_agg(x order by i), '[]') from jsonb_array_elements(app.nut_weighins(cu)) with ordinality t(x, i) where i > jsonb_array_length(app.nut_weighins(cu)) - 26),
    'upsell', case when paid then '' else 'Get your full plan (meals, portions, grocery list) with your Wellbe subscription.' end);
  if lastp.id is not null then
    out := out || jsonb_build_object('plan', jsonb_build_object('id', lastp.legacy_id, 'status', lastp.status, 'created', app.stamp(lastp.created_at), 'note', coalesce(lastp.coach_note, ''))
      || case when lastp.status = 'Approved' and paid then jsonb_build_object('data', lastp.plan, 'macros', lastp.macros) else '{}'::jsonb end);
  end if;
  return out;
end $$;

-- action app_nut_list { all? }: plans waiting for a coach (nutList_)
create or replace function public.api_app_nut_list(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); r public.nutrition_plans; out jsonb := '[]'; m jsonb;
begin
  for r in select * from public.nutrition_plans order by created_at desc, legacy_id desc loop
    continue when r.status !~ 'Pending|Coach review|Failed' and not app.truthy(p->'all');
    continue when not app.nut_can_see(me, r.client_id);
    m := coalesce(r.macros, '{}');
    out := out || jsonb_build_array(jsonb_build_object('id', r.legacy_id, 'cid', app.legacy(r.client_id), 'name', (select name from public.clients where id = r.client_id),
      'status', r.status, 'created', app.stamp(r.created_at), 'error', coalesce(r.error, ''))
      || jsonb_strip_nulls(jsonb_build_object('kcal', m->'kcal', 'p', m->'p', 'c', m->'c', 'f', m->'f')));
    exit when jsonb_array_length(out) >= 100;
  end loop;
  return jsonb_build_object('plans', out);
end $$;

-- action app_nut_get { cid, id? } (nutGet_)
create or replace function public.api_app_nut_get(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cid text := upper(coalesce(p->>'cid', '')); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', '')));
  it jsonb; prof jsonb; r public.nutrition_plans; today date := app_today();
begin
  if not app.nut_can_see(me, cu) then raise exception 'This client is not one of yours'; end if;
  it := app.nut_intake(cu); prof := app.nut_profile(cu, it, today);
  if app.truthy(p->'id') then select * into r from public.nutrition_plans where client_id = cu and legacy_id = p->>'id';
  else select * into r from public.nutrition_plans where client_id = cu and status <> 'Replaced' order by created_at desc, legacy_id desc limit 1; end if;
  return jsonb_strip_nulls(jsonb_build_object('cid', cid, 'name', (select name from public.clients where id = cu))) || jsonb_build_object('answers', it->'answers', 'flags', it->'flags', 'comp', it->'comp', 'target', it->'target',
    'body', jsonb_build_object('weight', prof->'weight', 'height', prof->'height', 'age', prof->'age', 'sex', prof->'sex'),
    'calc', app.nut_calc(prof, today), 'plan', case when r.id is null then null else app.nut_plan_obj(r) end,
    'weighins', (select coalesce(jsonb_agg(x order by i), '[]') from jsonb_array_elements(app.nut_weighins(cu)) with ordinality t(x, i) where i > jsonb_array_length(app.nut_weighins(cu)) - 26),
    'paid', app.nut_paid(cu), 'questions', app.nut_questions());
end $$;

-- action app_nut_decide { cid, id, act: approve | note | regen | decline, note, kcal/p/c/f } (nutDecide_)
create or replace function public.api_app_nut_decide(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant', 'trainer']); cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); r public.nutrition_plans;
  act text := coalesce(p->>'act', ''); note text := app.clean(p->'note', 500); jnote text := app.clean_json(p->'note', 500); m jsonb; k text; v float8; it jsonb; lid text;
begin
  if not app.nut_can_see(me, cu) then raise exception 'This client is not one of yours'; end if;
  select * into r from public.nutrition_plans where client_id = cu and legacy_id = coalesce(p->>'id', '') for update;
  if r.id is null then raise exception 'Plan not found, refresh'; end if;
  if act = 'approve' then
    if r.status <> 'Pending' then raise exception 'Only a plan waiting for a coach can be approved (this one is %).', r.status; end if;
    if r.plan is null then raise exception 'This plan has no meals yet'; end if;
    update public.nutrition_plans set status = 'Approved', by_who = me->>'name', decided_at = now(), coach_note = coalesce(nullif(note, ''), coach_note) where id = r.id;
    perform app.nut_close_req(r.legacy_id, me->>'name', 'Done');
  elsif act = 'decline' then
    update public.nutrition_plans set status = 'Declined', by_who = me->>'name', decided_at = now(), coach_note = note where id = r.id;
    perform app.nut_close_req(r.legacy_id, me->>'name', 'Declined');
  elsif act = 'note' then
    update public.nutrition_plans set coach_note = note where id = r.id;
  elsif act = 'regen' then
    m := coalesce(r.macros, '{}');
    foreach k in array array['kcal', 'p', 'c', 'f'] loop
      v := app.js_num(p->k);
      if v > 0 then m := m || jsonb_build_object(k, app.jr(v)); end if;
    end loop;
    if (m->>'kcal')::float8 < 900 then raise exception 'Calories too low'; end if;
    it := app.nut_intake(cu);
    if note <> '' then it := jsonb_set(it, '{answers,coach_note}', to_jsonb(jnote)); end if;
    perform app.nut_save_intake(cu, it);
    perform app.nut_close_req(r.legacy_id, me->>'name', 'Done');
    lid := app.nut_new_plan(cu, 'Queued', m, it, coalesce(r.weight_at_plan::float8, 0), me->>'name');
    return jsonb_build_object('id', lid, 'status', 'Queued');
  else
    raise exception 'Unknown action';
  end if;
  return jsonb_build_object('id', r.legacy_id, 'status', (select status from public.nutrition_plans where id = r.id));
end $$;

-- ---------------------------------------------------------------------
-- LANDING PAGE (Code.gs): slots, lead, answers, booking. No sign in.
-- ---------------------------------------------------------------------
create or replace function app.phone_key(t text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '^00', ''), '^961', ''), '^0', '')
$$;
create or replace function app.email_ok(e text) returns boolean language sql immutable as $$
  select e <> '' and length(e) <= 120 and e !~ '^[=+\-@]' and position('..' in e) = 0
     and e ~ '^[a-z0-9]([a-z0-9._%+\-]*[a-z0-9_\-])?@[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,24}$'
$$;
-- '8:00 AM', '08:30', '4 pm' -> hour (toHour_)
create or replace function app.to_hour(s text) returns int language plpgsql immutable as $$
declare m text[]; hr int; ap text;
begin
  m := regexp_match(app.js_trim(s), '^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?', 'i');
  if m is null then return null; end if;
  hr := m[1]::int; ap := lower(coalesce(m[3], ''));
  if left(ap, 1) = 'p' and hr < 12 then hr := hr + 12; end if;
  if left(ap, 1) = 'a' and hr = 12 then hr := 0; end if;
  return hr;
end $$;
create or replace function app.hour_label(hr int) returns text language sql immutable as $$
  select case when hr is null then '' else (case when hr % 12 = 0 then 12 else hr % 12 end) || ':00 ' || case when hr < 12 then 'AM' else 'PM' end end
$$;
-- open trial hours (getSlots_): the trial trainer's clients in 1:1 + 1:2 + 1:3 + Pending landing page bookings, max = their max per hour.
-- instant = room and no 1:1 / 1:2 client at that hour; full = no room. No spot counts are sent.
create or replace function app.trial_slots() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare tz text := coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'); t0 timestamptz := now(); tr text; cap int;
  ahead int := app.setting_int('{windows,trialAhead}', 7); notice int := app.setting_int('{windows,trialNoticeH}', 12);
  days jsonb := '[]'; slots jsonb; i int; d date; dow int; hr int; k_all int; k_13 int; pend int;
begin
  select s.trainer, s.cap into tr, cap from public.staff s where s.id = app.setting('{trial,trainer}') #>> '{}';
  cap := coalesce(nullif(cap, 0), (app.setting('{services,1:3,cap}'))::text::int);
  for i in 0 .. ahead loop
    d := ((t0 + make_interval(secs => i * 86400)) at time zone tz)::date;
    dow := extract(isodow from d)::int;
    continue when not coalesce(app.setting('{hours,trialDays}') @> to_jsonb(dow), false) or coalesce(app.setting('{hours,blocked}'), '[]') @> to_jsonb(d::text);
    slots := '[]';
    for hr in select (x #>> '{}')::int from jsonb_array_elements(app.setting('{hours,trial}')) with ordinality t(x, o) order by o loop
      continue when ((d + make_interval(hours => hr)) at time zone tz) - t0 < make_interval(hours => notice);
      select coalesce(sum(n), 0), coalesce(sum(n) filter (where kind = '1:3'), 0) into k_all, k_13 from (
        select s.kind, (select count(*) from public.session_clients sc where sc.session_id = s.id) as n from public.sessions s
         where coalesce(tr, '') <> '' and s.trainer = tr and s.kind in ('1:1', '1:2', '1:3') and s.day = d and extract(hour from s.start_time) = hr and s.status !~* 'cancel') z;
      select count(*) into pend from public.leads where status = 'Pending' and trial_date = d and app.to_hour(trial_time) = hr;
      slots := slots || jsonb_build_array(jsonb_build_object('hour', hr, 'type', case when greatest(0, cap - k_all - pend) = 0 or k_all - k_13 > 0 then 'full' else 'instant' end));
    end loop;
    if jsonb_array_length(slots) > 0 then days := days || jsonb_build_array(jsonb_build_object('date', d, 'dow', dow, 'slots', slots)); end if;
  end loop;
  return jsonb_build_object('days', days, 'cap', cap);
end $$;
-- saveLead_: the same phone + same person (email, or name when one has no email) is the same lead
create or replace function app.lead_save(b jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare nm text := app.clean(b->'name', 80); ph text := app.clean(b->'phone', 30); em text := lower(app.js_trim(case when app.truthy(b->'email') then b->>'email' else '' end));
  ex public.leads; lid text; src text := app.clean(b->'source', 200);
begin
  if nm = '' or length(app.phone_key(ph)) < 7 then raise exception 'Please enter your name and a valid phone number.'; end if;
  if em <> '' and not app.email_ok(em) then raise exception 'Please check your email.'; end if;
  perform pg_advisory_xact_lock(hashtext('leads'));
  select * into ex from public.leads l where app.phone_key(l.phone) = app.phone_key(ph)
     and case when coalesce(lower(app.js_trim(l.email)), '') <> '' and em <> '' then lower(app.js_trim(l.email)) = em
              else lower(app.js_trim(l.name)) = lower(app.js_trim(nm)) end
   order by l.submitted_at desc, l.seq desc limit 1;
  if ex.id is not null then
    return jsonb_build_object('leadId', ex.legacy_id, 'booked', ex.status in ('Pending', 'Confirmed'), 'date', coalesce(ex.trial_date::text, ''), 'time', coalesce(ex.trial_time, ''), 'type', coalesce(ex.booking_type, ''));
  end if;
  lid := 'W40-' || to_char(now() at time zone 'Asia/Beirut', 'YYMMDD') || '-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
  insert into public.leads (legacy_id, name, phone, email, trained_before, stopped, why_now, injuries, trial_time, booking_type, status, called, notes, source)
  values (lid, nm, app.phone_norm(ph), nullif(em, ''), app.clean(b->'trained', 120), app.clean(b->'stopped', 400), app.clean(b->'why', 400), app.clean(b->'injuries', 400),
          '', '', 'No Booking', 'N', '', src);
  perform app.alert_all('NEW W40 LEAD' || E'\n' || nm || E'\n' || ph || E'\n' || em || case when src ~ 'by=' then E'\nInvited by a friend' else '' end
    || E'\n(answers + booking may follow, call if nothing within 15 min)');
  return jsonb_build_object('leadId', lid, 'booked', false);
end $$;
-- book_: a trial hour for a lead (the slot must still be open)
create or replace function app.lead_book(b jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.leads; hr float8 := app.js_num(b->'hour'); dt text := coalesce(b->>'date', ''); slot jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('leads'));
  select * into l from public.leads where legacy_id = b->>'leadId' for update;
  if l.id is null then raise exception 'We could not find your details. Please submit the form again.'; end if;
  if l.status in ('Pending', 'Confirmed') then
    raise exception 'You already have a trial booked: % at %.', coalesce(l.trial_date::text, ''), app.hour_label(app.to_hour(l.trial_time)) using detail = '{"already":true}';
  end if;
  select s into slot from jsonb_array_elements(app.trial_slots()->'days') x, jsonb_array_elements(x->'slots') s where x->>'date' = dt and (s->>'hour')::float8 = hr limit 1;
  if slot is null then raise exception 'That time is no longer available. Please pick another.'; end if;
  if slot->>'type' = 'full' then raise exception 'That session just filled up. Please pick another time.' using detail = '{"full":true}'; end if;
  update public.leads set trial_date = dt::date, trial_time = app.hour_label(hr::int), booking_type = 'Instant', status = 'Pending' where id = l.id;
  perform app.alert_all('W40 TRIAL BOOKED (INSTANT)' || E'\n' || coalesce(l.name, '') || E'\n' || coalesce(l.phone, '') || E'\n' || dt || ' at ' || app.hour_label(hr::int)
    || E'\nTrained: ' || coalesce(l.trained_before, '') || E'\nStopped: ' || coalesce(l.stopped, '') || E'\nWhy now: ' || coalesce(l.why_now, '') || E'\nInjuries: ' || coalesce(l.injuries, '')
    || E'\nWhatsApp her within 24h, then set Status = Confirmed (auto adds her to SESSIONS 1:3).');
  return jsonb_build_object('type', 'Instant', 'date', b->'date', 'hour', hr);
end $$;
-- landing page: GET slots
create or replace function public.api_slots(p jsonb) returns jsonb language sql security definer set search_path = public as $$ select app.trial_slots() $$;
-- landing page: the form (name, phone, email, answers, source)
create or replace function public.api_lead(p jsonb) returns jsonb language sql security definer set search_path = public as $$ select app.lead_save(p) $$;
-- landing page: screens 2 to 5, the 4 answers onto the lead
create or replace function public.api_answers(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.leads set trained_before = app.clean(p->'trained', 120), stopped = app.clean(p->'stopped', 400), why_now = app.clean(p->'why', 400), injuries = app.clean(p->'injuries', 400)
   where legacy_id = p->>'leadId';
  if not found then raise exception 'We could not find your details. Please start again.'; end if;
  return '{}'::jsonb;
end $$;
-- landing page: book a trial hour {leadId, date, hour}
create or replace function public.api_book(p jsonb) returns jsonb language sql security definer set search_path = public as $$ select app.lead_book(p) $$;
-- ad leads still to call, 15 min / 24 h / 72 h, night leads counted from quietTo (App.gs appLeadFollowups_; 'row' is the legacy ID now)
create or replace function app.lead_followups_json() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.legacy_id, 'row', f.legacy_id, 'name', coalesce(f.name, ''), 'phone', coalesce(f.phone, ''), 'stage', f.stage, 'status', f.status,
      'submitted', to_char(f.submitted_at at time zone 'Asia/Beirut', 'YYYY-MM-DD HH24:MI'), 'date', coalesce(f.trial_date::text, ''), 'time', coalesce(f.trial_time, ''))
      order by f.submitted_at), '[]'::jsonb)
    from public.lead_followups f
$$;

-- ---------------------------------------------------------------------
-- GUESTS (Guest.gs): action app_cl_guest  op: trial {date, hour, phone} | call {phone, note} | pkg {pkg, phone}
-- ---------------------------------------------------------------------
create or replace function public.api_app_cl_guest(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; g public.clients; ph text; lid text; r jsonb; asked jsonb; op text := coalesce(p->>'op', '');
  today text := app_today()::text; out jsonb := '{}'; ty public.package_types; nt text; stamp text := to_char(now() at time zone 'Asia/Beirut', 'DD/MM HH24:MI');
begin
  me := app.need_client(cu);
  select * into g from public.clients where id = cu for update;
  if g.kind <> 'guest' then raise exception 'unknown action'; end if;
  ph := app.clean(case when app.truthy(p->'phone') then p->'phone' else to_jsonb(coalesce(g.phone, '')) end, 30);
  if length(app.phone_key(ph)) < 7 then raise exception 'Type your WhatsApp number so % can confirm.', app.desk_name(); end if;
  if app.phone_norm(ph) is distinct from g.phone then update public.clients set phone = app.phone_norm(ph) where id = cu; end if;
  select legacy_id into lid from public.leads where id = g.lead_id;
  if lid is null then
    r := app.lead_save(jsonb_build_object('name', g.name, 'phone', ph, 'email', coalesce(g.email, ''), 'source', 'Client app'));
    lid := r->>'leadId';
    update public.clients set lead_id = (select id from public.leads where legacy_id = lid) where id = cu;
  end if;
  asked := coalesce(g.guest_asked, '{}');
  if op = 'trial' then
    r := app.lead_book(jsonb_build_object('leadId', lid, 'date', coalesce(p->>'date', ''), 'hour', p->'hour'));
    out := jsonb_build_object('trial', jsonb_build_object('date', r->'date', 'time', app.hour_label((r->>'hour')::int), 'status', 'Pending'));
  elsif op = 'call' then
    if asked->>'call' = today then raise exception 'Your call request is in. The coach will WhatsApp you soon.'; end if;
    nt := case when app.truthy(p->'note') then ' (' || app.clean(p->'note', 200) || ')' else '' end;
    update public.leads set notes = app.append_note(notes, 'Client app: wants a free 15 min coach call' || nt || ' ' || stamp) where legacy_id = lid;
    perform app.alert_all('APP: FREE COACH CALL REQUEST' || E'\n' || g.name || E'\n' || ph || E'\n' || coalesce(g.email, '')
      || case when app.truthy(p->'note') then E'\nGoal: ' || app.clean(p->'note', 200) else '' end || E'\nWhatsApp them within the hour.');
    asked := asked || jsonb_build_object('call', today);
  elsif op = 'pkg' then
    select * into ty from public.package_types where active and name = p->>'pkg' order by sort limit 1;
    if ty.id is null then raise exception 'Pick a package.'; end if;
    update public.leads set notes = app.append_note(notes, 'Client app: wants ' || ty.name || ', pays at the center ' || stamp) where legacy_id = lid;
    perform app.alert_all('APP: PACKAGE REQUEST' || E'\n' || g.name || E'\n' || ph || E'\n' || coalesce(g.email, '') || E'\nWants: ' || ty.name
      || E'\nWhatsApp them to set the start date. They pay at the center.\nUse this email when you add them, so their app turns into the client app.');
    asked := asked || jsonb_build_object('pkg', ty.name, 'pkgDate', today);
  else
    raise exception 'unknown';
  end if;
  update public.clients set guest_asked = asked where id = cu;
  return out || jsonb_build_object('asked', asked);
end $$;
-- a guest who now has a client row: game, streak and promise move to the client (once) (guestConvert_)
create or replace function app.guest_convert(p_guest uuid, p_client uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_guest is null or p_client is null or (select converted_to from public.clients where id = p_guest) is not null then return; end if;
  if not exists (select 1 from public.game_players where client_id = p_client) then update public.game_players set client_id = p_client where client_id = p_guest; end if;
  if not exists (select 1 from public.streaks where client_id = p_client) then update public.streaks set client_id = p_client where client_id = p_guest; end if;
  if not exists (select 1 from public.client_goals where client_id = p_client) then update public.client_goals set client_id = p_client where client_id = p_guest; end if;
  update public.clients set converted_to = p_client where id = p_guest;
end $$;

-- ---------------------------------------------------------------------
-- GAME (RunGame.gs clRun_ + Levels.gs): action app_cl_run  op: get | save | buy | shop | redeem
-- ---------------------------------------------------------------------
-- what the phone needs for the level bar, the shop and the powers (lvOut_); the shop in its settings order (free level)
create or replace function app.lv_out(xp bigint, owned jsonb) returns jsonb language sql stable as $$
  with lv as (select app.lv_of(xp) as v),
       sh as (select e.key as k, e.value as s, case when e.value->>'kind' = 'ticket' then to_jsonb(app.n0(owned->e.key))
                                                   else to_jsonb(app.lv_has(owned, ((select v from lv)->>'level')::int, e.key)) end as hv
                from jsonb_each(app.setting('{game,shop}')) e)
  select jsonb_build_object('xp', v->'total', 'level', v->'level', 'into', v->'into', 'need', v->'need', 'max', app.setting('{game,levelMax}'),
    'have', (select coalesce(jsonb_object_agg(k, hv), '{}') from sh),
    'shop', (select coalesce(jsonb_agg(jsonb_build_object('k', k, 'n', s->'n', 'coins', s->'coins', 'lv', s->'lv', 'kind', s->'kind', 'have', hv) order by (s->>'lv')::int, k), '[]') from sh),
    'badge', (v->>'level')::int >= app.setting_int('{game,badgeLv}', 50))
  from lv
$$;
create or replace function public.api_app_cl_run(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; op text := coalesce(nullif(p->>'op', ''), 'get'); out jsonb := '{"newBadges":[],"mdone":[]}';
  g public.game_players; hide boolean; item text; lvl int; cost int; ups jsonb; trx0 boolean; r jsonb; today date := app_today(); pend int; ms jsonb;
  cash jsonb := app.setting('{game,cash}'); rules jsonb := app.setting('{game_rules}'); upcost jsonb := app.setting('{game,upCost}');
  lifecost int := app.setting_int('{game,lifeCost}', 1000); lifemax int := app.setting_int('{game,lifeMax}', 3); boards jsonb;
begin
  me := app.need_client(cu);
  if jsonb_typeof(p->'lbHide') is not null and jsonb_typeof(p->'lbHide') <> 'null' then
    hide := p->'lbHide' in ('true'::jsonb, '1'::jsonb, '"1"'::jsonb, '"true"'::jsonb);
  end if;
  perform app.game_touch(cu);
  select * into g from public.game_players where client_id = cu for update;
  if hide is not null and coalesce((g.owned->>'lbHide')::boolean, false) = hide then hide := null; end if;     -- only a change is written
  if op = 'save' then
    trx0 := coalesce((g.missions->>'trx')::int, 0) = 1;
    r := public.game_save_run(cu, coalesce(p->'run', '{}'), hide);
    out := out || (r - array['coins', 'best', 'bestM', 'runs', 'cash', 'lv', 'boards', 'rank']);
    if not trx0 and (select coalesce((missions->>'trx')::int, 0) = 1 from public.game_players where client_id = cu) then
      out := out || jsonb_build_object('trainedXp', (rules->'xp'->>'TRAINED')::int);
    end if;
    hide := null;
  elsif op = 'shop' then
    out := out || jsonb_build_object('bought', public.game_shop(cu, coalesce(p->>'item', ''))->'bought');
  elsif op = 'buy' then
    item := coalesce(p->>'item', ''); ups := g.upgrades;
    if item = 'life' then
      if app.n0(ups->'life') >= lifemax then raise exception 'You already have % extra lives', lifemax; end if;
      if g.coins < lifecost then raise exception 'Not enough coins'; end if;
      update public.game_players set coins = coins - lifecost, upgrades = upgrades || jsonb_build_object('life', app.n0(ups->'life') + 1) where client_id = cu;
      insert into public.coin_ledger (client_id, delta, reason) values (cu, -lifecost, 'Extra life');
    else
      if item not in ('magnet', 'jet', 'shoes') then raise exception 'Unknown upgrade'; end if;
      lvl := app.n0(ups->item)::int;
      if lvl >= jsonb_array_length(upcost) then raise exception 'Already maxed'; end if;
      cost := (upcost->>lvl)::int;
      if g.coins < cost then raise exception 'Not enough coins'; end if;
      update public.game_players set coins = coins - cost, upgrades = upgrades || jsonb_build_object(item, lvl + 1) where client_id = cu;
      insert into public.coin_ledger (client_id, delta, reason) values (cu, -cost, 'Upgrade: ' || item);
    end if;
  elsif op = 'redeem' then
    out := out || public.game_redeem(cu);
  end if;
  if op in ('get', 'save') and hide is not null then update public.game_players set owned = owned || jsonb_build_object('lbHide', hide) where client_id = cu; end if;
  -- every op answers with the whole game screen
  select * into g from public.game_players where client_id = cu;
  ms := g.missions; ups := g.upgrades; boards := app.boards(cu);
  select coalesce(sum((data->>'cents')::int), 0) into pend from public.client_requests where client_id = cu and type = 'Game cash' and status = 'New';
  return out || jsonb_build_object('coins', g.coins, 'best', g.best_score, 'bestM', g.best_m, 'runs', g.runs,
    'up', jsonb_build_object('magnet', to_jsonb(app.n0(ups->'magnet')), 'jet', to_jsonb(app.n0(ups->'jet')), 'shoes', to_jsonb(app.n0(ups->'shoes')), 'life', to_jsonb(app.n0(ups->'life'))),
    'upCost', upcost, 'lifeCost', lifecost, 'lifeMax', lifemax,
    'cash', jsonb_build_object('bal', g.credit_cents, 'total', g.credit_earned_cents, 'today', coalesce((ms->>'cash')::int, 0), 'minM', cash->'MIN_M', 'cents', cash->'CENTS',
      'dayMax', cash->'DAY_MAX', 'min', cash->'REDEEM_MIN', 'max', cash->'REDEEM_MAX', 'trained', true, 'pending', pend),
    'missions', (select coalesce(jsonb_agg(jsonb_build_object('k', mi->'k', 't', mi->'t', 'n', mi->'n', 'p', least((mi->>'n')::numeric, app.n0(ms->'st'->(mi->>'k'))::numeric),
        'done', coalesce(ms->'done', '[]') ? (mi->>'k'), 'r', mi->'r', 's', mi->'s', 'm', mi->'m') order by i), '[]')
      from jsonb_array_elements(app.missions_today(today)) with ordinality t(mi, i)),
    'allBonus', rules->'allBonus', 'bonusDone', app.truthy(ms->'bonus'), 'word', app.n0(ms->'wl'), 'wordBonus', coalesce(rules->'wordBonus', '1000'::jsonb),
    'badges', (select coalesce(jsonb_agg(jsonb_build_object('id', bid, 't', rules->'badges'->bid) order by i), '[]') from jsonb_array_elements_text(g.badges) with ordinality t(bid, i)),
    'boost', app.trained_on(cu, today - 1, today), 'boards', boards->'lists', 'rank', boards->'rank', 'lv', app.lv_out(g.xp, g.owned),
    'lbHide', coalesce((g.owned->>'lbHide')::boolean, false));
end $$;

-- ---------------------------------------------------------------------
-- STREAK (Streak.gs): action app_cl_streak { cid } reads, { cid, keys:[b,b,b] } ticks today
-- ---------------------------------------------------------------------
create or replace function public.api_app_cl_streak(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; ks boolean[]; r jsonb;
begin
  me := app.need_client(cu);
  if app.truthy(p->'keys') then ks := array[app.truthy(p->'keys'->0), app.truthy(p->'keys'->1), app.truthy(p->'keys'->2)]; end if;
  r := public.streak_tick(cu, ks);
  if jsonb_typeof(r->'reward') = 'object' then
    r := jsonb_set(r, '{reward,pkg}', to_jsonb(coalesce((select k.legacy_id from public.streaks s join public.packages k on k.id = s.reward_pkg where s.client_id = cu), '')));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- PROMISE + 3 KEYS (Client.gs clGoal_): action app_cl_goal { cid, promise }
-- The edge function may ask the AI first and send aiKeys (3 short lines); otherwise the template keys.
-- ---------------------------------------------------------------------
create or replace function app.goal_template(pr text) returns text[] language sql stable as $$
  select case
    when lower(pr) ~ 'pain|back|knee|neck|shoulder|injur|hurt|hip|posture' then array['Do your 10 minute mobility routine every morning', 'Never skip two sessions in a row: steady training calms pain', 'Book your monthly physio check with ' || coalesce(app.fixed_trainer('Physio'), '')]
    when lower(pr) ~ 'weight|kg|kilo|fat|slim|lose|belly|shape|tone' then array['Train with us 3 times a week, every week', 'Put protein and vegetables on every plate', 'Walk 30 minutes on the days you don’t train']
    when lower(pr) ~ 'strong|strength|muscle|lift|power|fit' then array['Show up to every booked session, no excuses', 'Ask your coach each week what to push next', 'Sleep 7 hours: muscle is built while you rest']
    when lower(pr) ~ 'energy|tired|stress|sleep|mood|mind|confiden|happy' then array['Keep your Wellbe sessions as appointments with yourself', 'Be in bed at the same time every night', 'Drink water before your first coffee']
    when lower(pr) ~ 'run|marathon|sport|game|football|tennis|ski|hike' then array['Never skip strength day: it protects your joints', 'Warm up properly before every run or game', 'Tell your coach your next event so we plan for it']
    else array['Show up to every booked session, even on lazy days', 'Move 30 minutes on the days you don’t train', 'Sleep 7 hours and drink water before coffee'] end
$$;
create or replace function public.api_app_cl_goal(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; pr text; cnt int; ks text[]; madeby text := 'template'; upd timestamptz := now();
begin
  me := app.need_client(cu);
  pr := left(app.js_trim(regexp_replace(coalesce(case when app.truthy(p->'promise') then p->>'promise' end, ''), '[\r\n]+', ' ', 'g')), 240);
  if length(pr) < 4 then raise exception 'Write your promise first.'; end if;
  select n into cnt from public.goal_edits where client_id = cu and day = app_today();
  if coalesce(cnt, 0) >= 6 then raise exception 'You changed it a lot today. Try again tomorrow.'; end if;
  insert into public.goal_edits (client_id, day, n) values (cu, app_today(), 1) on conflict (client_id, day) do update set n = public.goal_edits.n + 1;
  select array_agg(left(app.js_trim(x), 120) order by i) into ks from jsonb_array_elements_text(app.arr(p->'aiKeys')) with ordinality t(x, i) where app.js_trim(x) <> '';
  if coalesce(array_length(ks, 1), 0) >= 3 then ks := ks[1:3]; madeby := 'AI'; else ks := app.goal_template(pr); end if;
  insert into public.client_goals (client_id, promise, key1, key2, key3, made_by, updated_at) values (cu, app.clean(to_jsonb(pr), 240), ks[1], ks[2], ks[3], madeby, upd)
  on conflict (client_id) do update set promise = excluded.promise, key1 = excluded.key1, key2 = excluded.key2, key3 = excluded.key3, made_by = excluded.made_by, updated_at = excluded.updated_at;
  return jsonb_build_object('goal', jsonb_build_object('promise', pr, 'keys', to_jsonb(ks), 'updated', app.stamp(upd)));
end $$;

-- ---------------------------------------------------------------------
-- PROFILE (Profile.gs): action app_cl_profile  op: photo {photo: data URL} | rate {stars 1-5, note}
-- The small photo is kept as sent (data URL) in client_photos.storage_path, which the boot returns as the photo.
-- ---------------------------------------------------------------------
create or replace function public.api_app_cl_profile(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; op text := coalesce(p->>'op', ''); nm text; ph text; st int; nt text;
begin
  me := app.need_client(cu);
  nm := coalesce((select name from public.clients where id = cu), upper(coalesce(p->>'cid', '')));
  if op = 'photo' then
    ph := case when app.truthy(p->'photo') then p->>'photo' else '' end;
    if ph <> '' and ph !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then raise exception 'Send a photo'; end if;
    if length(ph) > 45000 then raise exception 'Photo too big'; end if;
    insert into public.client_photos (client_id, storage_path, updated_at) values (cu, ph, now())
    on conflict (client_id) do update set storage_path = excluded.storage_path, updated_at = excluded.updated_at;
    return jsonb_build_object('photo', ph);
  end if;
  if op = 'rate' then
    st := greatest(1, least(5, app.jr(app.n0(p->'stars'))))::int; nt := app.clean(p->'note', 400);
    perform app.client_log(cu, nm, 'App rating', st || ' star' || case when st > 1 then 's' else '' end || case when nt <> '' then ' · ' || nt else '' end, '', null,
      case when st <= 3 then 'New' else 'Done' end, jsonb_build_object('stars', st));
    return jsonb_build_object('stars', st);
  end if;
  raise exception 'unknown';
end $$;

-- ---------------------------------------------------------------------
-- SESSION EDITOR (App.gs): app_sess_edit, app_sess_remove, app_notify. Owner and desk only.
-- A session is found by its ID (id, or ref '<kind>|<session ID>').
-- ---------------------------------------------------------------------
create or replace function app.sess_find(p jsonb) returns public.sessions language plpgsql stable security definer set search_path = public as $$
declare s public.sessions; sid text := coalesce(nullif(p->>'id', ''), nullif(split_part(coalesce(p->>'ref', ''), '|', 2), ''), '');
begin
  select * into s from public.sessions where legacy_id = sid;
  if s.id is null then raise exception 'Session % not found, refresh', sid; end if;
  return s;
end $$;
-- action app_sess_edit { ref, id, room?, pay? }: room of any session; payment only on physio / prehab
create or replace function public.api_app_sess_edit(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); s public.sessions := app.sess_find(p); chg text[] := '{}'; pays text[];
begin
  if app.truthy(p->'room') then
    if not exists (select 1 from jsonb_each(app.setting('{services}')) e where e.value->>'room' = p->>'room') then raise exception 'Unknown room: %', p->>'room'; end if;
    update public.sessions set room = p->>'room' where id = s.id; chg := chg || ('room ' || (p->>'room'));
  end if;
  if jsonb_typeof(p->'pay') is not null and jsonb_typeof(p->'pay') <> 'null' then
    if s.kind not in ('Physio', 'Prehab') then raise exception 'This session type has no payment column'; end if;
    select array_agg(x order by i) into pays from jsonb_array_elements_text(coalesce(app.setting('{lists,methods}'), '[]')) with ordinality t(x, i);
    pays := coalesce(pays, '{}');
    if not 'Insurance' = any(pays) then pays := pays || 'Insurance'::text; end if;
    if not 'Not paid' = any(pays) then pays := pays || 'Not paid'::text; end if;
    if not (p->>'pay') = any(pays) then raise exception 'Unknown payment: %', p->>'pay'; end if;
    update public.sessions set pay_source = p->>'pay' where id = s.id; chg := chg || ('payment ' || (p->>'pay'));
  end if;
  if array_length(chg, 1) > 0 then
    update public.sessions set note = app.append_note(note, 'Changed ' || array_to_string(chg, ', ') || ' via app, ' || (me->>'name')) where id = s.id;
  end if;
  return '{}'::jsonb;
end $$;
-- action app_sess_remove { ref, id, slot }: takes one client out of a session (no pass used); nobody left = Cancelled
create or replace function public.api_app_sess_remove(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); s public.sessions := app.sess_find(p); sl float8 := app.js_num(p->'slot'); sc public.session_clients; lft boolean; used int;
begin
  perform 1 from public.sessions where id = s.id for update;
  if sl is not null and sl = trunc(sl) then select * into sc from public.session_clients where session_id = s.id and slot = sl::int; end if;
  if sc.package_id is null then raise exception 'No client in that spot'; end if;
  delete from public.session_clients where session_id = s.id and slot = sc.slot;
  lft := exists (select 1 from public.session_clients where session_id = s.id);
  if not lft then update public.sessions set status = 'Cancelled' where id = s.id; end if;
  update public.sessions set note = app.append_note(note, btrim(sc.name) || ' removed from the session via app, ' || (me->>'name')) where id = s.id;
  used := app.recount(sc.package_id);
  return jsonb_build_object('pkg', (select legacy_id from public.packages where id = sc.package_id), 'used', used, 'cancelled', not lft);
end $$;
-- action app_notify { cids, type, text }: an in-app message to each client (shows until they tap Got it)
create or replace function public.api_app_notify(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); txt text := left(app.js_trim(coalesce(case when app.truthy(p->'text') then p->>'text' end, '')), 600);
  typ text := left(coalesce(case when app.truthy(p->'type') then p->>'type' end, 'Session update'), 60); n int := 0; x text; seen text[] := '{}'; cu uuid;
begin
  if txt = '' then raise exception 'Write the message first'; end if;
  for x in select upper(app.js_trim(e)) from jsonb_array_elements_text(app.arr(p->'cids')) with ordinality t(e, i) order by i loop
    continue when x !~ '^[CG]\d+$' or x = any(seen);
    seen := seen || x; cu := app.client_by_legacy(x);
    continue when cu is null;
    perform app.notice(cu, null, typ, txt); n := n + 1;
  end loop;
  if n = 0 then raise exception 'No client to notify'; end if;
  return jsonb_build_object('sent', n);
end $$;

-- ---------------------------------------------------------------------
-- who may call what: helpers are internal; the API functions are reached through public.wb_call (0008 app.api_sync)
-- ---------------------------------------------------------------------
revoke execute on all functions in schema app from public, anon;
do $$ declare f text; begin
  foreach f in array array['api_app_wo_list', 'api_app_wo_get', 'api_app_wo_save', 'api_app_wo_decide', 'api_app_wo_log', 'api_app_wo_ex', 'api_app_cl_wo',
    'api_app_cl_nut', 'api_app_nut_list', 'api_app_nut_get', 'api_app_nut_decide', 'api_slots', 'api_lead', 'api_answers', 'api_book', 'api_app_cl_guest',
    'api_app_cl_run', 'api_app_cl_streak', 'api_app_cl_goal', 'api_app_cl_profile', 'api_app_sess_edit', 'api_app_sess_remove', 'api_app_notify'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon, authenticated', f);
  end loop;
end $$;
