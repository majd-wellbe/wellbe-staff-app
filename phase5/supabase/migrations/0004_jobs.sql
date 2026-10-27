-- =====================================================================
-- WELLBE on Supabase: 0004 scheduled jobs (pg_cron, inside Supabase, free)
--  21:30 Beirut  everyone not marked today is Present          (was: appDefaultPresent trigger)
--  every minute  send WhatsApp / email / push from the outbox   (was: flushNotify_)
--  every 5 min   write queued nutrition plans                   (was: nutWorker trigger)
-- Lebanon changes clock in summer, so the 21:30 job runs at both possible UTC times and checks Beirut time itself.
-- On a database without pg_cron (local tests) this file does nothing.
-- The two worker jobs call edge functions with pg_net: they need the project URL and the service key in Vault:
--   TODO(Majd): Supabase > Project Settings > Vault: add secrets project_url and service_role_key (README step "Jobs").
-- =====================================================================
create or replace function app.job_default_present() returns int language plpgsql security definer set search_path = public as $$
begin
  if to_char(now() at time zone coalesce(app.setting('{center,tz}') #>> '{}', 'Asia/Beirut'), 'HH24') <> '21' then return 0; end if;
  return public.default_present();
end $$;

create or replace function app.call_function(name text) returns void language plpgsql security definer set search_path = public as $$
-- the parameter "name" would clash with vault.decrypted_secrets.name: the table is aliased and the parameter copied to fn (fixed live 27 Oct 2026)
declare u text; k text; fn text := name;
begin
  select s.decrypted_secret into u from vault.decrypted_secrets s where s.name = 'project_url';
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'service_role_key';
  if u is null or k is null then return; end if;     -- not set up yet: nothing is sent
  perform net.http_post(url := u || '/functions/v1/' || fn, headers := jsonb_build_object('Authorization', 'Bearer ' || k, 'Content-Type', 'application/json'), body := '{}'::jsonb);
end $$;

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('wellbe-default-present', '30 18,19 * * *', 'select app.job_default_present()');
    if exists (select 1 from pg_available_extensions where name = 'pg_net') then
      create extension if not exists pg_net;
      perform cron.schedule('wellbe-outbox', '* * * * *', 'select app.call_function(''outbox-worker'')');
      perform cron.schedule('wellbe-nutrition', '*/5 * * * *', 'select app.call_function(''nutrition-worker'')');
    end if;
  else
    raise notice 'pg_cron is not available here: jobs not scheduled (normal for local tests)';
  end if;
end $$;
revoke execute on function app.job_default_present(), app.call_function(text) from public, anon, authenticated;
