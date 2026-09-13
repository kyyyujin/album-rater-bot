-- Phase 1 correction: activation marks a per-user start, it is never a baseline.
alter table public.vault_achievement_state
  add column if not exists achievement_tracking_started_at timestamptz;

-- Server database time is authoritative. The client event timestamp is ignored,
-- so a browser cannot backdate an event before its activation point.
create or replace function public.achievement_save_collection_events(p_username text, p_collection jsonb, p_events jsonb)
returns table(event_id uuid, inserted boolean) language plpgsql security definer set search_path = public as $$
declare e jsonb; existing uuid; generated uuid;
begin
  update public.users set vault_collection = p_collection where username = p_username;
  if not found then raise exception 'Unknown Vault user'; end if;
  for e in select value from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) loop
    select ve.event_id into existing from public.vault_achievement_events ve where ve.user_id=p_username and ve.idempotency_key=e->>'idempotency_key';
    if existing is not null then event_id:=existing; inserted:=false; return next; continue; end if;
    generated := coalesce(nullif(e->>'event_id','')::uuid, gen_random_uuid());
    insert into public.vault_achievement_events(event_id,user_id,occurred_at,type,payload_version,payload,source,idempotency_key)
    values(generated,p_username,now(),e->>'type',coalesce((e->>'payload_version')::int,1),coalesce(e->'payload','{}'::jsonb),coalesce(e->>'source','vault'),e->>'idempotency_key')
    on conflict(user_id,idempotency_key) do nothing;
    select ve.event_id into existing from public.vault_achievement_events ve where ve.user_id=p_username and ve.idempotency_key=e->>'idempotency_key';
    event_id:=existing; inserted := existing=generated; return next;
  end loop;
end $$;

-- Private beta reset for the existing owner. Only achievement-system rows are
-- removed; no Vault collection, rating, review, profile, or Rater row is touched.
do $$
declare beta_user text; only_baseline boolean;
begin
  select username into beta_user from public.users where lower(username)='kyujin' limit 1;
  if beta_user is not null then
    select not exists(select 1 from public.vault_achievement_events where user_id=beta_user and source <> 'baseline_activation') into only_baseline;
    if only_baseline then
    delete from public.vault_achievement_showcase where user_id=beta_user;
    delete from public.vault_achievement_inbox where user_id=beta_user;
    delete from public.vault_achievement_unlocks where user_id=beta_user;
    delete from public.vault_achievement_progress where user_id=beta_user;
    delete from public.vault_personal_records where user_id=beta_user;
    delete from public.vault_achievement_events where user_id=beta_user and source='baseline_activation';
    insert into public.vault_achievement_state(user_id,achievement_tracking_started_at,last_evaluated_at,updated_at)
    values(beta_user,now(),now(),now())
    on conflict(user_id) do update set achievement_tracking_started_at=excluded.achievement_tracking_started_at,last_evaluated_at=excluded.last_evaluated_at,baseline_activated_at=null,baseline_version=null,updated_at=now();
    end if;
  end if;
end $$;

-- Install this only after the one-time correction. The Memory Card and the
-- identity/timestamp of an unlock are archival data. Privacy flags may evolve
-- later without ever rewriting the historical card itself.
create or replace function public.prevent_achievement_unlock_mutation()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Achievement unlocks cannot be deleted';
  end if;
  if new.user_id is distinct from old.user_id
     or new.achievement_key is distinct from old.achievement_key
     or new.level is distinct from old.level
     or new.unlocked_at is distinct from old.unlocked_at
     or new.source is distinct from old.source
     or new.rule_version is distinct from old.rule_version
     or new.snapshot is distinct from old.snapshot
     or new.created_at is distinct from old.created_at then
    raise exception 'Achievement unlock memory is immutable';
  end if;
  return new;
end $$;
drop trigger if exists vault_achievement_unlocks_immutable on public.vault_achievement_unlocks;
create trigger vault_achievement_unlocks_immutable
before update or delete on public.vault_achievement_unlocks
for each row execute function public.prevent_achievement_unlock_mutation();

-- A running legacy server must never recreate a historical baseline during a
-- rolling deploy. New Phase 1 code does not emit either of these values.
create or replace function public.reject_legacy_achievement_baseline()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.source = 'baseline_activation' or new.type = 'collection_baselined' then
    raise exception 'Historical achievement baselines are disabled; tracking starts at activation';
  end if;
  return new;
end $$;
drop trigger if exists vault_achievement_events_reject_legacy_baseline on public.vault_achievement_events;
create trigger vault_achievement_events_reject_legacy_baseline
before insert on public.vault_achievement_events
for each row execute function public.reject_legacy_achievement_baseline();

-- Trigger functions are internal implementation details, never RPC endpoints.
revoke all on function public.prevent_achievement_unlock_mutation() from public, anon, authenticated;
revoke all on function public.reject_legacy_achievement_baseline() from public, anon, authenticated;
grant execute on function public.prevent_achievement_unlock_mutation() to service_role;
grant execute on function public.reject_legacy_achievement_baseline() to service_role;
