-- Album Vault Phase 1: private, server-authorized achievement foundation.
create table if not exists public.vault_achievement_definitions (
  key text primary key, title text not null, category text not null default 'Vault', rarity text not null,
  max_level integer not null default 1 check (max_level between 1 and 5), rule_version integer not null default 1,
  enabled boolean not null default true, is_secret boolean not null default false, client_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.vault_achievement_events (
  event_id uuid primary key default gen_random_uuid(), user_id text not null, occurred_at timestamptz not null,
  type text not null check (type in ('album_rated','album_added','review_written','review_updated','album_rescored','track_scores_saved','collection_baselined')),
  payload_version integer not null default 1, payload jsonb not null default '{}'::jsonb, source text not null,
  idempotency_key text not null, processed_at timestamptz, processing_error text, unlock_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), unique(user_id,idempotency_key)
);
create index if not exists vault_achievement_events_pending_idx on public.vault_achievement_events(user_id, processed_at, occurred_at);
create table if not exists public.vault_achievement_progress (
  user_id text not null, achievement_key text not null references public.vault_achievement_definitions(key),
  current_level integer not null default 0, current_value numeric, target_value numeric, evaluated_at timestamptz not null default now(),
  primary key(user_id,achievement_key)
);
create table if not exists public.vault_achievement_unlocks (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  achievement_key text not null references public.vault_achievement_definitions(key), level integer not null default 1,
  unlocked_at timestamptz not null default now(), source text not null, rule_version integer not null,
  snapshot jsonb not null default '{}'::jsonb, public_visible boolean not null default false,
  created_at timestamptz not null default now(), unique(user_id,achievement_key,level)
);
create index if not exists vault_achievement_unlocks_profile_idx on public.vault_achievement_unlocks(user_id, unlocked_at desc);
create table if not exists public.vault_achievement_inbox (
  id uuid primary key default gen_random_uuid(), user_id text not null, unlock_id uuid not null references public.vault_achievement_unlocks(id) on delete cascade,
  created_at timestamptz not null default now(), delivered_at timestamptz, source text not null, unique(user_id,unlock_id)
);
create index if not exists vault_achievement_inbox_pending_idx on public.vault_achievement_inbox(user_id, delivered_at, created_at);
create table if not exists public.vault_achievement_showcase (
  user_id text not null, achievement_key text not null references public.vault_achievement_definitions(key),
  position smallint not null check (position between 1 and 6), updated_at timestamptz not null default now(),
  primary key(user_id,achievement_key), unique(user_id,position)
);
create table if not exists public.vault_personal_records (
  user_id text not null, record_key text not null, value jsonb not null, observed_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(user_id,record_key)
);
create table if not exists public.vault_achievement_state (
  user_id text primary key, baseline_activated_at timestamptz, baseline_version integer, last_evaluated_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- The single collection mutation path used by achievement events. A duplicate event
-- returns the existing event id and cannot produce a second unlock later.
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
    values(generated,p_username,coalesce(nullif(e->>'occurred_at','')::timestamptz,now()),e->>'type',coalesce((e->>'payload_version')::int,1),coalesce(e->'payload','{}'::jsonb),coalesce(e->>'source','vault'),e->>'idempotency_key')
    on conflict(user_id,idempotency_key) do nothing;
    select ve.event_id into existing from public.vault_achievement_events ve where ve.user_id=p_username and ve.idempotency_key=e->>'idempotency_key';
    event_id:=existing; inserted := existing=generated; return next;
  end loop;
end $$;
revoke all on function public.achievement_save_collection_events(text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.achievement_save_collection_events(text,jsonb,jsonb) to service_role;

alter table public.vault_achievement_definitions enable row level security;
alter table public.vault_achievement_events enable row level security;
alter table public.vault_achievement_progress enable row level security;
alter table public.vault_achievement_unlocks enable row level security;
alter table public.vault_achievement_inbox enable row level security;
alter table public.vault_achievement_showcase enable row level security;
alter table public.vault_personal_records enable row level security;
alter table public.vault_achievement_state enable row level security;
revoke all on public.vault_achievement_definitions, public.vault_achievement_events, public.vault_achievement_progress, public.vault_achievement_unlocks, public.vault_achievement_inbox, public.vault_achievement_showcase, public.vault_personal_records, public.vault_achievement_state from anon, authenticated;
grant select,insert,update,delete on public.vault_achievement_definitions, public.vault_achievement_events, public.vault_achievement_progress, public.vault_achievement_unlocks, public.vault_achievement_inbox, public.vault_achievement_showcase, public.vault_personal_records, public.vault_achievement_state to service_role;
