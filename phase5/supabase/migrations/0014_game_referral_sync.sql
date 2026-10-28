-- =====================================================================
-- WELLBE on Supabase: 0014 game + referral sync with the Apps Script (1-apps-script/phase3, 28 Oct 2026)
-- Ports what the Apps Script got after commit 77d1f1d (last game alignment):
--   1a896a5 / eebc581 / 945afa9 / d38b006 / a678200  RunGame.gs, Levels.gs, Config.gs (game)
--     * Stats column (V): badge ladder totals (j, s, cb, mi, w, td), 5:30 AM Club runs (am), runner name (nm)
--     * 12 badge ladders x 5 tiers (RUN.LADDERS), old badge ids kept and mapped (RUN.OLD_MAP), badgeCount
--     * save: breakdown {picked, boost, missions, allBonus, wellbe, total}, cause of the end of the run (Last run cell)
--     * runner outfits (game.outfits): free | coins | staff | physio | early (game.earlyHour, game.earlyMinM) | km | level
--     * runner studio items g_ / tt_ / tn_ (game.studio): all bought with coins, some open at a level first
--     * runner name (op get with name, or op name), checked for rude words (RUN.BAD_ANY / BAD_WORD); shown on the boards
--     * prestige shop items o1-o3 (kind 'prestige'): never free by level, the level only lets you buy them
--     * game.staffClients: client IDs that count as staff (Coach Kit free); never sent to client apps
--   a678200  Referral.gs + App.gs + Client.gs: "Invite a friend"
--     * app_cl_request kind invite: a REFERRALS row (public.referrals), the To do text tells Romy about the credit,
--       answer {ref: {id, status}}; your own number is refused
--     * every sale (app_sell, the 3 / 6 month offers): the friend's first paid package gives the client who invited
--       them settings referral.amount ($5) in the wallet (By "auto"), a REFERRALS status, an in-app notice;
--       app_sell answers referral {id, by, byName, friend, amount, pkg}
--     * app_boot (owner, front desk): referral {amount} and refs [..]; app_cl_boot: accounts[].refs and accounts[].credit
--   4b23d36 tutorial: Help.gs is already in 0013 (same commit); no other answer shape changed.
-- Same answer shapes as the Apps Script. All "create or replace" / "if not exists": safe to run again.
-- Run after 0013. Then (0008 is the door) run:  select app.api_sync();   (no new actions: still the same count)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tables and settings
-- ---------------------------------------------------------------------
alter table public.game_players add column if not exists stats jsonb not null default '{}'::jsonb;   -- CORNICHE RUN V Stats
alter table public.game_players add column if not exists last_cause jsonb;                           -- O Last run: what ended the run (after 'T' + time)

create table if not exists public.referrals (                    -- REFERRALS tab (Referral.gs)
  id            uuid primary key default gen_random_uuid(),
  legacy_id     text unique,                                     -- A  REF-0001
  created_at    timestamptz not null default now(),              -- B  Date
  referrer_id   uuid not null references public.clients(id) on delete cascade,   -- C Referrer ID
  referrer_name text not null default '',                        -- D  Referrer
  friend        text not null default '',                        -- E  Friend
  friend_key    text not null default '',                        -- F  Friend phone (phoneKey_: no 961, no leading 0)
  status        text not null default 'Invited'
                check (status in ('Invited', 'Rewarded', 'Already a client', 'Already invited', 'Not eligible')),   -- G
  friend_cid    text not null default '',                        -- H  Friend client ID (as written)
  friend_pkg    text not null default '',                        -- I  Friend package (as written)
  credit        numeric,                                         -- J  Credit ($)
  rewarded_at   timestamptz,                                     -- K  Rewarded at
  request_id    uuid references public.client_requests(id) on delete set null,   -- L Request ID
  mark          int not null default 0,                          -- M  Last package number at the invite
  note          text not null default '',                        -- N  Note
  sheet_row     int
);
create index if not exists referrals_key on public.referrals (friend_key);
create index if not exists referrals_by on public.referrals (referrer_id);
alter table public.referrals enable row level security;
drop policy if exists ref_read on public.referrals;
create policy ref_read on public.referrals for select using (app.is_desk() or app.is_mine(referrer_id));
revoke all on public.referrals from anon;

insert into public.settings (key, value) values ('referral', '{"amount":5}'::jsonb) on conflict (key) do nothing;

-- game rules that live in code (RunGame.gs RUN, Levels.gs LV): seed/gen-seed.js makes the same JSON for new projects
insert into public.settings (key, value) values ('game_rules', '{}'::jsonb) on conflict (key) do nothing;
update public.settings set value = value || $gr${"missions":[{"k":"coins","t":"Collect 150 coins in one run","s":"coins","m":"max","n":150,"r":200},{"k":"d1","t":"Run 1,000 m in one run","s":"m","m":"max","n":1000,"r":200},{"k":"d2","t":"Run 2,500 m in one run","s":"m","m":"max","n":2500,"r":400},{"k":"jump","t":"Jump 40 times today","s":"jumps","m":"sum","n":40,"r":150},{"k":"slide","t":"Slide 30 times today","s":"slides","m":"sum","n":30,"r":150},{"k":"roof","t":"Run 300 m on kiosk roofs today","s":"roof","m":"sum","n":300,"r":200},{"k":"runs","t":"Play 5 runs today","s":"runs","m":"sum","n":5,"r":150},{"k":"power","t":"Grab 4 power ups today","s":"powers","m":"sum","n":4,"r":150},{"k":"score","t":"Score 5,000 in one run","s":"score","m":"max","n":5000,"r":250},{"k":"clean","t":"Run 600 m without tripping","s":"clean","m":"max","n":600,"r":250},{"k":"mult","t":"Reach x3 score in a run","s":"mult","m":"max","n":3,"r":200}],"allBonus":300,"badges":{"first":"First run","km1":"1 km in one run","km5":"5 km in one run","km10":"10 km in one run","runs10":"10 runs","runs50":"50 runs","runs100":"100 runs","day1":"#1 of the day","week1":"#1 of the week","week10":"Top 10 of the week","all3":"All time top 3","all1":"All time #1","rich":"10,000 coins earned","boost":"Trained and ran the same day"},"xp":{"PER_M":0.1,"MISSION":50,"TRAINED":150,"STREAK":75,"STEPS":50},"wordBonus":1000,"oldOrder":["first","km1","km5","km10","runs10","runs50","runs100","day1","week1","week10","all3","all1","rich","boost"],"oldMap":{"first":"play1","km1":"dist2","km5":"dist4","km10":"dist5","runs10":"play2","runs50":"play3","runs100":"play4","rich":"coin2","boost":"train1","week10":"lb1","day1":"lb2","week1":"lb3","all3":"lb4","all1":"lb5"},"tiers":["Bronze","Silver","Gold","Platinum","Diamond"],"ladders":[{"k":"dist","t":"Distance","d":"in one run","u":"m","need":[500,1000,2500,5000,10000]},{"k":"tkm","t":"Total distance","d":"in all your runs","u":"km","need":[5000,25000,100000,250000,500000]},{"k":"play","t":"Runs played","u":"runs","need":[1,10,50,100,250]},{"k":"coin","t":"Coins earned","d":"in total","u":"coins","need":[2000,10000,50000,150000,500000]},{"k":"jump","t":"Jumps","d":"in total","u":"jumps","need":[100,500,2000,5000,15000]},{"k":"slide","t":"Slides","d":"in total","u":"slides","need":[100,500,2000,5000,15000]},{"k":"clean","t":"Clean run","d":"without tripping","u":"m","need":[300,600,1200,2500,5000]},{"k":"miss","t":"Missions","d":"done in total","u":"missions","need":[3,15,50,150,400]},{"k":"word","t":"WELLBE words","d":"completed","u":"words","need":[1,3,10,25,50]},{"k":"city","t":"Cities","d":"in one run","u":"cities","need":[2,3,4,6,8]},{"k":"train","t":"Training days","d":"trained at Wellbe and ran","u":"days","need":[1,5,15,40,100]},{"k":"lb","t":"Leaderboard","u":"","ev":["Top 10 of the week","#1 of the day","#1 of the week","All time top 3","All time #1"]}],"cityM":1750,"badAny":["fuck","shit","bitch","cunt","nigg","whore","slut","porn","hitler","pussy","penis","vagina","dildo","wank","bastard","asshole","sharmo","sharmu","charmo","charmu","manyak","manyouk","mnayak","metnak","mitnak","qahba","a7be","a7ba","kahba","khawal","ayreh","3ayr","zebbak","kesak","kossak","kosomak","kosom","teezak","tizak","شرموط","منيك","متناك","قحب","كسمك","كسختك"],"badWord":["ass","dick","cock","sex","fag","kos","kus","koss","kuss","kes","zeb","zib","zebb","ayr","ayre","ayri","air","teez","tiz","khara","5ara","a7a","ahh","kalb","hmar","fuk","rape","nazi","ahbe","كس","زب","زبي","عير","طيز","خول","خرا","نيك","كلب","حمار"],"shopOrder":["magnet","shoes","jet","life2","t500","t1500","o1","o2","o3"],"outfitOrder":["coach","ramadan","matchday","street","rehab","am530","race42","tyrian","cedar","legend"]}$gr$::jsonb, updated_at = now()
 where key = 'game_rules';

-- ---------------------------------------------------------------------
-- 2. small helpers (JavaScript semantics)
-- ---------------------------------------------------------------------
-- the game's clock: now(). The tests replace this one function to play with time (5:30 AM Club, one run at a time).
create or replace function app.clock() returns timestamptz language sql stable as $$ select now() $$;
-- String(v) for a JSON value ('' for missing / null)
create or replace function app.js_str(v jsonb) returns text language sql immutable as $$
  select case when v is null then '' else case jsonb_typeof(v)
    when 'null' then '' when 'string' then v #>> '{}' when 'object' then '[object Object]'
    when 'array' then (select coalesce(string_agg(app.js_str(e), ',' order by i), '') from jsonb_array_elements(v) with ordinality x(e, i))
    else v::text end end
$$;
-- 12,345 (runNum_)
create or replace function app.run_num(n float8) returns text language sql immutable as $$
  select to_char(floor(n + 0.5), 'FM999,999,999,999,990') $$;
-- 0.4 / 5 / 250 (runKm_, n in m)
create or replace function app.run_km(n float8) returns text language sql immutable as $$
  select case when n / 1000.0 >= 100 or n / 1000.0 = floor(n / 1000.0) then app.run_num(floor(n / 1000.0))
              else to_char(floor(n / 1000.0 * 10) / 10, 'FM999999999990.0') end $$;
-- 2,500 m · 5 km · 40 jumps · 1 run (runAmt_)
create or replace function app.run_amt(l jsonb, n float8) returns text language sql immutable as $$
  select case when l->>'u' = 'km' then app.run_km(n) || ' km'
              else app.run_num(n) || ' ' || case when n = 1 then regexp_replace(coalesce(l->>'u', ''), 's$', '') else coalesce(l->>'u', '') end end $$;
create or replace function app.run_tier_text(l jsonb, i int) returns text language sql immutable as $$
  select case when l ? 'ev' then l->'ev'->>i
              else app.run_amt(l, (l->'need'->>i)::float8) || case when coalesce(l->>'d', '') <> '' then ' ' || (l->>'d') else '' end end $$;
-- the number a ladder counts (runLadderVal_)
create or replace function app.run_ladder_val(k text, best_m float8, total_m float8, runs float8, earned float8, st jsonb) returns float8 language sql stable as $$
  select case k when 'dist' then best_m when 'tkm' then total_m when 'play' then runs when 'coin' then earned
    when 'jump' then app.n0(st->'j') when 'slide' then app.n0(st->'s') when 'clean' then app.n0(st->'cb') when 'miss' then app.n0(st->'mi')
    when 'word' then app.n0(st->'w') when 'train' then app.n0(st->'td')
    when 'city' then case when best_m > 0 then floor(best_m / app.setting_int('{game_rules,cityM}', 1750)) + 1 else 0 end
    else 0 end $$;
-- every badge id in ladder order: dist1 .. dist5, tkm1 .. lb5
create or replace function app.run_ladder_order() returns text[] language sql stable as $$
  select coalesce(array_agg((l->>'k') || t order by i, t), '{}') from jsonb_array_elements(app.setting('{game_rules,ladders}')) with ordinality x(l, i), generate_series(1, 5) t $$;
