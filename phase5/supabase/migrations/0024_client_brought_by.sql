-- 0024 (24 Nov 2026, applied live) "Brought by": the trainer who brought the client in. A trainer with pay.bring (a %) earns that %
-- of every 1:1 / 1:2 / 1:3 package his clients buy (first one and renewals), in the month the package starts. Computed in the staff app payroll.
-- Live changes: clients.brought_by; api_app_boot sends 'by' per client to owner / front desk (anchored replace of the 'mel','disc' object);
-- api_app_cedit and api_app_client accept { by: staff id }; staff simon pay.bring = 20.
alter table public.clients add column if not exists brought_by text;
-- (see the applied migration "client_brought_by" in Supabase for the function bodies)
update public.staff set pay = pay || '{"bring":20}'::jsonb where id = 'simon';
