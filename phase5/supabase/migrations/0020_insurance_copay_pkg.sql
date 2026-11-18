-- 0020: insurance copay (Insurance.gs 14 Nov, commit 54aa5b0) and packages sold on insurance (16 Nov, commit b0abba1).
-- Same rules as 1-apps-script/phase3/Insurance.gs:
--   insured client: session price + the % the client pays; the insurer pays the rest (rate = price x (100 - pct) / 100)
--   a package sold on insurance: insurer + client pays % kept per package (INSURANCE PACKAGES tab)
--   app_pkg_price edits price, passes, end date and the insurance of a sold package
--   client app: an insured client owes only their own share, on physio / prehab packages or on a package sold on insurance
-- No new actions (app.api_sync() at the end does no harm).

alter table public.insurance_clients add column if not exists price_cents integer not null default 0;
alter table public.insurance_clients add column if not exists client_pct numeric not null default 0;

create table if not exists public.insurance_packages (
  package_id uuid primary key references public.packages(id) on delete cascade,
  insurer text not null,
  client_pct numeric not null default 0,
  updated_at timestamptz not null default now(),
  by_who text,
  sheet_row integer
);
alter table public.insurance_packages enable row level security;
drop policy if exists insp_desk on public.insurance_packages;
create policy insp_desk on public.insurance_packages for all using (app.is_desk()) with check (app.is_desk());

-- staff boot: package ID -> { cid, insurer, pct } (insPkgs_). ids = the trainer's own clients, null = everyone.
create or replace function app.ins_pkgs_json(ids uuid[]) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_object_agg(k.legacy_id, jsonb_build_object('cid', c.legacy_id, 'insurer', ip.insurer, 'pct', ip.client_pct)), '{}'::jsonb)
  from public.insurance_packages ip join public.packages k on k.id = ip.package_id join public.clients c on c.id = k.client_id
  where k.legacy_id is not null and (ids is null or k.client_id = any(ids))
$$;

