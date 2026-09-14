-- Phase 2: server-owned Last.fm tracking.  All tables are deliberately private:
-- Album Vault authenticates users in its Express backend, not through auth.uid().
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.lastfm_tracking_epochs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  lastfm_username text not null,
  normalized_username text not null,
  epoch_number integer not null check (epoch_number > 0),
  status text not null check (status in ('active','paused','closed','invalid')),
  timezone text not null default 'UTC',
  lastfm_tracking_started_at timestamptz not null,
  watermark_played_at timestamptz not null,
  backlog_cursor_before timestamptz,
  coverage_cursor_at timestamptz not null,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  consecutive_failures integer not null default 0,
  sync_locked_until timestamptz,
  sync_lock_token uuid,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,epoch_number)
);
create unique index if not exists lastfm_tracking_one_active_user_idx
  on public.lastfm_tracking_epochs(user_id) where status='active';
create index if not exists lastfm_tracking_active_sync_idx
  on public.lastfm_tracking_epochs(status, sync_locked_until, last_sync_at);

create table if not exists public.listening_coverage_windows (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete cascade,
  coverage_start timestamptz not null,
  coverage_end timestamptz not null,
  status text not null check (status in ('covered','coverage_gap','disconnected')),
  reason text,
  created_at timestamptz not null default now(),
  check (coverage_end >= coverage_start)
);
create index if not exists listening_coverage_lookup_idx
  on public.listening_coverage_windows(user_id, status, coverage_start, coverage_end);

create table if not exists public.listening_scrobbles (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete restrict,
  artist_id uuid references public.music_artists(id),
  release_group_id uuid references public.music_release_groups(id),
  -- Track identity remains intentionally nullable in Phase 2.  Title-only
  -- strings must not unlock track achievements.
  source_artist text not null,
  source_album text,
  source_track text not null,
  source_artist_mbid uuid,
  source_album_mbid uuid,
  played_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  local_date date not null,
  local_hour smallint not null check (local_hour between 0 and 23),
  source_fingerprint char(64) not null,
  match_confidence numeric(4,3),
  match_source text not null default 'unresolved',
  created_at timestamptz not null default now(),
  unique(epoch_id, source_fingerprint)
);
create index if not exists listening_scrobbles_user_time_idx on public.listening_scrobbles(user_id, played_at desc);
create index if not exists listening_scrobbles_release_time_idx on public.listening_scrobbles(user_id, release_group_id, played_at desc) where release_group_id is not null;
create index if not exists listening_scrobbles_artist_time_idx on public.listening_scrobbles(user_id, artist_id, played_at desc) where artist_id is not null;

create table if not exists public.listening_lifetime_artist_counts (
  user_id text not null,
  artist_id uuid not null references public.music_artists(id),
  scrobble_count bigint not null default 0,
  first_played_at timestamptz not null,
  last_played_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(user_id,artist_id)
);
create table if not exists public.listening_lifetime_release_group_counts (
  user_id text not null,
  release_group_id uuid not null references public.music_release_groups(id),
  scrobble_count bigint not null default 0,
  first_played_at timestamptz not null,
  last_played_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(user_id,release_group_id)
);
create table if not exists public.listening_daily_totals (
  user_id text not null,
  local_date date not null,
  scrobble_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(user_id,local_date)
);
create table if not exists public.listening_daily_artist_counts (
  user_id text not null,
  local_date date not null,
  artist_id uuid not null references public.music_artists(id),
  scrobble_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(user_id,local_date,artist_id)
);
create table if not exists public.listening_daily_release_group_counts (
  user_id text not null,
  local_date date not null,
  release_group_id uuid not null references public.music_release_groups(id),
  scrobble_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(user_id,local_date,release_group_id)
);
create table if not exists public.listening_hour_totals (
  user_id text not null,
  local_date date not null,
  local_hour smallint not null check (local_hour between 0 and 23),
  scrobble_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(user_id,local_date,local_hour)
);
create index if not exists listening_daily_release_group_lookup_idx on public.listening_daily_release_group_counts(user_id,release_group_id,local_date);

create table if not exists public.listening_sync_runs (
  id uuid primary key default gen_random_uuid(),
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete cascade,
  user_id text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('running','success','backlog','failed','locked','skipped')),
  pages integer not null default 0,
  observed integer not null default 0,
  inserted integer not null default 0,
  duplicates integer not null default 0,
  discarded_pre_tracking integer not null default 0,
  unresolved integer not null default 0,
  ambiguous integer not null default 0,
  watermark_before timestamptz,
  watermark_after timestamptz,
  coverage_until timestamptz,
  lastfm_status integer,
  error_code text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists listening_sync_runs_epoch_started_idx on public.listening_sync_runs(epoch_id,started_at desc);

