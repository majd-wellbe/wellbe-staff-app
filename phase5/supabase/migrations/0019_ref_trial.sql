-- 0019 Referral credit on the friend's free trial attended (same rule as Referral.gs f6f756c, 2 Nov 2026).
-- The referrer gets the credit when the invited friend attends the free trial (trial package used >= 1, not cancelled)
-- or buys a first paid package after the invite. Daily check at 07:05 Beirut. Amount = settings referral.amount (sheet: 10).
create or replace function app.ref_trial(p_cid text)
returns table(id text, num integer) language sql stable security definer set search_path to 'public' as $$
  select p.legacy_id, app.ref_pkg_num(p.legacy_id) from public.packages p join public.clients c on c.id = p.client_id
    join public.package_types t on t.name = p.type_name
   where upper(btrim(c.legacy_id)) = p_cid and p.legacy_id ~* '^PKG-' and t.trial and coalesce(p.used, 0) >= 1 and coalesce(p.status, '') !~* 'cancel'
   order by 2, 1 $$;

create or replace function app.ref_on_sale(p_client uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare amt numeric := app.ref_amount(); v_cid text := upper(btrim(coalesce(app.legacy(p_client), ''))); keys text[]; r public.referrals; bef record; aft record; pid uuid;
  by_cid text; by_name text; v_reason text;
begin
  if amt = 0 or v_cid !~ '^C\d+$' then return null; end if;
  if not exists (select 1 from public.referrals) then return null; end if;
  if not exists (select 1 from app.ref_paid(v_cid)) and not exists (select 1 from app.ref_trial(v_cid)) then return null; end if;
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
  select * into aft from (select * from app.ref_paid(v_cid) union all select * from app.ref_trial(v_cid)) x where x.num > r.mark order by x.num, x.id limit 1;
  if bef.id is null and aft.id is null then return null; end if;
  if bef.id is not null then
    update public.referrals set status = 'Already a client', friend_cid = v_cid,
      note = 'Paid package ' || bef.id || ' was there before the invite' where id = r.id;
    return null;
  end if;
  by_name := coalesce(nullif((select name from public.clients where id = r.referrer_id), ''), r.referrer_name);
  v_reason := 'Referral: ' || r.friend; pid := (select id from public.packages where legacy_id = aft.id limit 1);
  if not exists (select 1 from public.wallet_ledger w where w.client_id = r.referrer_id and regexp_replace(coalesce(w.reason, ''), '^''', '') = v_reason and w.package_id is not distinct from pid) then
    insert into public.wallet_ledger (day, client_id, amount_cents, reason, package_id, by_who) values ((app.clock() at time zone 'Asia/Beirut')::date, r.referrer_id, round(amt * 100), v_reason, pid, 'auto');
  end if;
  update public.referrals set status = 'Rewarded', friend_cid = v_cid, friend_pkg = aft.id, credit = amt, rewarded_at = app.clock() where id = r.id;
  perform app.notice(r.referrer_id, null, 'Referral credit', split_part(r.friend, ' ', 1) || ' came to the free trial. $' || app.jsnum(amt) || ' Wellbe Credit is ready for your next package. Thank you for sharing Wellbe!');
  return jsonb_build_object('id', r.legacy_id, 'by', by_cid, 'byName', by_name, 'friend', r.friend, 'amount', amt, 'pkg', aft.id);
exception when others then
  raise warning 'Referral check failed for %: %', v_cid, sqlerrm;
  return null;
end $function$;

-- daily: every client linked to an Invited friend phone is checked once (same as refCheckAll)
create or replace function app.job_ref_check() returns int
language plpgsql security definer set search_path to 'public' as $$
declare c record; n int := 0;
begin
  for c in select distinct cl.id from public.referrals r join app.ref_links() x on x.key = r.friend_key
             join public.clients cl on upper(btrim(cl.legacy_id)) = x.cid where r.status = 'Invited' loop
    if app.ref_on_sale(c.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function app.job_ref_check() from public, anon, authenticated;
revoke all on function app.ref_trial(text) from public, anon, authenticated;

update public.settings set value = jsonb_set(coalesce(value, '{}'::jsonb), '{amount}', '10'::jsonb), updated_at = now() where key = 'referral';

select cron.unschedule(jobid) from cron.job where jobname = 'wellbe-ref-check';
-- 05:05 UTC = 07:05 Beirut in winter (Referral.gs runs at 7am)
select cron.schedule('wellbe-ref-check', '5 5 * * *', 'select app.job_ref_check()');
