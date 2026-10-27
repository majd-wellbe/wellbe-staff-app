-- =====================================================================
-- 0013: in-app help (welcome tour, page tips) and the durable "Complete your profile" steps.
-- Same as Help.gs (Apps Script): action app_cl_profile with op
--   state                          -> {help, steps}
--   help       {help: patch}       -> {help, steps}   (merge rules in app.help_merge)
--   help_reset                     -> {help, steps}   every page tip shows again, tips mode on
--   steps      {met: ['photo',..]} -> {help, steps}   first time a step is met: {doneAt}; never removed
-- Additive: one new table, three helpers, api_app_cl_profile re-created with the old ops unchanged.
-- =====================================================================
create table if not exists public.client_app_state (                -- Help.gs: CLIENT APP STATE tab
  client_id  uuid primary key references public.clients(id) on delete cascade,
  help       jsonb not null default '{}'::jsonb,
  steps      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.client_app_state enable row level security;
drop policy if exists app_state_read on public.client_app_state;
create policy app_state_read on public.client_app_state for select using (app.can_see_client(client_id));

-- help state with only known fields (helpClean_)
create or replace function app.help_clean(h jsonb) returns jsonb language plpgsql immutable as $$
declare o jsonb; pg jsonb := '{}'::jsonb; k text; v jsonb; s text; n int := 0;
begin
  if h is null or jsonb_typeof(h) <> 'object' then h := '{}'::jsonb; end if;
  o := jsonb_build_object(
    'tips', case when jsonb_typeof(h->'tips') = 'boolean' then h->'tips' else 'null'::jsonb end,
    'asked', greatest(0, least(9, floor(case when jsonb_typeof(h->'asked') = 'number' then (h->>'asked')::numeric else 0 end)))::int,
    'tour', case when h->>'tour' in ('done', 'skipped') then h->>'tour' else '' end,
    'toast', case when coalesce(h->>'toast', '') in ('', '0', 'false', 'null') then 0 else 1 end);
  if jsonb_typeof(h->'pages') = 'object' then
    for k, v in select * from jsonb_each(h->'pages') loop
      exit when n >= 40;
      continue when k !~ '^[a-z][a-z_]{1,23}$' or jsonb_typeof(v) <> 'object';
      s := coalesce(v->>'s', '');
      if s in ('done', 'dismissed') then pg := pg || jsonb_build_object(k, jsonb_build_object('s', s));
      elsif s = 'prog' then pg := pg || jsonb_build_object(k, jsonb_build_object('s', 'prog', 'n',
        greatest(0, least(20, floor(case when jsonb_typeof(v->'n') = 'number' then (v->>'n')::numeric else 0 end)))::int));
      else continue; end if;
      n := n + 1;
    end loop;
  end if;
  return o || jsonb_build_object('pages', pg);
end $$;

-- patch onto saved state, never backwards (helpMerge_): done/dismissed pages stay, asked only grows, tour stays done
create or replace function app.help_merge(cur jsonb, patch jsonb) returns jsonb language plpgsql immutable as $$
declare c jsonb := app.help_clean(cur); p jsonb := app.help_clean(patch); k text; v jsonb; was jsonb;
begin
  if jsonb_typeof(patch->'tips') = 'boolean' then c := c || jsonb_build_object('tips', patch->'tips'); end if;
  c := c || jsonb_build_object('asked', greatest((c->>'asked')::int, (p->>'asked')::int));
  if p->>'tour' <> '' and c->>'tour' <> 'done' then c := c || jsonb_build_object('tour', p->>'tour'); end if;
  c := c || jsonb_build_object('toast', greatest((c->>'toast')::int, (p->>'toast')::int));
  for k, v in select * from jsonb_each(p->'pages') loop
    was := c->'pages'->k;
    continue when was is not null and was->>'s' in ('done', 'dismissed') and v->>'s' not in ('done', 'dismissed');
    continue when was is null and (select count(*) from jsonb_object_keys(c->'pages')) >= 40;
    c := jsonb_set(c, array['pages', k], v);
  end loop;
  return c;
end $$;

-- profile steps (stepsMerge_): known keys only, first doneAt kept, never removed
create or replace function app.steps_merge(cur jsonb, met jsonb, now_iso text) returns jsonb language plpgsql immutable as $$
declare o jsonb := '{}'::jsonb; k text; ks text[] := array['photo', 'promise', 'body', 'intake', 'run', 'credit'];
begin
  foreach k in array ks loop
    if coalesce(cur->k->>'doneAt', '') <> '' then o := o || jsonb_build_object(k, jsonb_build_object('doneAt', cur->k->>'doneAt')); end if;
  end loop;
  if jsonb_typeof(met) = 'array' then
    for k in select jsonb_array_elements_text(met) loop
      if k = any(ks) and not (o ? k) then o := o || jsonb_build_object(k, jsonb_build_object('doneAt', now_iso)); end if;
    end loop;
  end if;
  return o;
end $$;

-- ---------------------------------------------------------------------
-- PROFILE (Profile.gs + Help.gs): action app_cl_profile
--   op: photo {photo: data URL} | rate {stars 1-5, note} | state | help | help_reset | steps
-- ---------------------------------------------------------------------
create or replace function public.api_app_cl_profile(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb; op text := coalesce(p->>'op', ''); nm text; ph text; st int; nt text;
  r public.client_app_state; h jsonb; s jsonb;
begin
  me := app.need_client(cu);
  if op in ('state', 'help', 'help_reset', 'steps') then
    select * into r from public.client_app_state where client_id = cu;
    h := app.help_clean(coalesce(r.help, '{}'::jsonb)); s := app.steps_merge(coalesce(r.steps, '{}'::jsonb), '[]'::jsonb, '');
    if op = 'state' then return jsonb_build_object('help', h, 'steps', s); end if;
    if op = 'help' then h := app.help_merge(h, p->'help');
    elsif op = 'help_reset' then h := jsonb_set(h, '{pages}', '{}'::jsonb) || jsonb_build_object('tips', true);
    else s := app.steps_merge(s, p->'met', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')); end if;
    insert into public.client_app_state (client_id, help, steps, updated_at) values (cu, h, s, now())
    on conflict (client_id) do update set help = excluded.help, steps = excluded.steps, updated_at = excluded.updated_at;
    return jsonb_build_object('help', h, 'steps', s);
  end if;
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
revoke execute on function public.api_app_cl_profile(jsonb) from public, anon, authenticated;
revoke execute on function app.help_clean(jsonb), app.help_merge(jsonb, jsonb), app.steps_merge(jsonb, jsonb, text) from public, anon;