-- client boot, one package (insClientBoot_): e = the package as the client app gets it (id, kind, label, price, due)
create or replace function app.ins_pkg_view(e jsonb, cl uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare insurer text; pct numeric; price numeric := coalesce((e->>'price')::numeric, 0); paid numeric; mine numeric;
begin
  select ip.insurer, ip.client_pct into insurer, pct from public.insurance_packages ip join public.packages k on k.id = ip.package_id
    where k.legacy_id = e->>'id' and k.client_id = cl;
  if insurer is null then
    if not (coalesce(e->>'kind', '') || ' ' || coalesce(e->>'label', '')) ~* 'physio|prehab' then return e; end if;
    select i.insurer, case when i.price_cents > 0 then i.client_pct else 0 end into insurer, pct from public.insurance_clients i where i.client_id = cl;
    if insurer is null then return e; end if;
  end if;
  pct := coalesce(pct, 0);
  paid := price - coalesce((e->>'due')::numeric, 0);
  mine := round(price * pct) / 100;
  return e || jsonb_build_object('ins', insurer, 'insPct', trim_scale(pct), 'insMine', trim_scale(mine), 'due', trim_scale(greatest(0, round((mine - paid) * 100) / 100)));
end $$;

-- app_ins_set: { cid, name, insurer ('' = no longer insured), member, notes, price (session price), pct (client pays %) }
create or replace function public.api_app_ins_set(p jsonb) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare me jsonb := app.need(array['owner', 'assistant']); cl uuid := app.ops_cid(p->>'cid'); ins text := app.ops_clean(p->>'insurer', 60);
  price numeric := round(coalesce(app.ops_num(p->'price'), 0) * 100) / 100;
  pct numeric := least(100, greatest(0, coalesce(app.ops_num(p->'pct'), 0)));
  rate numeric;
begin
  if cl is null then raise exception 'Client % not found', upper(coalesce(p->>'cid', '')); end if;
  if price < 0 then raise exception 'Session price missing'; end if;
  rate := case when price > 0 then round(price * (100 - pct)) / 100
               else coalesce(nullif(app.ops_num(p->'rate'), 0), (app.setting('{insurance,rate}') #>> '{}')::numeric) end;
  if ins = '' then delete from public.insurance_clients where client_id = cl; return '{}'; end if;
  insert into public.insurance_clients (client_id, insurer, member_number, notes, rate_cents, price_cents, client_pct, updated_at, by_who)
  values (cl, ins, app.ops_clean(p->>'member', 60), app.ops_clean(p->>'notes', 300), round(rate * 100), round(price * 100), case when price > 0 then pct else 0 end, now(), me->>'name')
  on conflict (client_id) do update set insurer = excluded.insurer, member_number = excluded.member_number, notes = excluded.notes,
    rate_cents = excluded.rate_cents, price_cents = excluded.price_cents, client_pct = excluded.client_pct, updated_at = now(), by_who = excluded.by_who;
  return '{}';
end $$;

-- app_pkg_price: edit a sold package. Any of: { pkg, price, passes, expiry (yyyy-mm-dd), ins: { insurer, pct } (insurer '' = not insured) }
create or replace function public.api_app_pkg_price(p jsonb) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare me jsonb := app.need(array['owner', 'assistant']); k public.packages; log text[] := '{}';
  price numeric; total int; np numeric; nt int; ed date; st text; ty public.package_types; lst numeric;
  today date := (now() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'))::date;
  ins text; pct numeric;
begin
  select * into k from public.packages where id = app.ops_pkg(p->>'pkg') for update;
  if k.id is null then raise exception 'Package % not found', coalesce(p->>'pkg', ''); end if;
  price := k.price_cents / 100.0; total := k.passes; st := k.status;
  if p ? 'price' and jsonb_typeof(p->'price') <> 'null' and coalesce(p->>'price', '') <> '' then
    np := round(app.ops_num(p->'price') * 100) / 100;
    if not coalesce(np >= 0, false) then raise exception 'Price missing'; end if;
    if np <> price then log := log || ('Price $' || app.jsnum(price) || ' -> $' || app.jsnum(np)); price := np; end if;
  end if;
  if p ? 'passes' and jsonb_typeof(p->'passes') <> 'null' and coalesce(p->>'passes', '') <> '' then
    nt := round(app.ops_num(p->'passes'));
    if not coalesce(nt >= 1, false) or nt > 200 then raise exception 'Passes must be 1 to 200'; end if;
    if nt < k.used then raise exception '% sessions are already used on it: passes can''t go below %', k.used, k.used; end if;
    if nt <> total then
      log := log || ('Passes ' || total || ' -> ' || nt); total := nt;
      if k.status ~* 'complete' and total > k.used then st := 'Active'; end if;
    end if;
  end if;
  if coalesce(p->>'expiry', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    ed := (p->>'expiry')::date;
    log := log || ('Ends ' || to_char(ed, 'DD/MM/YYYY'));
    if k.status = 'Expired' and ed > today then st := 'Active'; end if;   -- the script compares midnight of that day with now
  end if;
  update public.packages set price_cents = round(price * 100), passes = total, status = st,
    expiry_date = coalesce(ed, expiry_date), effective_expiry = coalesce(ed, effective_expiry) where id = k.id;
  -- discount follows: list price of the type, scaled to the passes (kept as a percent here, a fraction in the sheet)
  select * into ty from public.package_types t where t.name = k.type_name and t.active is not false limit 1;
  if ty.price_cents > 0 and ty.passes > 0 then
    lst := ty.price_cents / 100.0 * total / ty.passes;
    update public.packages set discount_pct = greatest(0, round((1 - price / lst) * 10000) / 100) where id = k.id;
  end if;
  if jsonb_typeof(p->'ins') = 'object' then
    ins := app.ops_clean(p->'ins'->>'insurer', 60);
    pct := least(100, greatest(0, coalesce(app.ops_num(p->'ins'->'pct'), 0)));
    if ins <> '' then
      insert into public.insurance_packages (package_id, insurer, client_pct, updated_at, by_who) values (k.id, ins, pct, now(), me->>'name')
      on conflict (package_id) do update set insurer = excluded.insurer, client_pct = excluded.client_pct, updated_at = now(), by_who = excluded.by_who;
      log := log || ('Insurance ' || ins || ', client pays ' || app.jsnum(coalesce(app.ops_num(p->'ins'->'pct'), 0)) || '%');
    else
      delete from public.insurance_packages where package_id = k.id;
      log := log || 'Not on insurance'::text;
    end if;
  end if;
  if array_length(log, 1) > 0 then
    update public.packages set note = app.append_note(note, array_to_string(log, ', ') || ' ' || app.ddmm() || ' (' || (me->>'name') || ')') where id = k.id;
  end if;
  return jsonb_build_object('price', trim_scale(price), 'passes', total);
end $$;

-- staff boot and client boot: change only the insurance lines of the live functions (each old line must be there exactly once)
do $$
declare d text; n int;
begin
  -- ---- api_app_boot ----
  select pg_get_functiondef('public.api_app_boot(jsonb)'::regprocedure) into d;
  if position('app.ins_pkgs_json' in d) = 0 then
    n := (length(d) - length(replace(d, $a$'claims', '[]'::jsonb));$a$, ''))) / length($a$'claims', '[]'::jsonb));$a$);
    if n <> 1 then raise exception '0020: trainer insurance line found % times in api_app_boot', n; end if;
    d := replace(d, $a$'claims', '[]'::jsonb));$a$, $a$'claims', '[]'::jsonb, 'pkgs', app.ins_pkgs_json(ids)));$a$);

    n := (length(d) - length(replace(d, $a$'rate', coalesce(case when i.rate_cents > 0 then app.usd(i.rate_cents) end, (app.setting('{insurance,rate}'))::text::numeric))$a$, '')))
         / length($a$'rate', coalesce(case when i.rate_cents > 0 then app.usd(i.rate_cents) end, (app.setting('{insurance,rate}'))::text::numeric))$a$);
    if n <> 1 then raise exception '0020: rate line found % times in api_app_boot', n; end if;
    d := replace(d, $a$'rate', coalesce(case when i.rate_cents > 0 then app.usd(i.rate_cents) end, (app.setting('{insurance,rate}'))::text::numeric))$a$,
      $a$'rate', case when i.price_cents > 0 then trim_scale(round(i.price_cents / 100.0 * (100 - i.client_pct)) / 100)
                              else coalesce(case when i.rate_cents > 0 then app.usd(i.rate_cents) end, (app.setting('{insurance,rate}'))::text::numeric) end,
                    'price', app.usd(i.price_cents), 'pct', case when i.price_cents > 0 then trim_scale(i.client_pct) else 0 end)$a$);

    n := (length(d) - length(replace(d, $a$from public.insurance_claims k join public.clients c2 on c2.id = k.client_id)));$a$, '')))
         / length($a$from public.insurance_claims k join public.clients c2 on c2.id = k.client_id)));$a$);
    if n <> 1 then raise exception '0020: claims line found % times in api_app_boot', n; end if;
    d := replace(d, $a$from public.insurance_claims k join public.clients c2 on c2.id = k.client_id)));$a$,
      $a$from public.insurance_claims k join public.clients c2 on c2.id = k.client_id),
      'pkgs', app.ins_pkgs_json(null)));$a$);
    execute d;
  end if;

  -- ---- api_app_cl_boot ----
  select pg_get_functiondef('public.api_app_cl_boot(jsonb)'::regprocedure) into d;
  if position('app.ins_pkg_view' in d) = 0 then
    n := (length(d) - length(replace(d, $a$acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(e || jsonb_build_object('due', 0, 'ins', ins.insurer) order by n), '[]') from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));$a$, '')))
         / length($a$acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(e || jsonb_build_object('due', 0, 'ins', ins.insurer) order by n), '[]') from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));$a$);
    if n <> 1 then raise exception '0020: insured due line found % times in api_app_cl_boot', n; end if;
    d := replace(d, $a$acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(e || jsonb_build_object('due', 0, 'ins', ins.insurer) order by n), '[]') from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));$a$, 'null;');

    n := (length(d) - length(replace(d, $a$select storage_path into photo from public.client_photos where client_id = a.id;$a$, '')))
         / length($a$select storage_path into photo from public.client_photos where client_id = a.id;$a$);
    if n <> 1 then raise exception '0020: photo line found % times in api_app_cl_boot', n; end if;
    d := replace(d, $a$select storage_path into photo from public.client_photos where client_id = a.id;$a$,
      $a$-- 0020: the client's own share on insured packages (Insurance.gs insClientBoot_, 14 and 16 Nov)
    acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(app.ins_pkg_view(e, a.id) order by n), '[]') from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));
    select storage_path into photo from public.client_photos where client_id = a.id;$a$);
    execute d;
  end if;
end $$;

revoke all on function app.ins_pkgs_json(uuid[]) from public, anon, authenticated;
revoke all on function app.ins_pkg_view(jsonb, uuid) from public, anon, authenticated;

select app.api_sync();