-- The token is only read by the database cron function and the service-role
-- backend.  It never reaches a browser or the public cron command text.
create table if not exists public.listening_scheduler_config (
  singleton boolean primary key default true check (singleton),
  scheduler_token text not null,
  updated_at timestamptz not null default now()
);
insert into public.listening_scheduler_config(singleton,scheduler_token)
values(true,encode(extensions.gen_random_bytes(32),'hex')) on conflict(singleton) do nothing;

create or replace function public.lastfm_activate_epoch(p_user_id text, p_username text, p_timezone text default 'UTC')
returns public.lastfm_tracking_epochs language plpgsql security definer set search_path=public as $$
declare v_existing public.lastfm_tracking_epochs; v_result public.lastfm_tracking_epochs; v_now timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('lastfm:'||p_user_id));
  select * into v_existing from public.lastfm_tracking_epochs where user_id=p_user_id and status='active' for update;
  if found and v_existing.normalized_username=lower(trim(p_username)) then return v_existing; end if;
  if found then
    update public.lastfm_tracking_epochs set status='closed',closed_at=v_now,updated_at=v_now where id=v_existing.id;
    insert into public.listening_coverage_windows(user_id,epoch_id,coverage_start,coverage_end,status,reason)
    values(p_user_id,v_existing.id,v_existing.coverage_cursor_at,v_now,'disconnected','username_changed');
  end if;
  insert into public.lastfm_tracking_epochs(user_id,lastfm_username,normalized_username,epoch_number,status,timezone,lastfm_tracking_started_at,watermark_played_at,coverage_cursor_at)
  values(p_user_id,trim(p_username),lower(trim(p_username)),coalesce((select max(epoch_number)+1 from public.lastfm_tracking_epochs where user_id=p_user_id),1),'active',coalesce(nullif(trim(p_timezone),''),'UTC'),v_now,v_now,v_now)
  returning * into v_result;
  return v_result;
end $$;
create or replace function public.lastfm_pause_active_epoch(p_user_id text, p_reason text default 'username_removed')
returns void language plpgsql security definer set search_path=public as $$
declare v_epoch public.lastfm_tracking_epochs; v_now timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext('lastfm:'||p_user_id));
  select * into v_epoch from public.lastfm_tracking_epochs where user_id=p_user_id and status='active' for update;
  if not found then return; end if;
  update public.lastfm_tracking_epochs set status='paused',closed_at=v_now,updated_at=v_now where id=v_epoch.id;
  insert into public.listening_coverage_windows(user_id,epoch_id,coverage_start,coverage_end,status,reason)
  values(p_user_id,v_epoch.id,v_epoch.coverage_cursor_at,v_now,'disconnected',p_reason);
end $$;
create or replace function public.lastfm_try_lock(p_epoch_id uuid, p_lock_token uuid, p_seconds integer default 90)
returns boolean language plpgsql security definer set search_path=public as $$
declare ok boolean;
begin
  update public.lastfm_tracking_epochs set sync_lock_token=p_lock_token,sync_locked_until=clock_timestamp()+make_interval(secs=>greatest(15,least(p_seconds,300))),updated_at=clock_timestamp()
  where id=p_epoch_id and status='active' and (sync_locked_until is null or sync_locked_until<clock_timestamp()) returning true into ok;
  return coalesce(ok,false);
end $$;
create or replace function public.lastfm_release_lock(p_epoch_id uuid, p_lock_token uuid)
returns void language sql security definer set search_path=public as $$
  update public.lastfm_tracking_epochs set sync_lock_token=null,sync_locked_until=null,updated_at=clock_timestamp() where id=p_epoch_id and sync_lock_token=p_lock_token
$$;