-- earned badges as a set {id: 1} (runBadgeSet_): saved ids, old ids mapped, tiers the totals reach (a higher tier fills the lower ones)
create or replace function app.run_badge_set(badges jsonb, best_m float8, total_m float8, runs float8, earned float8, st jsonb) returns jsonb language plpgsql stable as $$
declare s jsonb := '{}'; id text; om jsonb := app.setting('{game_rules,oldMap}'); l jsonb; v float8; top int; i int;
begin
  for id in select app.js_str(e) from jsonb_array_elements(app.arr(badges)) e loop
    if om ? id then s := s || jsonb_build_object(om->>id, 1); elsif id ~ '^[a-z]+[1-5]$' then s := s || jsonb_build_object(id, 1); end if;
  end loop;
  for l in select * from jsonb_array_elements(app.setting('{game_rules,ladders}')) loop
    continue when not l ? 'need';
    v := app.run_ladder_val(l->>'k', best_m, total_m, runs, earned, st); top := 0;
    for i in 0 .. 4 loop if v >= (l->'need'->>i)::float8 or s ? ((l->>'k') || (i + 1)) then top := i + 1; end if; end loop;
    for i in 1 .. top loop s := s || jsonb_build_object((l->>'k') || i, 1); end loop;
  end loop;
  return s;
end $$;
-- "Distance Gold: 2,500 m in one run" (runBadgeName_)
create or replace function app.run_badge_name(id text) returns text language sql stable as $$
  select coalesce((select (l->>'t') || ' ' || (app.setting('{game_rules,tiers}')->>(right(id, 1)::int - 1)) || ': ' || app.run_tier_text(l, right(id, 1)::int - 1)
                     from jsonb_array_elements(app.setting('{game_rules,ladders}')) l where l->>'k' = left(id, -1) limit 1), id) $$;
-- the 12 ladders with progress (runLadders_)
create or replace function app.run_ladders(s jsonb, best_m float8, total_m float8, runs float8, earned float8, st jsonb) returns jsonb language plpgsql stable as $$
declare out jsonb := '[]'; l jsonb; tiers jsonb; n int; nx int; i int; isOn boolean; have float8; h float8; nxt jsonb; tn jsonb := app.setting('{game_rules,tiers}');
begin
  for l in select e from jsonb_array_elements(app.setting('{game_rules,ladders}')) with ordinality x(e, o) order by o loop
    tiers := '[]'; n := 0; nx := -1;
    for i in 0 .. 4 loop
      isOn := s ? ((l->>'k') || (i + 1));
      if isOn then n := n + 1; elsif nx < 0 then nx := i; end if;
      tiers := tiers || jsonb_build_object('n', tn->>i, 't', app.run_tier_text(l, i), 'on', isOn);
    end loop;
    have := case when l ? 'ev' then n else app.run_ladder_val(l->>'k', best_m, total_m, runs, earned, st) end; nxt := null;
    if nx > -1 then
      if l ? 'ev' then nxt := jsonb_build_object('need', 1, 'label', 'Next: ' || (l->'ev'->>nx));
      else h := least(have, (l->'need'->>nx)::float8);
        nxt := jsonb_build_object('need', (l->'need'->nx), 'label', case when l->>'u' = 'km' then app.run_km(h) else app.run_num(h) end || ' of ' || app.run_amt(l, (l->'need'->>nx)::float8));
      end if;
    end if;
    out := out || jsonb_build_object('ladder', l->>'k', 'title', l->>'t', 'tier', n, 'have', have, 'tiers', tiers, 'next', coalesce(nxt, 'null'::jsonb));
  end loop;
  return out;
end $$;
-- names on the leaderboards: "First L." (runShort_), the first name (runFirst_), the chosen runner name (runLbName_)
create or replace function app.run_short(nm text) returns text language plpgsql immutable as $$
declare p text[] := regexp_split_to_array(app.js_trim(nm), '\s+');
begin
  if array_length(p, 1) > 1 then return p[1] || ' ' || left(p[array_length(p, 1)], 1) || '.'; end if;
  return coalesce(nullif(p[1], ''), 'Runner');
end $$;
create or replace function app.run_first(nm text) returns text language sql immutable as $$
  select left(coalesce(nullif((regexp_split_to_array(app.js_trim(nm), '\s+'))[1], ''), 'Runner'), 14) $$;
create or replace function app.run_lb_name(nm text, st jsonb) returns text language sql immutable as $$
  select case when jsonb_typeof(st) = 'object' and app.truthy(st->'nm') then app.js_str(st->'nm') else app.run_short(nm) end $$;