-- Persists raw rows, all aggregates, watermark and coverage in one transaction.
-- If any aggregate write fails, the watermark cannot advance.
create or replace function public.lastfm_apply_sync_batch(p_epoch_id uuid, p_user_id text, p_items jsonb, p_watermark timestamptz, p_coverage_until timestamptz, p_backlog_cursor_before timestamptz default null)
returns table(inserted integer, watermark_played_at timestamptz, coverage_cursor_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare v_epoch public.lastfm_tracking_epochs; v_inserted integer:=0; v_new_watermark timestamptz; v_new_coverage timestamptz;
begin
  select * into v_epoch from public.lastfm_tracking_epochs where id=p_epoch_id and user_id=p_user_id and status='active' for update;
  if not found then raise exception 'inactive or unknown Last.fm epoch'; end if;
  create temporary table if not exists pg_temp.lastfm_sync_inserted (
    user_id text, artist_id uuid, release_group_id uuid, played_at timestamptz, local_date date, local_hour smallint
  ) on commit drop;
  truncate pg_temp.lastfm_sync_inserted;
  with source as (
    select p_epoch_id as epoch_id,p_user_id as user_id,
      nullif(x->>'artist_id','')::uuid as artist_id,nullif(x->>'release_group_id','')::uuid as release_group_id,
      x->>'source_artist' as source_artist,nullif(x->>'source_album','') as source_album,x->>'source_track' as source_track,
      nullif(x->>'source_artist_mbid','')::uuid as source_artist_mbid,nullif(x->>'source_album_mbid','')::uuid as source_album_mbid,
      (x->>'played_at')::timestamptz as played_at,(x->>'local_date')::date as local_date,(x->>'local_hour')::smallint as local_hour,
      x->>'source_fingerprint' as source_fingerprint,nullif(x->>'match_confidence','')::numeric as match_confidence,coalesce(nullif(x->>'match_source',''),'unresolved') as match_source
    from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
  ), ins as (
    insert into public.listening_scrobbles(epoch_id,user_id,artist_id,release_group_id,source_artist,source_album,source_track,source_artist_mbid,source_album_mbid,played_at,local_date,local_hour,source_fingerprint,match_confidence,match_source)
    select epoch_id,user_id,artist_id,release_group_id,source_artist,source_album,source_track,source_artist_mbid,source_album_mbid,played_at,local_date,local_hour,source_fingerprint,match_confidence,match_source
    from source where played_at>=v_epoch.lastfm_tracking_started_at
    on conflict(epoch_id,source_fingerprint) do nothing
    returning user_id,artist_id,release_group_id,played_at,local_date,local_hour
  ) insert into pg_temp.lastfm_sync_inserted select * from ins;
  get diagnostics v_inserted=row_count;
  insert into public.listening_lifetime_artist_counts(user_id,artist_id,scrobble_count,first_played_at,last_played_at)
  select user_id,artist_id,count(*),min(played_at),max(played_at) from pg_temp.lastfm_sync_inserted where artist_id is not null group by user_id,artist_id
  on conflict(user_id,artist_id) do update set scrobble_count=public.listening_lifetime_artist_counts.scrobble_count+excluded.scrobble_count,first_played_at=least(public.listening_lifetime_artist_counts.first_played_at,excluded.first_played_at),last_played_at=greatest(public.listening_lifetime_artist_counts.last_played_at,excluded.last_played_at),updated_at=clock_timestamp();
  insert into public.listening_lifetime_release_group_counts(user_id,release_group_id,scrobble_count,first_played_at,last_played_at)
  select user_id,release_group_id,count(*),min(played_at),max(played_at) from pg_temp.lastfm_sync_inserted where release_group_id is not null group by user_id,release_group_id
  on conflict(user_id,release_group_id) do update set scrobble_count=public.listening_lifetime_release_group_counts.scrobble_count+excluded.scrobble_count,first_played_at=least(public.listening_lifetime_release_group_counts.first_played_at,excluded.first_played_at),last_played_at=greatest(public.listening_lifetime_release_group_counts.last_played_at,excluded.last_played_at),updated_at=clock_timestamp();
  insert into public.listening_daily_totals(user_id,local_date,scrobble_count)
  select user_id,local_date,count(*) from pg_temp.lastfm_sync_inserted group by user_id,local_date
  on conflict(user_id,local_date) do update set scrobble_count=public.listening_daily_totals.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  insert into public.listening_daily_artist_counts(user_id,local_date,artist_id,scrobble_count)
  select user_id,local_date,artist_id,count(*) from pg_temp.lastfm_sync_inserted where artist_id is not null group by user_id,local_date,artist_id
  on conflict(user_id,local_date,artist_id) do update set scrobble_count=public.listening_daily_artist_counts.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  insert into public.listening_daily_release_group_counts(user_id,local_date,release_group_id,scrobble_count)
  select user_id,local_date,release_group_id,count(*) from pg_temp.lastfm_sync_inserted where release_group_id is not null group by user_id,local_date,release_group_id
  on conflict(user_id,local_date,release_group_id) do update set scrobble_count=public.listening_daily_release_group_counts.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  insert into public.listening_hour_totals(user_id,local_date,local_hour,scrobble_count)
  select user_id,local_date,local_hour,count(*) from pg_temp.lastfm_sync_inserted group by user_id,local_date,local_hour
  on conflict(user_id,local_date,local_hour) do update set scrobble_count=public.listening_hour_totals.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  if p_coverage_until is not null and p_coverage_until>v_epoch.coverage_cursor_at then
    insert into public.listening_coverage_windows(user_id,epoch_id,coverage_start,coverage_end,status,reason)
    values(p_user_id,p_epoch_id,v_epoch.coverage_cursor_at,p_coverage_until,'covered','recenttracks_reconciled');
  end if;
  update public.lastfm_tracking_epochs as e set watermark_played_at=greatest(e.watermark_played_at,coalesce(p_watermark,e.watermark_played_at)),backlog_cursor_before=p_backlog_cursor_before,coverage_cursor_at=greatest(e.coverage_cursor_at,coalesce(p_coverage_until,e.coverage_cursor_at)),last_sync_at=clock_timestamp(),last_success_at=clock_timestamp(),last_error_at=null,last_error_code=null,consecutive_failures=0,updated_at=clock_timestamp()
  where e.id=p_epoch_id returning e.watermark_played_at,e.coverage_cursor_at into v_new_watermark,v_new_coverage;
  return query select v_inserted,v_new_watermark,v_new_coverage;
end $$;

create or replace function public.enqueue_lastfm_sync()
returns void language plpgsql security definer set search_path=public,net as $$
declare v_token text;
begin
  select scheduler_token into v_token from public.listening_scheduler_config where singleton;
  perform net.http_post(url:='https://album-rater-bot.onrender.com/internal/lastfm/sync',headers:=jsonb_build_object('Content-Type','application/json','x-album-vault-scheduler',v_token),body:='{}'::jsonb,timeout_milliseconds:=25000);
end $$;

do $$ begin
  if exists(select 1 from cron.job where jobname='album_vault_lastfm_sync') then
    perform cron.unschedule(jobid) from cron.job where jobname='album_vault_lastfm_sync';
  end if;
  perform cron.schedule('album_vault_lastfm_sync','*/5 * * * *',$cron$select public.enqueue_lastfm_sync();$cron$);
end $$;

revoke all on function public.lastfm_activate_epoch(text,text,text),public.lastfm_pause_active_epoch(text,text),public.lastfm_try_lock(uuid,uuid,integer),public.lastfm_release_lock(uuid,uuid),public.lastfm_apply_sync_batch(uuid,text,jsonb,timestamptz,timestamptz,timestamptz),public.enqueue_lastfm_sync() from public,anon,authenticated;
grant execute on function public.lastfm_activate_epoch(text,text,text),public.lastfm_pause_active_epoch(text,text),public.lastfm_try_lock(uuid,uuid,integer),public.lastfm_release_lock(uuid,uuid),public.lastfm_apply_sync_batch(uuid,text,jsonb,timestamptz,timestamptz,timestamptz) to service_role;

alter table public.lastfm_tracking_epochs enable row level security;
alter table public.listening_coverage_windows enable row level security;
alter table public.listening_scrobbles enable row level security;
alter table public.listening_lifetime_artist_counts enable row level security;
alter table public.listening_lifetime_release_group_counts enable row level security;
alter table public.listening_daily_totals enable row level security;
alter table public.listening_daily_artist_counts enable row level security;
alter table public.listening_daily_release_group_counts enable row level security;
alter table public.listening_hour_totals enable row level security;
alter table public.listening_sync_runs enable row level security;
alter table public.listening_scheduler_config enable row level security;
revoke all on public.lastfm_tracking_epochs,public.listening_coverage_windows,public.listening_scrobbles,public.listening_lifetime_artist_counts,public.listening_lifetime_release_group_counts,public.listening_daily_totals,public.listening_daily_artist_counts,public.listening_daily_release_group_counts,public.listening_hour_totals,public.listening_sync_runs,public.listening_scheduler_config from anon,authenticated;
grant select,insert,update,delete on public.lastfm_tracking_epochs,public.listening_coverage_windows,public.listening_scrobbles,public.listening_lifetime_artist_counts,public.listening_lifetime_release_group_counts,public.listening_daily_totals,public.listening_daily_artist_counts,public.listening_daily_release_group_counts,public.listening_hour_totals,public.listening_sync_runs,public.listening_scheduler_config to service_role;