-- runner name check (runNameCheck_ / runNameBad_): '' = back to the first name; refusals as the phone shows them
create or replace function app.run_name_check(raw jsonb) returns text language plpgsql stable as $$
declare s text; low text; flat text; w text; words text[]; units int;
begin
  s := case when raw is null or jsonb_typeof(raw) = 'null' then '' else app.js_str(raw) end;
  s := regexp_replace(s, '[\u0001-\u001f​-‏‪-‮]', '', 'g');
  s := regexp_replace(s, '[\s   -     　﻿]+', ' ', 'g');
  s := btrim(s, ' ');
  if s = '' then return ''; end if;
  units := char_length(s) + (select count(*) from regexp_matches(s, '[\U00010000-\U0010FFFF]', 'g'));   -- JavaScript length (UTF-16)
  if units < 2 or units > 14 then raise exception 'Pick a name of 2 to 14 characters.'; end if;
  if s !~ '^[A-Za-z0-9À-ɏء-ي٠-٩ ]+$' then raise exception 'Use letters, numbers and spaces only.'; end if;
  low := lower(s);
  flat := replace(replace(replace(replace(regexp_replace(low, '[^a-z0-9ء-ي]', '', 'g'), '0', 'o'), '1', 'i'), '4', 'a'), '$', 's');
  words := array(select x from regexp_split_to_table(low, '[^a-z0-9ء-ي]+') x where x <> '');
  for w in select btrim(e #>> '{}') from jsonb_array_elements(app.setting('{game_rules,badAny}')) e loop
    if position(w in flat) > 0 or position(w in low) > 0 then raise exception 'Pick another name, that one is not allowed.'; end if;
  end loop;
  foreach w in array words loop
    if app.setting('{game_rules,badWord}') ? w or app.setting('{game_rules,badWord}') ? replace(replace(w, '0', 'o'), '1', 'i') then
      raise exception 'Pick another name, that one is not allowed.';
    end if;
  end loop;
  return s;
end $$;
-- what ended the run, cleaned (runCause_); null when the phone sent no cause
create or replace function app.run_cause(ev jsonb, m float8) returns jsonb language plpgsql immutable as $$
declare o jsonb; hits jsonb := '[]'; h jsonb; n int;
begin
  if jsonb_typeof(ev) <> 'object' or not app.truthy(ev->'cause') then return null; end if;
  o := jsonb_build_object('cause', regexp_replace(left(regexp_replace(app.js_str(ev->'cause'), '[\u0001-\u001f]', '', 'g'), 24), '[^A-Za-z0-9_]', '', 'g'),
    'text', left(regexp_replace(app.js_str(ev->'causeText'), '[\u0001-\u001f]', '', 'g'), 90),
    'lane', greatest(0, least(3, app.jr(app.n0(ev->'lane')))),
    'm', greatest(0, app.jr(coalesce(nullif(app.n0(ev->'atM'), 0), nullif(m, 0), 0))));
  if jsonb_typeof(ev->'hits') = 'array' then
    n := jsonb_array_length(ev->'hits');
    for h in select e from jsonb_array_elements(ev->'hits') with ordinality x(e, i) where i > n - 5 order by i loop
      if app.truthy(h) then
        hits := hits || jsonb_build_object('k', regexp_replace(left(regexp_replace(app.js_str(h->'k'), '[\u0001-\u001f]', '', 'g'), 24), '[^A-Za-z0-9_]', '', 'g'),
          'm', greatest(0, app.jr(app.n0(h->'m'))));
      end if;
    end loop;
  end if;
  return o || jsonb_build_object('hits', hits);
end $$;

-- ---------------------------------------------------------------------
-- 3. levels and the coin shop (Levels.gs) in the settings order of game.shop
-- ---------------------------------------------------------------------
create or replace function app.shop_keys() returns text[] language sql stable as $$
  select coalesce(array_agg(k order by o, k), '{}') from (
    select e.key as k, coalesce((select i from jsonb_array_elements_text(app.setting('{game_rules,shopOrder}')) with ordinality x(v, i) where v = e.key), 1000) as o
      from jsonb_each(coalesce(app.setting('{game,shop}'), '{}')) e) z $$;
-- has this item: free by level (not prestige) or bought (lvHas_)
create or replace function app.lv_has(owned jsonb, level int, k text) returns boolean language sql stable as $$
  select app.setting(array['game', 'shop', k]) is not null
     and ((coalesce(app.setting(array['game', 'shop', k, 'kind']) #>> '{}', '') <> 'prestige' and level >= app.n0(app.setting(array['game', 'shop', k, 'lv'])))
          or coalesce(app.js_num(owned->k), 0) > 0)
$$;
create or replace function app.lv_out(xp bigint, owned jsonb) returns jsonb language sql stable as $$
  with lv as (select app.lv_of(xp) as v),
       sh as (select k, app.setting(array['game', 'shop', k]) as s, o from unnest(app.shop_keys()) with ordinality x(k, o)),
       hv as (select k, s, o, case when s->>'kind' = 'ticket' then to_jsonb(app.n0(owned->k)) else to_jsonb(app.lv_has(owned, ((select v from lv)->>'level')::int, k)) end as h from sh)
  select jsonb_build_object('xp', v->'total', 'level', v->'level', 'into', v->'into', 'need', v->'need', 'max', app.setting('{game,levelMax}'),
    'have', (select coalesce(jsonb_object_agg(k, h), '{}') from hv),
    'shop', (select coalesce(jsonb_agg(jsonb_build_object('k', k, 'n', s->'n', 'coins', s->'coins', 'lv', s->'lv', 'kind', s->'kind', 'have', h) order by o), '[]') from hv),
    'badge', (v->>'level')::int >= app.setting_int('{game,badgeLv}', 50))
  from lv
$$;

-- ---------------------------------------------------------------------
-- 4. outfits and studio items (RunGame.gs runOutfits_ / runStudio_ / runWho_)
-- ---------------------------------------------------------------------
-- staff (Coach Kit free): game.staffClients, or the client's email / phone is a STAFF member's; physio: any Physio / Prehab / Assessment package
create or replace function app.run_who(cu uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.clients; cid text; staff boolean := false; physio boolean := false; em text; ph text;
begin
  select * into c from public.clients where id = cu; cid := upper(coalesce(c.legacy_id, ''));
  if exists (select 1 from jsonb_array_elements(app.arr(app.setting('{game,staffClients}'))) e where upper(app.js_trim(app.js_str(e))) = cid) then staff := true; end if;
  if not staff and cid !~ '^G\d+$' then
    em := lower(app.js_trim(c.email));
    ph := regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), '^00', ''), '^961', ''), '^0+', '');
    if exists (select 1 from public.staff s where s.active and ((em <> '' and lower(app.js_trim(s.email)) = em)
                 or (length(ph) >= 7 and regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'), '^00', ''), '^961', ''), '^0+', '') = ph))) then staff := true; end if;
  end if;
  if cid !~ '^G\d+$' and exists (select 1 from public.packages p where p.client_id = cu and p.type_name ~* 'physio|prehab|assessment') then physio := true; end if;
  return jsonb_build_object('staff', staff, 'physio', physio);
end $$;
-- one outfit (runOutfit_)
create or replace function app.run_outfit(id text, lv int, total_m float8, owned jsonb, st jsonb, who jsonb) returns jsonb language plpgsql stable as $$
declare o jsonb := coalesce(app.setting(array['game', 'outfits', id]), '{}'); r jsonb; s jsonb; own boolean; rule text := 'coins'; coins float8 := app.n0(o->'coins'); need float8; have float8; got text;
begin
  r := jsonb_build_object('id', id) || case when o ? 'n' then jsonb_build_object('n', o->'n') else '{}' end;
  if app.truthy(o->'shop') then
    s := coalesce(app.setting(array['game', 'shop', o->>'shop']), '{}'); own := coalesce(app.js_num(owned->(o->>'shop')), 0) > 0;
    return r || jsonb_build_object('own', own, 'rule', 'level', 'coins', app.n0(s->'coins'), 'lv', app.n0(s->'lv'), 'can', not own and lv >= app.n0(s->'lv'));
  end if;
  if app.truthy(o->'free') then return r || jsonb_build_object('own', true, 'rule', 'free', 'coins', 0, 'lv', 0, 'can', false); end if;
  if app.truthy(o->'early') then
    need := app.n0(o->'early'); have := app.n0(st->'am');
    return r || jsonb_build_object('own', have >= need, 'rule', 'early', 'coins', 0, 'lv', 0, 'can', false, 'need', need, 'have', have, 'hour', app.setting('{game,earlyHour}'));
  end if;
  if app.truthy(o->'km') then
    need := app.n0(o->'km') * 1000; have := total_m;
    return r || jsonb_build_object('own', have >= need, 'rule', 'km', 'coins', 0, 'lv', 0, 'can', false, 'need', need, 'have', have);
  end if;
  own := coalesce(app.js_num(owned->('of_' || id)), 0) > 0; if own then got := 'Bought'; end if;
  if app.truthy(o->'staff') then rule := 'staff'; if not own and (who->>'staff')::boolean then own := true; got := 'Free for staff'; end if; end if;
  if app.truthy(o->'physio') then rule := 'physio'; if not own and (who->>'physio')::boolean then own := true; got := 'Free with your physio booking'; end if; end if;
  return r || jsonb_build_object('own', own, 'rule', rule, 'coins', coins, 'lv', 0, 'can', not own and coins > 0) || case when got is not null then jsonb_build_object('got', got) else '{}' end;
end $$;
-- every outfit, in Config.gs order (game_rules.outfitOrder, then any new ones by id)
create or replace function app.run_outfits(cu uuid, lv int, total_m float8, owned jsonb, st jsonb) returns jsonb language sql stable as $$
  with w as (select app.run_who(cu) as who),
       k as (select e.key as id, coalesce((select i from jsonb_array_elements_text(app.setting('{game_rules,outfitOrder}')) with ordinality x(v, i) where v = e.key), 1000) as o
               from jsonb_each(coalesce(app.setting('{game,outfits}'), '{}')) e)
  select coalesce(jsonb_agg(app.run_outfit(id, lv, total_m, owned, st, (select who from w)) order by o, id), '[]') from k
$$;
-- studio items {id: {n, k, coins, lv, own, can}} (runStudio_): only what Owned records is the player's
create or replace function app.run_studio(lv int, owned jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(e.key, jsonb_build_object('n', e.value->'n', 'k', e.value->'k', 'coins', app.n0(e.value->'coins'), 'lv', app.n0(e.value->'lv'),
           'own', coalesce(app.js_num(owned->e.key), 0) > 0,
           'can', not (coalesce(app.js_num(owned->e.key), 0) > 0) and app.n0(e.value->'coins') > 0 and lv >= app.n0(e.value->'lv'))), '{}')
    from jsonb_each(coalesce(app.setting('{game,studio}'), '{}')) e
$$;

-- ---------------------------------------------------------------------
-- 5. the leaderboards (runBoards_): hidden players left out except yourself, runner names, sheet order on ties
-- ---------------------------------------------------------------------
create or replace function app.run_boards(p_client uuid, today date, wk date) returns jsonb language sql stable security definer set search_path = public as $$
  with base as (
    select g.*, (g.client_id = p_client) as me, app.run_lb_name(g.name, g.stats) as short,
           row_number() over (order by g.sheet_row nulls last, g.created_at, g.client_id) as ord
      from public.game_players g
     where g.client_id = p_client or not app.truthy(g.owned->'lbHide')),
  d as (select short, day_best as s, me, row_number() over (order by day_best desc, ord) i from base where day_key = today and day_best > 0),
  w as (select short, week_best as s, me, row_number() over (order by week_best desc, ord) i from base where week_key = wk and week_best > 0),
  a as (select short, best_score as s, me, row_number() over (order by best_score desc, ord) i from base where best_score > 0)
  select jsonb_build_object(
    'lists', jsonb_build_object(
      'day', coalesce((select jsonb_agg(jsonb_build_object('n', short, 's', s, 'me', me, 'i', i) order by i) from d where i <= 10), '[]'),
      'week', coalesce((select jsonb_agg(jsonb_build_object('n', short, 's', s, 'me', me, 'i', i) order by i) from w where i <= 10), '[]'),
      'all', coalesce((select jsonb_agg(jsonb_build_object('n', short, 's', s, 'me', me, 'i', i) order by i) from a where i <= 10), '[]'),
      'totals', jsonb_build_object('day', (select count(*) from d), 'week', (select count(*) from w), 'all', (select count(*) from a))),
    'rank', jsonb_build_object('day', coalesce((select i from d where me), 0), 'week', coalesce((select i from w where me), 0), 'all', coalesce((select i from a where me), 0)))
$$;
-- 0003 name kept for anything that still calls it
create or replace function app.boards(p_client uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select app.run_boards(p_client, (app.clock() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'))::date,
                        date_trunc('week', (app.clock() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'))::date)::date)
$$;

-- ---------------------------------------------------------------------
-- 6. THE GAME CALL (RunGame.gs clRun_): op get | save | buy | shop | redeem | name, every reply is the whole game screen
-- ---------------------------------------------------------------------
create or replace function app.run_call(cu uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  tz text := coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut');
  nowt timestamptz := app.clock(); today date := (app.clock() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'))::date;
  wk date := date_trunc('week', today)::date; op text := coalesce(nullif(app.js_str(p->'op'), ''), 'get');
  rules jsonb := app.setting('{game_rules}'); cash jsonb := app.setting('{game,cash}'); upcost jsonb := app.setting('{game,upCost}');
  lifecost int := app.setting_int('{game,lifeCost}', 1000); lifemax int := app.setting_int('{game,lifeMax}', 3);
  g public.game_players; fresh boolean; changed boolean; out jsonb := '{"newBadges":[],"mdone":[]}';
  v_up jsonb; v_owned jsonb; v_ms jsonb; v_badges jsonb; st jsonb; boost boolean;
  r jsonb; ev jsonb; secs float8; m int; coins int; score int; spent int; t1500 boolean; t500 boolean; ran int; lastms float8;
  got jsonb; earned int; bd jsonb; had jsonb := '{}'; mi jsonb; cur float8; nv float8; mdone jsonb := '[]'; lt int; ce int; xpg int; badge_add boolean := false;
  before int; after int; l int; chest int; gotl jsonb; sk text; s jsonb; ups jsonb := '[]'; lu int; lvl int; cost int; item text; o jsonb;
  nm text; hide boolean; pend int; amt int; rid uuid; boards jsonb; tot jsonb; rk jsonb; bset jsonb; nb jsonb := '[]'; bid text; ms_tot int := 0;
  early_h int := app.setting_int('{game,earlyHour}', null); early_m int := app.setting_int('{game,earlyMinM}', null);
begin
  select * into g from public.game_players where client_id = cu for update;
  fresh := g.client_id is null;
  if fresh then   -- first game for this player: a new row (runName_: the client's name, or the ID)
    insert into public.game_players (client_id, name) values (cu, coalesce((select app.js_trim(name) from public.clients where id = cu), app.legacy(cu)))
    returning * into g;
  end if;
  changed := fresh;
  v_up := case when jsonb_typeof(g.upgrades) = 'object' then g.upgrades else '{}' end;
  v_owned := case when jsonb_typeof(g.owned) = 'object' then g.owned else '{}' end;
  if not app.truthy(v_owned->'_m') then        -- players who bought an upgrade keep that power open (lvMigrate_)
    select v_owned || coalesce(jsonb_object_agg(k, 1), '{}') into v_owned from unnest(array['magnet', 'jet', 'shoes']) k where app.n0(v_up->k) > 0;
    v_owned := v_owned || '{"_m":1}';
  end if;
  v_ms := case when jsonb_typeof(g.missions) = 'object' then g.missions else '{}' end;
  v_badges := app.arr(g.badges);
  st := case when jsonb_typeof(g.stats) = 'object' then g.stats else '{}' end;
  if v_ms->>'d' is distinct from to_char(today, 'YYYY-MM-DD') then v_ms := jsonb_build_object('d', to_char(today, 'YYYY-MM-DD'), 'st', '{}'::jsonb, 'done', '[]'::jsonb, 'bonus', 0); end if;
  if g.day_key is distinct from today then g.day_key := today; g.day_best := 0; end if;
  if g.week_key is distinct from wk then g.week_key := wk; g.week_best := 0; end if;
  boost := app.trained_on(cu, today - 1, today);

  if op = 'save' then
    r := case when jsonb_typeof(p->'run') = 'object' then p->'run' else '{}' end;
    secs := greatest(0, app.n0(r->'secs')); m := greatest(0, app.jr(app.n0(r->'m')))::int;
    coins := greatest(0, app.jr(app.n0(r->'coins')))::int; score := greatest(0, app.jr(app.n0(r->'score')))::int; spent := greatest(0, app.jr(app.n0(r->'spent')))::int;
    ev := case when jsonb_typeof(r->'ev') = 'object' then r->'ev' else '{}' end;
    t1500 := app.truthy(ev->'t1500'); t500 := app.truthy(ev->'t500');
    ran := greatest(0, m - case when t1500 then 1500 else 0 end);     -- meters actually run: a head start never counts for Cash or XP
    if t1500 and not coalesce(app.js_num(v_owned->'t1500') > 0, false) then raise exception 'No start at 1,500 m ticket left.'; end if;
    if t500 and not coalesce(app.js_num(v_owned->'t500') > 0, false) then raise exception 'No 500 coin run ticket left.'; end if;
    lastms := case when g.last_run_at is null then 0 else app.ms(g.last_run_at) end;
    if secs < 3 or secs > 3600 then raise exception 'That run is not possible.'; end if;
    if ran > secs * 19.5 + 30 or coins > ran * 0.6 * (case when t500 then 2 else 1 end) + 80 or score > m * 5 + coins * 5 + 50 then raise exception 'That run is not possible.'; end if;
    if lastms > 0 and app.ms(nowt) - lastms < secs * 700 then raise exception 'Slow down, one run at a time.'; end if;
    got := jsonb_build_object('coins', coins, 'm', m, 'score', score, 'runs', 1,
      'jumps', greatest(0, least(app.jr(app.n0(ev->'jumps')), secs * 3)), 'slides', greatest(0, least(app.jr(app.n0(ev->'slides')), secs * 3)),
      'roof', greatest(0, least(app.jr(app.n0(ev->'roof')), m)), 'powers', greatest(0, least(app.jr(app.n0(ev->'powers')), floor(m / 40.0) + 2)),
      'clean', greatest(0, least(app.jr(app.n0(ev->'clean')), m)), 'mult', greatest(0, least(app.jr(app.n0(ev->'mult')), 5)));
    earned := coins * case when boost then 2 else 1 end;
    bd := jsonb_build_object('picked', coins, 'boost', case when boost then coins else 0 end, 'missions', 0, 'allBonus', 0, 'wellbe', 0, 'total', 0);
    had := app.run_badge_set(v_badges, g.best_m, g.total_m, g.runs, g.earned_total, st);   -- badges before this run: no "New badge" line for them
    st := st || jsonb_build_object('j', app.n0(st->'j') + (got->>'jumps')::float8, 's', app.n0(st->'s') + (got->>'slides')::float8,
                                   'cb', greatest(app.n0(st->'cb'), (got->>'clean')::float8));
    for mi in select * from jsonb_array_elements(app.missions_today(today)) loop
      cur := app.n0(v_ms->'st'->(mi->>'k'));
      nv := case when mi->>'m' = 'sum' then cur + (got->>(mi->>'s'))::float8 else greatest(cur, (got->>(mi->>'s'))::float8) end;
      v_ms := jsonb_set(v_ms, array['st', mi->>'k'], to_jsonb(nv));
      if not (app.arr(v_ms->'done') ? (mi->>'k')) and nv >= (mi->>'n')::float8 then
        v_ms := jsonb_set(v_ms, '{done}', app.arr(v_ms->'done') || to_jsonb(mi->>'k')); earned := earned + (mi->>'r')::int;
        bd := bd || jsonb_build_object('missions', (bd->>'missions')::int + (mi->>'r')::int); st := st || jsonb_build_object('mi', app.n0(st->'mi') + 1);
        mdone := mdone || jsonb_build_array(jsonb_build_object('t', mi->>'t', 'r', (mi->>'r')::int));
      end if;
    end loop;
    if jsonb_array_length(app.arr(v_ms->'done')) >= 3 and not app.truthy(v_ms->'bonus') then
      v_ms := v_ms || '{"bonus":1}'; earned := earned + (rules->>'allBonus')::int; bd := bd || jsonb_build_object('allBonus', (rules->>'allBonus')::int);
      mdone := mdone || jsonb_build_array(jsonb_build_object('t', 'All 3 missions done', 'r', (rules->>'allBonus')::int));
    end if;
    lt := greatest(0, least(app.jr(app.n0(ev->'letters')), case when m >= 800 then 2 when m >= 350 then 1 else 0 end));
    if lt > 0 then
      v_ms := v_ms || jsonb_build_object('wl', least(7, app.n0(v_ms->'wl') + lt));
      if (v_ms->>'wl')::float8 >= 7 and not app.truthy(v_ms->'wb') then
        v_ms := v_ms || '{"wb":1}'; earned := earned + 1000; bd := bd || '{"wellbe":1000}'; st := st || jsonb_build_object('w', app.n0(st->'w') + 1);
        mdone := mdone || jsonb_build_array(jsonb_build_object('t', 'WELLBE complete', 'r', 1000));
      end if;
    end if;
    -- Wellbe Credit: CENTS for a run that passes MIN_M (once per run), max DAY_MAX a day. Every player earns.
    ce := 0;
    if ran >= (cash->>'MIN_M')::int then
      ce := greatest(0, least((cash->>'CENTS')::int, (cash->>'DAY_MAX')::int - app.n0(v_ms->'cash')::int));
      v_ms := v_ms || jsonb_build_object('cash', app.n0(v_ms->'cash') + ce);
      g.credit_cents := g.credit_cents + ce; g.credit_earned_cents := g.credit_earned_cents + ce;
      if ce > 0 then insert into public.credit_ledger (client_id, delta_cents, reason) values (cu, ce, 'Run over ' || (cash->>'MIN_M') || ' m'); end if;
    end if;
    out := out || jsonb_build_object('cashEarned', ce);
    -- XP: meters run, missions, training at the center today (once a day; also a training day for the ladder)
    xpg := floor(ran * (rules->'xp'->>'PER_M')::float8)::int + jsonb_array_length(mdone) * (rules->'xp'->>'MISSION')::int;
    if not app.truthy(v_ms->'trx') and app.trained_on(cu, today, today) then
      v_ms := v_ms || '{"trx":1}'; xpg := xpg + (rules->'xp'->>'TRAINED')::int; out := out || jsonb_build_object('trainedXp', (rules->'xp'->>'TRAINED')::int);
      st := st || jsonb_build_object('td', app.n0(st->'td') + 1);
    end if;
    if t1500 then v_owned := v_owned || jsonb_build_object('t1500', app.n0(v_owned->'t1500') - 1); end if;
    if t500 then v_owned := v_owned || jsonb_build_object('t500', app.n0(v_owned->'t500') - 1); end if;
    -- levels (lvAdd_): a chest per level passed, once items named, prestige items open to buy, a free ticket per level from its level
    before := (app.lv_of(g.xp)->>'level')::int; g.xp := g.xp + greatest(0, xpg); after := (app.lv_of(g.xp)->>'level')::int;
    for l in before + 1 .. after loop
      chest := 100 + 25 * l; g.coins := g.coins + chest; gotl := '[]';
      foreach sk in array app.shop_keys() loop
        s := app.setting(array['game', 'shop', sk]);
        if s->>'kind' = 'once' and app.n0(s->'lv') = l then gotl := gotl || to_jsonb(s->>'n'); end if;
        if s->>'kind' = 'prestige' and app.n0(s->'lv') = l then gotl := gotl || to_jsonb((s->>'n') || ' can now be bought'); end if;
        if s->>'kind' = 'ticket' and l >= app.n0(s->'lv') then v_owned := v_owned || jsonb_build_object(sk, app.n0(v_owned->sk) + 1); gotl := gotl || to_jsonb('1 ' || (s->>'n')); end if;
      end loop;
      if l = app.setting_int('{game,badgeLv}', 50) then gotl := gotl || '"Gold Wellbe Runner badge"'; end if;
      ups := ups || jsonb_build_array(jsonb_build_object('level', l, 'chest', chest, 'got', gotl));
    end loop;
    out := out || jsonb_build_object('xpGain', xpg, 'levelUps', ups);
    if app.truthy(ev->'lifeUsed') and app.n0(v_up->'life') > 0 then   -- 2nd life slot: up to 2 extra lives in one run
      lu := least(app.jr(coalesce(nullif(app.js_num(ev->'lifeUsed'), 0), 1)), case when app.lv_has(v_owned, (app.lv_of(g.xp)->>'level')::int, 'life2') then 2 else 1 end);
      v_up := v_up || jsonb_build_object('life', greatest(0, app.n0(v_up->'life') - lu));
    end if;
    g.coins := greatest(0, g.coins + earned - spent); g.earned_total := g.earned_total + earned;
    g.runs := g.runs + 1; g.total_m := g.total_m + m;
    out := out || jsonb_build_object('record', score > g.best_score);
    if score > g.best_score then g.best_score := score; end if;
    g.best_m := greatest(g.best_m, m); g.day_best := greatest(g.day_best, score); g.week_best := greatest(g.week_best, score);
    g.last_run_at := nowt; g.last_cause := app.run_cause(ev, m);
    bd := bd || jsonb_build_object('total', earned);
    out := out || jsonb_build_object('earned', earned, 'boosted', boost, 'breakdown', bd);
    -- 5:30 AM Club: runs of at least earlyMinM that started before earlyHour (Beirut time)
    if early_m is not null and early_h is not null and ran >= early_m and extract(hour from (nowt - make_interval(secs => secs)) at time zone tz) < early_h then
      st := st || jsonb_build_object('am', app.n0(st->'am') + 1);
    end if;
    insert into public.game_runs (client_id, at, secs, m, ran_m, coins, score, spent, earned, credit_cents, xp, ev)
    values (cu, nowt, app.jr(secs)::int, m, ran, coins, score, spent, earned, ce, xpg, ev);
    if earned - spent <> 0 then insert into public.coin_ledger (client_id, delta, reason) values (cu, earned - spent, 'Run'); end if;
    badge_add := true; changed := true;
  end if;

  if op = 'shop' then   -- the coin shop (lvBuy_)
    item := app.js_str(p->'item'); s := app.setting(array['game', 'shop', item]);
    if s is null then raise exception 'Not in the shop'; end if;
    lvl := (app.lv_of(g.xp)->>'level')::int;
    if s->>'kind' in ('once', 'prestige') and app.lv_has(v_owned, lvl, item) then raise exception 'You already have the %', s->>'n'; end if;
    if s->>'kind' = 'prestige' and lvl < app.n0(s->'lv') then raise exception 'Reach level % to buy the %', app.jsnum(app.n0(s->'lv')::numeric), s->>'n'; end if;
    if g.coins < app.n0(s->'coins') then raise exception 'Not enough coins'; end if;
    g.coins := g.coins - app.n0(s->'coins')::int; v_owned := v_owned || jsonb_build_object(item, app.n0(v_owned->item) + 1);
    insert into public.coin_ledger (client_id, delta, reason) values (cu, -app.n0(s->'coins')::int, 'Shop: ' || (s->>'n'));
    out := out || jsonb_build_object('bought', s->'n'); changed := true;
  end if;

  if op = 'buy' then
    item := app.js_str(p->'item'); lvl := (app.lv_of(g.xp)->>'level')::int;
    if coalesce(app.setting('{game,outfits}'), '{}') ? item then            -- a runner outfit (runBuyOutfit_)
      o := app.run_outfit(item, lvl, g.total_m, v_owned, st, app.run_who(cu));
      if (o->>'own')::boolean then raise exception 'You already have %', o->>'n'; end if;
      if o->>'rule' = 'early' then raise exception '% unlocks after % runs started before % am', o->>'n', app.jsnum((o->>'need')::numeric), app.jsnum(early_h); end if;
      if o->>'rule' = 'km' then raise exception '% unlocks when you have run % km in total', o->>'n', app.jsnum((o->>'need')::numeric / 1000); end if;
      if o->>'rule' = 'level' and lvl < (o->>'lv')::float8 then raise exception 'Reach level % to buy %', app.jsnum((o->>'lv')::numeric), o->>'n'; end if;
      if not ((o->>'coins')::float8 > 0) then raise exception '% is not for sale', o->>'n'; end if;
      if g.coins < (o->>'coins')::float8 then raise exception 'Not enough coins'; end if;
      g.coins := g.coins - (o->>'coins')::numeric::int;
      if o->>'rule' = 'level' then v_owned := v_owned || jsonb_build_object(app.setting(array['game', 'outfits', item, 'shop']) #>> '{}', 1);
      else v_owned := v_owned || jsonb_build_object('of_' || item, 1); end if;
      insert into public.coin_ledger (client_id, delta, reason) values (cu, -(o->>'coins')::numeric::int, 'Outfit: ' || (o->>'n'));
      out := out || jsonb_build_object('bought', o->'n');
    elsif coalesce(app.setting('{game,studio}'), '{}') ? item then          -- gear, tattoo or taunt (runBuyStudio_)
      o := app.run_studio(lvl, v_owned)->item;
      if (o->>'own')::boolean then raise exception 'You already have %', o->>'n'; end if;
      if (o->>'lv')::float8 > 0 and lvl < (o->>'lv')::float8 then raise exception 'Reach level % to buy %', app.jsnum((o->>'lv')::numeric), o->>'n'; end if;
      if not ((o->>'coins')::float8 > 0) then raise exception '% is not for sale', o->>'n'; end if;
      if g.coins < (o->>'coins')::float8 then raise exception 'Not enough coins'; end if;
      g.coins := g.coins - (o->>'coins')::numeric::int; v_owned := v_owned || jsonb_build_object(item, 1);
      insert into public.coin_ledger (client_id, delta, reason) values (cu, -(o->>'coins')::numeric::int, 'Studio: ' || (o->>'n'));
      out := out || jsonb_build_object('bought', o->'n');
    elsif item = 'life' then
      if app.n0(v_up->'life') >= lifemax then raise exception 'You already have % extra lives', lifemax; end if;
      if g.coins < lifecost then raise exception 'Not enough coins'; end if;
      g.coins := g.coins - lifecost; v_up := v_up || jsonb_build_object('life', app.n0(v_up->'life') + 1);
      insert into public.coin_ledger (client_id, delta, reason) values (cu, -lifecost, 'Extra life');
    else
      if item not in ('magnet', 'jet', 'shoes') then raise exception 'Unknown upgrade'; end if;
      lvl := app.n0(v_up->item)::int;
      if lvl >= jsonb_array_length(upcost) then raise exception 'Already maxed'; end if;
      cost := (upcost->>lvl)::int;
      if g.coins < cost then raise exception 'Not enough coins'; end if;
      g.coins := g.coins - cost; v_up := v_up || jsonb_build_object(item, lvl + 1);
      insert into public.coin_ledger (client_id, delta, reason) values (cu, -cost, 'Upgrade: ' || item);
    end if;
    changed := true;
  end if;

  -- runner name: sent on get (the app only passes get, save and buy) or op name. Saved in Stats (nm).
  if op in ('get', 'name') and p ? 'name' and jsonb_typeof(p->'name') <> 'null' then
    nm := app.run_name_check(p->'name');
    if nm <> coalesce(st->>'nm', '') then
      if nm <> '' then st := st || jsonb_build_object('nm', nm); else st := st - 'nm'; end if;
      changed := true;
    end if;
  end if;
  -- leaderboard privacy: sent on get or save
  if op in ('get', 'save') and p ? 'lbHide' and jsonb_typeof(p->'lbHide') <> 'null' then
    hide := p->'lbHide' in ('true'::jsonb, '1'::jsonb, '"1"'::jsonb, '"true"'::jsonb);
    if app.truthy(v_owned->'lbHide') <> hide then v_owned := v_owned || jsonb_build_object('lbHide', hide); changed := true; end if;
  end if;
  select coalesce(sum(app.n0(data->'cents')), 0)::int into pend from public.client_requests where client_id = cu and type = 'Game cash' and status = 'New';
  if op = 'redeem' then
    if pend > 0 then raise exception 'You already have $% waiting for your next renewal.', to_char(pend / 100.0, 'FM999990.00'); end if;
    amt := least(g.credit_cents, (cash->>'REDEEM_MAX')::int);
    if amt < (cash->>'REDEEM_MIN')::int then raise exception 'You need at least $% Wellbe Credit.', to_char((cash->>'REDEEM_MIN')::int / 100.0, 'FM999990.00'); end if;
    g.credit_cents := g.credit_cents - amt; pend := amt;
    rid := app.client_log(cu, g.name, 'Game cash', g.name || ' used $' || to_char(amt / 100.0, 'FM999990.00') || ' Wellbe Credit (Corniche Run): take it off their first or next package, or an online workout (max $20 at a time).', '', null, 'New', jsonb_build_object('cents', amt));
    insert into public.credit_ledger (client_id, delta_cents, reason, request_id) values (cu, -amt, 'Sent to the desk', rid);
    out := out || jsonb_build_object('redeemed', amt); changed := true;
  end if;

  if changed then
    update public.game_players set name = g.name, best_score = g.best_score, best_m = g.best_m, coins = g.coins, runs = g.runs, total_m = g.total_m,
      day_key = g.day_key, day_best = g.day_best, week_key = g.week_key, week_best = g.week_best, upgrades = v_up, missions = v_ms,
      last_run_at = g.last_run_at, last_cause = g.last_cause, earned_total = g.earned_total, credit_cents = g.credit_cents, credit_earned_cents = g.credit_earned_cents,
      xp = g.xp, owned = v_owned, stats = st, updated_at = now()
     where client_id = cu;
  end if;
  boards := app.run_boards(cu, today, wk);
  bset := app.run_badge_set(v_badges, g.best_m, g.total_m, g.runs, g.earned_total, st);
  if badge_add then   -- rank badges only count once enough people are playing
    tot := boards->'lists'->'totals'; rk := boards->'rank';
    if (rk->>'week')::int between 1 and 10 and (tot->>'week')::int >= 12 then bset := bset || '{"lb1":1}'; end if;
    if (rk->>'day')::int = 1 and (tot->>'day')::int >= 3 then bset := bset || '{"lb2":1}'; end if;
    if (rk->>'week')::int = 1 and (tot->>'week')::int >= 5 then bset := bset || '{"lb3":1}'; end if;
    if (rk->>'all')::int between 1 and 3 and (tot->>'all')::int >= 10 then bset := bset || '{"lb4":1}'; end if;
    if (rk->>'all')::int = 1 and (tot->>'all')::int >= 10 then bset := bset || '{"lb5":1}'; end if;
    foreach bid in array app.run_ladder_order() loop
      if bset ? bid and not had ? bid then nb := nb || to_jsonb(app.run_badge_name(bid)); end if;
    end loop;
    out := jsonb_set(out, '{newBadges}', nb);
    -- old ids stay, so an older phone still shows them; then every ladder id earned
    select coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(v_badges) with ordinality x(e, i) where rules->'badges' ? app.js_str(e)), '[]')
        || coalesce((select jsonb_agg(to_jsonb(b) order by i) from unnest(app.run_ladder_order()) with ordinality y(b, i) where bset ? b), '[]')
      into v_badges;
    update public.game_players set badges = v_badges where client_id = cu;
  end if;
  ms_tot := jsonb_array_length(coalesce(rules->'ladders', '[]')) * 5;
  lvl := (app.lv_of(g.xp)->>'level')::int;
  mdone := case when op = 'save' then mdone else '[]' end;
  return out || jsonb_build_object('mdone', mdone,
    'coins', g.coins, 'best', g.best_score, 'bestM', g.best_m, 'runs', g.runs,
    'up', jsonb_build_object('magnet', case when app.truthy(v_up->'magnet') then v_up->'magnet' else '0' end, 'jet', case when app.truthy(v_up->'jet') then v_up->'jet' else '0' end,
                             'shoes', case when app.truthy(v_up->'shoes') then v_up->'shoes' else '0' end, 'life', case when app.truthy(v_up->'life') then v_up->'life' else '0' end),
    'upCost', upcost, 'lifeCost', lifecost, 'lifeMax', lifemax,
    'cash', jsonb_build_object('bal', g.credit_cents, 'total', g.credit_earned_cents, 'today', app.n0(v_ms->'cash'), 'minM', cash->'MIN_M', 'cents', cash->'CENTS',
      'dayMax', cash->'DAY_MAX', 'min', cash->'REDEEM_MIN', 'max', cash->'REDEEM_MAX', 'trained', true, 'pending', pend),
    'missions', (select coalesce(jsonb_agg(jsonb_build_object('k', x->'k', 't', x->'t', 'n', x->'n', 'p', least((x->>'n')::float8, app.n0(v_ms->'st'->(x->>'k'))),
        'done', app.arr(v_ms->'done') ? (x->>'k'), 'r', x->'r', 's', x->'s', 'm', x->'m') order by i), '[]')
      from jsonb_array_elements(app.missions_today(today)) with ordinality t(x, i)),
    'allBonus', rules->'allBonus', 'bonusDone', app.truthy(v_ms->'bonus'), 'word', app.n0(v_ms->'wl'), 'wordBonus', 1000,
    'badges', (select coalesce(jsonb_agg(jsonb_build_object('id', b, 't', rules->'badges'->b) order by i), '[]')
                 from jsonb_array_elements_text(rules->'oldOrder') with ordinality y(b, i)
                where v_badges ? b or bset ? (rules->'oldMap'->>b)),
    'ladders', app.run_ladders(bset, g.best_m, g.total_m, g.runs, g.earned_total, st),
    'badgeCount', jsonb_build_object('have', (select count(*) from jsonb_object_keys(bset)), 'all', ms_tot),
    'boost', boost, 'boards', boards->'lists', 'rank', boards->'rank', 'lv', app.lv_out(g.xp, v_owned), 'lbHide', app.truthy(v_owned->'lbHide'),
    'outfits', app.run_outfits(cu, lvl, g.total_m, v_owned, st), 'studio', app.run_studio(lvl, v_owned),
    'runName', case when app.truthy(st->'nm') then app.js_str(st->'nm') else app.run_first(g.name) end, 'runNameSet', app.truthy(st->'nm'));
end $$;

-- action app_cl_run { cid, op, run, item, name, lbHide }
create or replace function public.api_app_cl_run(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cu uuid := app.client_by_legacy(upper(coalesce(p->>'cid', ''))); me jsonb;
begin
  me := app.need_client(cu);
  return app.run_call(cu, p);
end $$;
-- the 0003 entry points, now through the same call (one set of rules)
create or replace function public.game_save_run(p_client uuid, p_run jsonb, p_lbhide boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client);
begin
  return app.run_call(p_client, jsonb_build_object('op', 'save', 'run', coalesce(p_run, '{}'::jsonb)) || case when p_lbhide is null then '{}'::jsonb else jsonb_build_object('lbHide', p_lbhide) end);
end $$;
create or replace function public.game_shop(p_client uuid, p_item text) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client);
begin
  return jsonb_build_object('bought', app.run_call(p_client, jsonb_build_object('op', 'shop', 'item', p_item))->'bought');
end $$;
create or replace function public.game_redeem(p_client uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need_client(p_client);
begin
  return jsonb_build_object('redeemed', app.run_call(p_client, '{"op":"redeem"}'::jsonb)->'redeemed');
end $$;

-- a guest who becomes a client keeps the game (Stats too: same row moves)
-- (app.guest_convert in 0006 moves the whole game_players row, nothing to change)

-- ---------------------------------------------------------------------
-- 7. REFERRALS (Referral.gs)
-- ---------------------------------------------------------------------
-- phoneKey_ (Code.gs): digits, no 00, no 961, no leading 0: +961 3 123 456 = 03 123 456 = 3123456
create or replace function app.phone_key(t text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '^00', ''), '^961', ''), '^0', '') $$;
-- settings referral.amount in dollars, 0 = off (refAmount_)
create or replace function app.ref_amount() returns numeric language sql stable as $$
  select case when app.js_num(app.setting('{referral,amount}')) > 0 then app.js_num(app.setting('{referral,amount}'))::numeric else 0 end $$;
-- the PKG number of a package ID (refPkgNum_)
create or replace function app.ref_pkg_num(id text) returns int language sql immutable as $$
  select coalesce((regexp_match(coalesce(id, ''), '(\d+)\s*$'))[1]::int, 0) $$;
-- highest PKG number (refPkgInfo_ max)
create or replace function app.ref_pkg_max() returns int language sql stable security definer set search_path = public as $$
  select coalesce(max(app.ref_pkg_num(legacy_id)), 0)::int from public.packages where legacy_id ~* '^PKG-' $$;
-- paid packages per client (price above 0, not a trial or free type, not cancelled), by PKG number (refPkgInfo_ paidBy)
create or replace function app.ref_paid(p_cid text) returns table (id text, num int) language sql stable security definer set search_path = public as $$
  select p.legacy_id, app.ref_pkg_num(p.legacy_id) from public.packages p join public.clients c on c.id = p.client_id
    left join public.package_types t on t.name = p.type_name
   where upper(btrim(c.legacy_id)) = p_cid and p.legacy_id ~* '^PKG-' and p.price_cents > 0 and not coalesce(t.trial or t.free, false) and coalesce(p.status, '') !~* 'cancel'
   order by 2, 1 $$;
-- who is behind a phone (refIndex_): client records, leads (phone -> client ID), app guests (phone -> client ID), in that order.
-- cid is '' when the row has no client ID (still "known": a lead or a guest joined)
create or replace function app.ref_links() returns table (ord bigint, cid text, key text) language sql stable security definer set search_path = public as $$
  select row_number() over (order by src, o1, o2), cid, key from (
    select 1 as src, coalesce(c.sheet_row, 1000000) as o1, app.cnum(c.legacy_id)::bigint as o2, upper(btrim(c.legacy_id)) as cid, app.phone_key(c.phone) as key
      from public.clients c where c.kind = 'client'
    union all
    select 2, coalesce(l.sheet_row, 1000000), app.cnum(l.legacy_id), coalesce(upper(btrim((select legacy_id from public.clients where id = l.client_id))), ''), app.phone_key(l.phone)
      from public.leads l where coalesce(l.legacy_id, '') <> ''
    union all
    select 3, coalesce(g.sheet_row, 1000000), app.cnum(g.legacy_id), coalesce(upper(btrim((select legacy_id from public.clients where id = g.converted_to))), ''), app.phone_key(g.phone)
      from public.clients g where g.kind = 'guest') x
   where length(key) >= 6 $$;
-- client IDs behind a phone, first seen first
create or replace function app.ref_cids(p_key text) returns text[] language sql stable as $$
  select coalesce(array_agg(cid order by o), '{}') from (select cid, min(ord) o from app.ref_links() where key = p_key and cid ~ '^C\d+$' group by cid) x $$;
-- REFERRALS rows in sheet order
create or replace function app.ref_rows() returns setof public.referrals language sql stable security definer set search_path = public as $$
  select * from public.referrals order by sheet_row nulls last, created_at, app.cnum(legacy_id) $$;

-- 1. the invite (refInvite_). Throws on your own number. {id, status, row, again}
create or replace function app.ref_invite(p_client uuid, p_name text, p_friend text, p_phone text) returns jsonb language plpgsql security definer set search_path = public as $$
declare k text := app.phone_key(p_phone); cid text := upper(btrim(app.legacy(p_client))); fc text[]; mine public.referrals; v_first public.referrals;
  st text := 'Invited'; nt text := ''; paid_friend text; c text; lid text; rid uuid;
begin
  if length(k) < 6 then raise exception 'Check the phone number.'; end if;
  fc := app.ref_cids(k);
  if app.phone_key((select phone from public.clients where id = p_client)) = k or cid = any(fc) then
    raise exception 'This is your own number. Invite a friend instead.';
  end if;
  select * into mine from app.ref_rows() r where r.friend_key = k and r.referrer_id = p_client limit 1;
  if mine.id is not null then return jsonb_build_object('id', mine.legacy_id, 'status', mine.status, 'row', mine.id, 'again', true); end if;
  select * into v_first from app.ref_rows() r where r.friend_key = k limit 1;
  foreach c in array fc loop if exists (select 1 from app.ref_paid(c)) then paid_friend := c; exit; end if; end loop;
  if paid_friend is not null then st := 'Already a client'; nt := paid_friend || ' already had a paid package';
  elsif v_first.id is not null then st := 'Already invited'; nt := 'Invited first by ' || v_first.referrer_name || ' (' || v_first.legacy_id || ')'; end if;
  lid := app.next_legacy('REF', 'public.referrals', 4);
  insert into public.referrals (legacy_id, created_at, referrer_id, referrer_name, friend, friend_key, status, friend_cid, mark, note)
  values (lid, app.clock(), p_client, coalesce(p_name, ''), coalesce(p_friend, ''), k, st, coalesce(paid_friend, fc[1], ''), app.ref_pkg_max(), nt)
  returning id into rid;
  return jsonb_build_object('id', lid, 'status', st, 'row', rid);
end $$;

-- 2. the reward (refOnSale_): after any package is made for a client. Safe to run many times, never throws.
-- {id, by, byName, friend, amount, pkg} when credit was given now, else null
create or replace function app.ref_on_sale(p_client uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare amt numeric := app.ref_amount(); v_cid text := upper(btrim(coalesce(app.legacy(p_client), ''))); keys text[]; r public.referrals; bef record; aft record; pid uuid;
  by_cid text; by_name text; v_reason text;
begin
  if amt = 0 or v_cid !~ '^C\d+$' then return null; end if;
  if not exists (select 1 from public.referrals) then return null; end if;
  if not exists (select 1 from app.ref_paid(v_cid)) then return null; end if;
  select array_agg(distinct x.key) into keys from app.ref_links() x where x.cid = v_cid;
  if keys is null then return null; end if;
  if not exists (select 1 from public.referrals where friend_key = any(keys)) or exists (select 1 from public.referrals where friend_key = any(keys) and status = 'Rewarded') then return null; end if;
  select * into r from app.ref_rows() x where x.friend_key = any(keys) and x.status = 'Invited' limit 1;     -- the first client who invited wins
  if r.id is null then return null; end if;
  by_cid := upper(btrim(app.legacy(r.referrer_id)));
  if by_cid = v_cid or exists (select 1 from app.ref_links() x where x.cid = by_cid and x.key = r.friend_key) then
    update public.referrals set status = 'Not eligible', friend_cid = v_cid, note = 'Self referral' where id = r.id; return null;
  end if;
  select * into bef from app.ref_paid(v_cid) x where x.num <= r.mark limit 1;
  select * into aft from app.ref_paid(v_cid) x where x.num > r.mark limit 1;
  if bef.id is not null or aft.id is null then
    update public.referrals set status = 'Already a client', friend_cid = v_cid,
      note = 'Paid package ' || coalesce(bef.id, (select x.id from app.ref_paid(v_cid) x limit 1)) || ' was there before the invite' where id = r.id;
    return null;
  end if;
  by_name := coalesce(nullif((select name from public.clients where id = r.referrer_id), ''), r.referrer_name);
  v_reason := 'Referral: ' || r.friend; pid := (select id from public.packages where legacy_id = aft.id limit 1);
  if not exists (select 1 from public.wallet_ledger w where w.client_id = r.referrer_id and regexp_replace(coalesce(w.reason, ''), '^''', '') = v_reason and w.package_id is not distinct from pid) then
    insert into public.wallet_ledger (day, client_id, amount_cents, reason, package_id, by_who) values ((app.clock() at time zone 'Asia/Beirut')::date, r.referrer_id, round(amt * 100), v_reason, pid, 'auto');
  end if;
  update public.referrals set status = 'Rewarded', friend_cid = v_cid, friend_pkg = aft.id, credit = amt, rewarded_at = app.clock() where id = r.id;
  perform app.notice(r.referrer_id, null, 'Referral credit', split_part(r.friend, ' ', 1) || ' joined Wellbe. $' || app.jsnum(amt) || ' Wellbe Credit is ready for your next package. Thank you for sharing Wellbe!');
  return jsonb_build_object('id', r.legacy_id, 'by', by_cid, 'byName', by_name, 'friend', r.friend, 'amount', amt, 'pkg', aft.id);
exception when others then
  raise warning 'Referral check failed for %: %', v_cid, sqlerrm;
  return null;
end $$;

-- 3. what the apps see
-- client app account (refClientBoot_): refs (newest first, 20) and credit (wallet balance, real money for packages)
create or replace function app.ref_client_acc(p_client uuid, acc jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare refs jsonb; bal int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('n', x.friend, 'd', to_char(x.created_at at time zone 'Asia/Beirut', 'YYYY-MM-DD'),
           'st', case x.status when 'Rewarded' then 'earned' when 'Already invited' then 'already' when 'Already a client' then 'client' when 'Not eligible' then 'client'
                   else case when exists (select 1 from app.ref_links() l where l.key = x.friend_key) then 'joined' else 'invited' end end,
           'amt', coalesce(x.credit, 0)) order by x.n desc), '[]') into refs
    from (select r.*, row_number() over (order by r.sheet_row nulls last, r.created_at, app.cnum(r.legacy_id)) n from public.referrals r where r.referrer_id = p_client) x
   where x.n > (select count(*) from public.referrals where referrer_id = p_client) - 20;
  acc := acc || jsonb_build_object('refs', refs);
  bal := app.wallet_balance(p_client);
  if bal > 0 then acc := acc || jsonb_build_object('credit', app.usd(bal)); end if;
  return acc;
end $$;
-- staff app (refStaffBoot_): owner and front desk get referral {amount} and every referral; due = who the sale screen can say "Referred by" for
create or replace function app.ref_staff_boot(d jsonb, p_role text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare amt numeric := app.ref_amount(); refs jsonb := '[]'; r public.referrals; seen text[] := '{}'; o jsonb; cids text[]; due text[]; c text; by_cid text;
begin
  if p_role = 'trainer' then return d; end if;
  d := d || jsonb_build_object('referral', jsonb_build_object('amount', amt));
  for r in select * from app.ref_rows() loop
    cids := app.ref_cids(r.friend_key); by_cid := upper(btrim(app.legacy(r.referrer_id)));
    o := jsonb_build_object('id', r.legacy_id, 'by', by_cid, 'byName', r.referrer_name, 'friend', r.friend, 'phone', r.friend_key, 'st', r.status,
      'd', to_char(r.created_at at time zone 'Asia/Beirut', 'YYYY-MM-DD'), 'cids', to_jsonb(cids), 'fcid', r.friend_cid, 'pkg', r.friend_pkg, 'amt', coalesce(r.credit, 0));
    if r.status = 'Invited' and not r.friend_key = any(seen) and amt > 0 then
      seen := seen || r.friend_key; due := '{}';
      foreach c in array cids loop
        if c <> by_cid and not exists (select 1 from app.ref_paid(c) x where x.num <= r.mark) then due := due || c; end if;
      end loop;
      o := o || jsonb_build_object('due', to_jsonb(due));
    end if;
    refs := refs || o;
  end loop;
  return d || jsonb_build_object('refs', refs);
end $$;

-- ---------------------------------------------------------------------
-- 8. the functions that gained a referral / settings line (full copies, only the marked lines are new)
-- ---------------------------------------------------------------------
-- App.gs appSell_: + referral (refOnSale_) at the end; the rest as in 0003
create or replace function public.sell_package(p_client uuid, p_type text, p_months int default 1, p_discount numeric default 0,
  p_price numeric default null, p_paid numeric default 0, p_start date default null, p_method text default 'Cash', p_use_wallet boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me jsonb := app.need(array['owner', 'assistant']); rw jsonb;
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
  -- first paid package of an invited friend: the client who invited them gets the referral credit (Referral.gs refOnSale_)
  rw := app.ref_on_sale(cl.id);
  return jsonb_build_object('id', ids[1], 'ids', to_jsonb(ids), 'uuids', to_jsonb(uids), 'total', total, 'walletUsed', app.jsround(used_w * 100) / 100)
    || case when rw is not null then jsonb_build_object('referral', rw) else '{}'::jsonb end;
end $$;

-- Client.gs clAddPkg_ (3 / 6 month offers): + referral check; the rest as in 0003
create or replace function app.add_pkg(p_client uuid, p_type text, p_price numeric, p_start date, p_disc_frac numeric, p_note text) returns text language plpgsql security definer set search_path = public as $$
declare t public.package_types; total int; lid text := app.next_legacy('PKG', 'public.packages', 4);
begin
  select * into t from public.package_types where name = p_type; total := coalesce(t.passes, 12);
  insert into public.packages (legacy_id, client_id, type_name, kind, passes, used, price_cents, paid_cents, discount_pct, start_date, expiry_date, effective_expiry, status, new_client, note)
  values (lid, p_client, p_type, app.kind_of(p_type), total, 0, round(p_price * 100), 0, p_disc_frac * 100, p_start, p_start + 30, p_start + 30, 'Active', false, p_note);
  perform app.ref_on_sale(p_client);   -- referral credit if this is an invited friend's first paid package (Client.gs clAddPkg_)
  return lid;
end $$;

-- Client.gs clRequest_: kind invite makes a referral (Referral.gs); the other kinds as in 0007
create or replace function public.api_app_cl_request(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cl uuid := app.ops_cid(p->>'cid'); me jsonb := app.ops_client_only(cl); nm text; k text := coalesce(p->>'kind', ''); note text := app.ops_clean(p->>'note', 400);
  nt text; pkg uuid; o jsonb; frm text; today date := app_today(); it jsonb; inv record; q numeric; lines text[] := '{}'; total numeric := 0; mins numeric; fn text; ph text; ref jsonb; ref_txt text; rid uuid;
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
    ref := app.ref_invite(cl, nm, fn, ph);   -- REFERRALS row (Referral.gs refInvite_); refuses your own number
    ref_txt := ' Referral ' || (ref->>'id') || case when ref->>'status' = 'Invited'
      then ': ' || nm || ' gets $' || app.jsnum(app.ref_amount()) || ' credit when ' || fn || ' buys a first paid package.'
      else ' (' || (ref->>'status') || ', no credit).' end;
    rid := app.client_log(cl, nm, 'Friend invite', nm || ' would like to invite ' || fn || ' (+' || ph || ') to Wellbe.' || ref_txt || ' Tap to send them the invite: '
      || 'https://wa.me/' || ph || '?text=' || app.ops_uri(left(coalesce(p->>'msg', ''), 300)), '', null, 'New', jsonb_build_object('fname', fn, 'phone', ph, 'ref', ref->>'id'));
    if not coalesce((ref->>'again')::boolean, false) then update public.referrals set request_id = rid where id = (ref->>'row')::uuid; end if;
    return jsonb_build_object('ref', jsonb_build_object('id', ref->'id', 'status', ref->'status'));
  end if;
  raise exception 'Unknown request';
end $$;

-- App.gs app_boot: + referral / refs (refStaffBoot_); the rest as in 0005
create or replace function public.api_app_boot(p jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c jsonb := app.caller(); v_role text := c->>'role'; st public.staff; today date := app_today();
  back int := app.setting_int('{windows,staffBack}', 70); ahead int := app.setting_int('{windows,ahead}', 35); see int := app.setting_int('{windows,trainerSee}', 60);
  bundle int := app.setting_int('{offers,bundleDays}', 70); month_start date := date_trunc('month', today)::date;
  ids uuid[]; trainer boolean; out jsonb; pk jsonb; cl jsonb;
begin
  if v_role not in ('owner', 'assistant', 'trainer') then raise exception 'auth'; end if;
  select * into st from public.staff where id = c->>'staff';
  trainer := v_role = 'trainer';
  out := jsonb_build_object('me', jsonb_build_object('id', st.id, 'name', st.name, 'role', st.role, 'trainer', st.trainer), 'today', app.ymd(today),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('t', name, 'n', passes, 'p', app.usd(price_cents), 'kind', kind) order by sort), '[]') from public.package_types where active),
    'cfg', public.public_cfg());

  -- clients a trainer may see: trained in the last trainerSee days or booked ahead (not cancelled)
  if trainer then
    select array_agg(distinct p.client_id) into ids
      from app.boot_sess(today - back, today + ahead) s join public.session_clients sc on sc.session_id = s.id join public.packages p on p.id = sc.package_id
     where s.trainer = st.trainer and s.status <> 'Cancelled' and s.day >= today - see;
    ids := coalesce(ids, '{}');
  end if;

  -- packages
  select coalesce(jsonb_agg(o order by lid), '[]') into pk from (
    select p.legacy_id as lid,
      case when trainer then jsonb_build_object('id', p.legacy_id, 'client', c2.legacy_id, 'name', c2.name, 'type', regexp_replace(p.type_name, '\s*\(\$[^)]*\)', ''), 'kind', p.kind,
             'total', p.passes, 'used', p.used, 'price', app.usd(greatest(0, p.price_cents - p.paid_cents)), 'paid', 0, 'start', app.ymd(p.start_date),
             'expiry', app.ymd(coalesce(p.effective_expiry, p.expiry_date)), 'status', p.status)
           else jsonb_build_object('id', p.legacy_id, 'row', p.legacy_id, 'client', c2.legacy_id, 'name', c2.name, 'type', p.type_name, 'total', p.passes, 'used', p.used,
             'price', app.usd(p.price_cents), 'paid', app.usd(p.paid_cents), 'start', app.ymd(p.start_date), 'expiry', app.ymd(coalesce(p.effective_expiry, p.expiry_date)),
             'status', p.status, 'kind', p.kind) end
      || case when exists (select 1 from public.client_requests q where q.package_id = p.id and q.type = 'Freeze' and q.status <> 'Declined') then '{"frozen":1}'::jsonb else '{}' end
      || case when p.type_name ~ 'x/month' and p.start_date is not null and (select count(*) from public.packages q where q.client_id = p.client_id and q.type_name = p.type_name
                and q.start_date is not null and abs(q.start_date - p.start_date) <= bundle) >= 3 then '{"months":3}'::jsonb else '{}' end
      || case when p.discount_pct <> 0 then jsonb_build_object('disc', p.discount_pct / 100) else '{}' end as o
      from public.packages p join public.clients c2 on c2.id = p.client_id
     where not trainer or p.client_id = any(ids)) x;

  -- clients, their medical notes, last coach notes and promise
  select coalesce(jsonb_agg(o order by app.cnum(lid), lid), '[]') into cl from (
    select c2.legacy_id as lid,
      jsonb_build_object('id', c2.legacy_id, 'name', c2.name, 'email', case when trainer then '' else coalesce(c2.email, '') end, 'phone', case when trainer then '' else coalesce(c2.phone, '') end,
        'notes', coalesce(n.always_show, ''), 'program', coalesce(n.program, ''),
        'log', coalesce((select jsonb_agg(jsonb_build_object('d', app.ymd(l.day), 'sid', coalesce((select legacy_id from public.sessions where id = l.session_id), ''), 'by', coalesce(l.by_staff, ''), 't', l.note) order by l.logged_at desc)
                          from (select * from public.session_notes where client_id = c2.id order by logged_at desc limit 8) l), '[]'))
      || case when trainer then jsonb_build_object('mel', n.client_id is not null and c2.is_mel)
              when n.client_id is not null then jsonb_build_object('mel', c2.is_mel, 'disc', c2.discount_pct) else '{}' end
      || coalesce(jsonb_build_object('goal', app.goal_json(c2.id)) - case when app.goal_json(c2.id) is null then 'goal' else '' end, '{}') as o
      from public.clients c2 left join public.client_notes n on n.client_id = c2.id
     where c2.kind = 'client' and c2.legacy_id ~ '^C\d+$' and c2.deleted_at is null and (not trainer or c2.id = any(ids))) x;

  out := out || jsonb_build_object('sessions', app.boot_sess_json(today - back, today + ahead, case when trainer then st.trainer end), 'clients', cl, 'pkgs', pk);

  if trainer then
    out := out || jsonb_build_object('intakes', (select coalesce(jsonb_agg(app.intake_json(i) order by i.created_at), '[]') from public.physio_intake i where i.client_id = any(ids)),
      'leads', '[]'::jsonb, 'leadFollowups', '[]'::jsonb, 'expenses', '[]'::jsonb, 'recurring', '[]'::jsonb, 'pos', '[]'::jsonb, 'inventory', '[]'::jsonb);
  else
    out := out || jsonb_build_object(
      'leads', (select coalesce(jsonb_agg(jsonb_build_object('id', l.legacy_id, 'row', l.legacy_id, 'name', coalesce(l.name, ''), 'phone', coalesce(l.phone, ''), 'date', app.ymd(l.trial_date),
                  'time', coalesce(l.trial_time, ''), 'type', coalesce(l.booking_type, ''), 'status', l.status, 'injuries', coalesce(nullif(l.injuries, ''), 'No'), 'why', coalesce(l.why_now, ''),
                  'submitted', to_char(l.submitted_at at time zone 'Asia/Beirut', 'DD/MM/YYYY HH24:MI:SS')) order by l.sheet_row nulls last, l.submitted_at, l.legacy_id), '[]')
                  from public.leads l where l.status not in ('Cancelled', 'No Answer')),
      'leadFollowups', (select coalesce(jsonb_agg(jsonb_build_object('id', f.legacy_id, 'row', f.legacy_id, 'name', coalesce(f.name, ''), 'phone', coalesce(f.phone, ''), 'stage', f.stage, 'status', f.status,
                  'submitted', to_char(f.submitted_at at time zone 'Asia/Beirut', 'YYYY-MM-DD HH24:MI'), 'date', app.ymd(f.trial_date), 'time', coalesce(f.trial_time, '')) order by f.submitted_at, f.legacy_id), '[]')
                  from public.lead_followups f),
      'requests', (select coalesce(jsonb_agg(app.req_json(q) order by q.created_at, q.legacy_id), '[]') from public.client_requests q where q.status = 'New'));
    if v_role = 'owner' then
      out := out || jsonb_build_object(
        'intakes', (select coalesce(jsonb_agg(app.intake_json(i) order by i.created_at), '[]') from public.physio_intake i),
        'files', (select coalesce(jsonb_agg(jsonb_build_object('cid', c2.legacy_id, 'name', f.file_name, 'url', f.storage_path, 'type', coalesce(f.file_type, ''), 'by', coalesce(f.uploaded_by, ''), 'date', app.ymd(f.day)) order by f.created_at), '[]')
                    from public.client_files f join public.clients c2 on c2.id = f.client_id));
    end if;
    out := out || jsonb_build_object(
      'expenses', (select coalesce(jsonb_agg(jsonb_build_object('d', app.ymd(e.day), 'what', e.what, 'cat', coalesce(e.category, ''), 'amt', app.usd(e.amount_cents)) order by e.created_at), '[]')
                     from public.expenses e where v_role = 'owner' or e.day >= month_start - 31),
      'recurring', (select coalesce(jsonb_agg(jsonb_build_object('id', r.legacy_id, 'what', r.what, 'cat', coalesce(r.category, ''), 'amt', app.usd(r.amount_cents), 'every', r.every,
                     'start', app.ymd(r.first_day), 'end', app.ymd(r.end_day), 'last', app.ymd(r.last_logged)) order by r.legacy_id), '[]') from public.recurring_expenses r where r.active),
      'inventory', (select coalesce(jsonb_agg(jsonb_build_object('p', i.item, 'left', i.stock, 'price', app.usd(i.price_cents), 'cost', app.usd(i.cost_cents)) order by i.created_at), '[]') from public.inventory i),
      'pos', (select coalesce(jsonb_agg(jsonb_build_object('d', app.ymd((s.at at time zone 'Asia/Beirut')::date), 'p', s.item, 'to', s.to_name, 'qty', s.qty, 'price', app.usd(s.amount_cents), 'profit', app.usd(s.profit_cents)) order by s.at), '[]')
                from public.pos_sales s where v_role = 'owner' or (s.at at time zone 'Asia/Beirut')::date >= month_start));
  end if;

  -- wallet balances (Wallet.gs walletMap_) and insurance (Insurance.gs insBoot_); trainers: their own clients, no claims
  out := out || jsonb_build_object('wallet', (select coalesce(jsonb_object_agg(c2.legacy_id, app.usd(w.bal)), '{}') from
      (select client_id, sum(amount_cents) bal from public.wallet_ledger group by 1 having sum(amount_cents) <> 0) w join public.clients c2 on c2.id = w.client_id
      where not trainer or w.client_id = any(ids)));
  if trainer then
    out := out || jsonb_build_object('ins', jsonb_build_object('clients', (select coalesce(jsonb_agg(jsonb_build_object('cid', c2.legacy_id, 'name', c2.name, 'insurer', i.insurer) order by i.created_at), '[]')
      from public.insurance_clients i join public.clients c2 on c2.id = i.client_id where i.client_id = any(ids)), 'claims', '[]'::jsonb));
  else
    out := out || jsonb_build_object('ins', jsonb_build_object(
      'clients', (select coalesce(jsonb_agg(jsonb_build_object('cid', c2.legacy_id, 'name', c2.name, 'insurer', i.insurer, 'member', coalesce(i.member_number, ''), 'notes', coalesce(i.notes, ''),
                    'rate', coalesce(case when i.rate_cents > 0 then app.usd(i.rate_cents) end, (app.setting('{insurance,rate}'))::text::numeric)) order by i.created_at), '[]')
                    from public.insurance_clients i join public.clients c2 on c2.id = i.client_id),
      'claims', (select coalesce(jsonb_agg(jsonb_build_object('id', k.legacy_id, 'cid', c2.legacy_id, 'name', c2.name, 'insurer', k.insurer, 'month', to_char(k.month, 'YYYY-MM'),
                    'sessions', k.sessions, 'amount', app.usd(k.amount_cents),
                    'pkgs', coalesce((select string_agg(p.legacy_id, ', ' order by x.o) from unnest(k.package_ids) with ordinality x(id, o) join public.packages p on p.id = x.id), ''),
                    'submitted', app.ymd(k.submitted), 'expected', app.ymd(k.expected), 'ref', coalesce(k.reference, ''), 'status', k.status, 'paidOn', app.ymd(k.paid_on),
                    'paidAmount', app.usd(k.paid_cents)) order by k.legacy_id), '[]')
                  from public.insurance_claims k join public.clients c2 on c2.id = k.client_id)));
  end if;
  out := app.ref_staff_boot(out, v_role);   -- referrals (Referral.gs refStaffBoot_): owner and front desk
  return out || jsonb_build_object('notices', app.notices_json(st.id, null));
end $$;

-- Client.gs app_cl_boot: + accounts[].refs / credit (refClientBoot_); the rest as in 0005
create or replace function public.api_app_cl_boot(p jsonb default '{}'::jsonb) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c jsonb := app.caller(); v_role text := c->>'role'; v_email text; today date := app_today(); nowms bigint := app.ms(now());
  back int := app.setting_int('{windows,clientBack}', 45); fwd int := greatest(app.setting_int('{windows,ahead}', 35), app.setting_int('{windows,physioDays}', 14));
  join_h int := app.setting_int('{windows,joinMinH}', 48); join_days int := app.setting_int('{windows,joinDays}', 10);
  seats int := least(coalesce((app.setting('{services,1:3,cap}'))::text::int, 3), 3); blocked jsonb := coalesce(app.setting('{hours,blocked}'), '[]');
  ids uuid[]; g public.clients; a public.clients; acc jsonb; accounts jsonb := '[]'; ins public.insurance_clients; out jsonb; trial jsonb;
  p13 public.packages; can_join int; open jsonb; grid jsonb; d date; dow int; h text; v_o jsonb; ss_n int; ss_full boolean; ss_tr text; photo text;
  center jsonb := app.setting('{center}'); offers jsonb := app.setting('{offers}');
begin
  if v_role not in ('client', 'guest') then raise exception 'signin'; end if;
  v_email := lower((app.me()).email);
  select array_agg(x.id order by app.cnum(x.legacy_id), x.legacy_id) into ids from public.clients x
   where x.kind = 'client' and x.deleted_at is null and (lower(x.email) = v_email or lower(x.parent_email) = v_email);

  out := jsonb_build_object('today', app.ymd(today), 'now', nowms, 'email', v_email, 'review', center->'review', 'wa', center->'wa', 'friend', center->'friend',
    'physio', jsonb_build_object('price', offers->'physioPrice', 'was', offers->'physioWas'));

  -- ---------- guest ----------
  if ids is null then
    select * into g from public.clients x where x.kind = 'guest' and x.deleted_at is null and lower(x.email) = v_email order by x.created_at desc limit 1;
    if g.id is null then raise exception 'signin'; end if;
    select jsonb_build_object('date', app.ymd(l.trial_date), 'time', coalesce(l.trial_time, ''), 'status', l.status) into trial
      from public.leads l where l.id = g.lead_id and l.trial_date is not null and l.status ~ 'Pending|Confirmed';
    acc := jsonb_build_object('cid', g.legacy_id, 'name', g.name, 'first', split_part(g.name, ' ', 1), 'full', false, 'guest', true, 'pkgs', '[]'::jsonb,
      'upcoming', '[]'::jsonb, 'past', '[]'::jsonb, 'requests', '[]'::jsonb, 'goal', app.goal_json(g.id));
    select storage_path into photo from public.client_photos where client_id = g.id;
    if photo is not null then acc := acc || jsonb_build_object('photo', photo); end if;
    return out || jsonb_build_object('guest', jsonb_build_object('id', g.legacy_id, 'phone', coalesce(g.phone, ''), 'trial', trial, 'asked', g.guest_asked,
        'slots', case when trial is null then app.trial_days() else '[]'::jsonb end, 'packages', app.shop_types()),
      'slots', '[]'::jsonb, 'shop', '[]'::jsonb, 'accounts', jsonb_build_array(acc), 'brand', app.brand(), 'cfg', public.public_cfg(),
      'notices', app.notices_json(null, array[g.id]));
  end if;

  -- ---------- client: the sessions window, once ----------
  create temp table if not exists _s on commit drop as select * from app.boot_sess(today, today) limit 0;
  truncate _s; insert into _s select * from app.boot_sess(today - back, today + fwd);
  -- clients per trainer and hour, for trainers with a max per hour (same rule as trainerLoad_)
  create temp table if not exists _load (trainer text, day date, h int, n int) on commit drop; truncate _load;
  insert into _load select s.trainer, s.day, split_part(s.hm, ':', 1)::int, sum(s.n) from _s s
   where app.trainer_cap(s.trainer) > 0 and s.tab in ('1:1', '1:2', '1:3') and s.status <> 'Cancelled' group by 1, 2, 3;

  for a in select * from public.clients x where x.id = any(ids) order by app.cnum(x.legacy_id), x.legacy_id loop
    create temp table if not exists _pk (pr public.packages, ph text, ord int) on commit drop; truncate _pk;
    insert into _pk select x, app.cl_phase(x, today), row_number() over (order by coalesce(app.ymd(x.start_date), ''), x.legacy_id)
      from public.packages x where x.client_id = a.id;
    create temp table if not exists _my (o jsonb, at bigint, att text, pkg text, tab text, day date, ord int, lid text, slot int) on commit drop; truncate _my;
    insert into _my select jsonb_build_object('id', s.legacy_id, 'ref', s.k || '|' || s.legacy_id, 'tab', s.tab, 'date', app.ymd(s.day), 'start', s.hm, 'end', s.hm_end, 'trainer', s.trainer,
        'i', sc.slot, 'pkg', p.legacy_id, 'att', coalesce(nullif(sc.att, ''), case when s.status = 'Cancelled' then 'Cancelled' else '' end), 'group', s.n, 'at', s.at_ms),
        s.at_ms, coalesce(nullif(sc.att, ''), case when s.status = 'Cancelled' then 'Cancelled' else '' end), p.legacy_id, s.tab, s.day, s.ord, s.legacy_id, sc.slot
      from _s s join public.session_clients sc on sc.session_id = s.id join public.packages p on p.id = sc.package_id where p.client_id = a.id;
    create temp table if not exists _rq (q public.client_requests) on commit drop; truncate _rq;
    insert into _rq select q from public.client_requests q where q.client_id = a.id order by q.created_at desc, q.legacy_id desc limit 30;

    acc := jsonb_build_object('cid', a.legacy_id, 'name', btrim(a.name), 'first', split_part(btrim(a.name), ' ', 1),
      'full', exists (select 1 from _pk where ph in ('current', 'future')),
      'pkgs', (select coalesce(jsonb_agg(jsonb_build_object('id', (x.pr).legacy_id, 'label', regexp_replace(regexp_replace((x.pr).type_name, '\s*\(\$[^)]*\)', ''), '\s*\(Free\)', ' (free)', 'i'),
                 'kind', (x.pr).kind, 'total', (x.pr).passes, 'used', (x.pr).used, 'left', greatest(0, (x.pr).passes - (x.pr).used), 'start', app.ymd((x.pr).start_date), 'end', app.ymd(app.cl_end(x.pr)),
                 'status', btrim((x.pr).status), 'phase', x.ph, 'due', app.usd(greatest(0, (x.pr).price_cents - (x.pr).paid_cents)), 'price', app.usd((x.pr).price_cents)) order by x.ord), '[]') from _pk x),
      'upcoming', (select coalesce(jsonb_agg(o order by at, ord, lid, slot), '[]') from _my where att = '' and at > nowms - 3600000),
      'past', (select coalesce(jsonb_agg(o order by at desc, ord desc, lid desc, slot desc), '[]') from _my where day >= today - 30 and (att <> '' or at <= nowms - 3600000) and day <= today),
      'requests', (select coalesce(jsonb_agg(app.req_json(x.q) order by (x.q).created_at desc, (x.q).legacy_id desc), '[]') from _rq x),
      'goal', app.goal_json(a.id));

    if (acc->>'full')::boolean then
      -- freeze: once per package, current or future
      acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(case when e->>'phase' = 'past' then e else e || jsonb_build_object(
               'canFreeze', not exists (select 1 from _rq x where (x.q).type = 'Freeze' and (x.q).status <> 'Declined' and (x.q).package_id = (select id from public.packages where legacy_id = e->>'id')),
               'frozen', exists (select 1 from _rq x where (x.q).type = 'Freeze' and (x.q).status <> 'Declined' and (x.q).package_id = (select id from public.packages where legacy_id = e->>'id'))) end order by n), '[]')
             from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));
      acc := acc || jsonb_build_object('offers', (select coalesce(jsonb_object_agg(k, v - 'pkgId'), '{}') from jsonb_each(app.offers(a.id)) x(k, v)));
      acc := acc || jsonb_build_object('physio', jsonb_build_object(
        'show', exists (select 1 from _pk where ph in ('current', 'future') and (pr).kind in ('1:1', '1:2', '1:3')) and not exists (select 1 from _pk where ph in ('current', 'future') and (pr).kind = 'Prehab'),
        'recent', exists (select 1 from _my where tab in ('Physio', 'Prehab') and day >= today - 28 and att !~* 'cancel'),
        'pending', exists (select 1 from _rq x where (x.q).type = 'Physio visit' and (x.q).status = 'New')));
      -- open 1:3 spots: 48h+ ahead, free chair, trainer under their cap, passes left
      select (x.pr).* into p13 from _pk x where x.ph = 'current' and (x.pr).kind = '1:3' and (x.pr).passes - (x.pr).used > 0 order by x.ord limit 1;
      open := '[]';
      if p13.id is not null then
        can_join := greatest(0, p13.passes - p13.used) - (select count(*) from _my where att = '' and at > nowms - 3600000 and pkg = p13.legacy_id);
        acc := acc || jsonb_build_object('canJoin', can_join);
        if can_join > 0 then
          select coalesce(jsonb_agg(jsonb_build_object('id', s.legacy_id, 'date', app.ymd(s.day), 'start', s.hm, 'trainer', s.trainer, 'spots', seats - s.n, 'at', s.at_ms) order by s.at_ms, s.ord, s.legacy_id), '[]') into open
            from _s s
           where s.tab = '1:3' and s.status <> 'Cancelled' and s.n < seats and s.at_ms - nowms >= join_h * 3600000::bigint and s.day <= today + join_days
             and not exists (select 1 from public.session_clients sc join public.packages p on p.id = sc.package_id where sc.session_id = s.id and p.client_id = a.id)
             and not (app.trainer_cap(s.trainer) > 0 and coalesce((select n from _load l where l.trainer = s.trainer and l.day = s.day and l.h = split_part(s.hm, ':', 1)::int), 0) >= app.trainer_cap(s.trainer))
             and not coalesce(s.day > app.cl_end(p13), false);
        end if;
        -- the semi private calendar (Client.gs clGrid_)
        grid := '[]';
        for i in 1 .. join_days loop
          d := today + i; dow := extract(dow from d)::int;
          if dow = 0 or blocked ? app.ymd(d) or coalesce(d > app.cl_end(p13), false) then continue; end if;
          for h in select distinct x.hm from (
                select s.hm from _s s where s.tab = '1:3' and s.status <> 'Cancelled' and s.day < today and extract(dow from s.day) = dow group by s.hm having count(*) >= 2
                union select s.hm from _s s where s.tab = '1:3' and s.status <> 'Cancelled' and s.day = d) x order by 1 loop
            if exists (select 1 from _s s join public.session_clients sc on sc.session_id = s.id join public.packages p on p.id = sc.package_id
                        where s.status <> 'Cancelled' and s.day = d and s.hm = h and p.client_id = a.id and sc.att !~* 'cancel') then continue; end if;
            v_o := null;
            select e into v_o from jsonb_array_elements(open) e where e->>'date' = app.ymd(d) and e->>'start' = h limit 1;
            if v_o is not null then grid := grid || jsonb_build_object('date', app.ymd(d), 'start', h, 'trainer', v_o->'trainer', 'spots', v_o->'spots', 'state', 'instant'); continue; end if;
            select count(*), bool_and(s.n >= seats), (array_agg(s.trainer order by s.ord, s.legacy_id))[1] into ss_n, ss_full, ss_tr
              from _s s where s.tab = '1:3' and s.status <> 'Cancelled' and s.day = d and s.hm = h;
            if ss_n > 0 and ss_full then grid := grid || jsonb_build_object('date', app.ymd(d), 'start', h, 'trainer', ss_tr, 'state', 'full'); continue; end if;
            grid := grid || jsonb_build_object('date', app.ymd(d), 'start', h, 'trainer', coalesce(ss_tr, ''), 'state', 'request');
          end loop;
        end loop;
        acc := acc || jsonb_build_object('grid', grid);
      end if;
      acc := acc || jsonb_build_object('open', open);
    end if;

    -- insured clients never see money owed (Insurance.gs insClientBoot_)
    select * into ins from public.insurance_clients where client_id = a.id;
    if ins.client_id is not null then
      acc := acc || jsonb_build_object('insurer', ins.insurer);
      acc := jsonb_set(acc, '{pkgs}', (select coalesce(jsonb_agg(e || jsonb_build_object('due', 0, 'ins', ins.insurer) order by n), '[]') from jsonb_array_elements(acc->'pkgs') with ordinality t(e, n)));
    end if;
    select storage_path into photo from public.client_photos where client_id = a.id;
    if photo is not null then acc := acc || jsonb_build_object('photo', photo); end if;
    acc := app.ref_client_acc(a.id, acc);   -- "Your invites" + wallet credit (Referral.gs refClientBoot_)
    accounts := accounts || acc;
  end loop;

  return out || jsonb_build_object('accounts', accounts, 'slots', app.physio_slots(),
    'shop', (select coalesce(jsonb_agg(jsonb_build_object('n', i.item, 'price', app.usd(i.price_cents), 'left', greatest(0, i.stock)) order by i.created_at), '[]') from public.inventory i where i.price_cents > 0),
    'packages', app.shop_types(), 'brand', app.brand(), 'cfg', public.public_cfg(), 'notices', app.notices_json(null, ids));
end $$;

-- Config.gs cfgPublic_: clients never get game.staffClients; the rest as in 0003
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
  if client then out := out #- '{game,staffClients}'; end if;   -- cfgPublic_: client apps never get the staff client IDs
  if out #> '{services,1:3}' is not null and app.setting('{trial,trainer}') is not null then
    out := jsonb_set(out, '{services,1:3,trainer}', app.setting('{trial,trainer}'));
  end if;
  return out;
end $$;

-- ---------------------------------------------------------------------
-- 9. who may call what (the API door 0008 reaches public.api_*; run select app.api_sync(); after this file)
-- ---------------------------------------------------------------------
-- the new helpers are internal: nobody calls them directly (0012's own helpers keep their grants)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = any(array['clock', 'js_str', 'phone_key', 'ref_amount', 'ref_cids', 'ref_client_acc', 'ref_invite', 'ref_links', 'ref_on_sale', 'ref_paid', 'ref_pkg_max', 'ref_pkg_num', 'ref_rows', 'ref_staff_boot', 'run_amt', 'run_badge_name', 'run_badge_set', 'run_boards', 'run_call', 'run_cause', 'run_first', 'run_km', 'run_ladder_order', 'run_ladder_val', 'run_ladders', 'run_lb_name', 'run_name_check', 'run_num', 'run_outfit', 'run_outfits', 'run_short', 'run_studio', 'run_tier_text', 'run_who', 'shop_keys']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
revoke execute on function public.api_app_cl_run(jsonb), public.api_app_cl_request(jsonb), public.api_app_boot(jsonb), public.api_app_cl_boot(jsonb) from public, anon, authenticated;
grant execute on function public.sell_package, public.game_save_run, public.game_redeem, public.game_shop, public.public_cfg to authenticated;
do $$ begin
  if to_regprocedure('app.api_sync()') is not null then perform app.api_sync(); end if;   -- the door already exists (0008 applied): keep the action list current
end $$;
