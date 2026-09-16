-- Phase 3B: immutable closed-period evidence for Hybrid achievements and
-- visible Secrets. Raw listening rows, tracking cutoffs, watermarks and
-- coverage are intentionally untouched.

create table if not exists public.listening_period_closer_state (
  user_id text not null,
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete restrict,
  timezone text not null,
  closing_started_at timestamptz not null default clock_timestamp(),
  last_closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(user_id,epoch_id)
);

create table if not exists public.listening_period_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete restrict,
  period_type text not null check(period_type in ('week','month','tracking_60d')),
  local_start date not null,
  local_end date not null,
  utc_start timestamptz not null,
  utc_end timestamptz not null,
  timezone text not null,
  coverage_ratio numeric(7,6) not null check(coverage_ratio between 0 and 1),
  completeness text not null check(completeness in ('complete','partial','incomplete')),
  scrobble_total bigint not null default 0 check(scrobble_total>=0),
  rankings jsonb not null default '{"release_groups":[],"artists":[]}'::jsonb,
  snapshot_version integer not null default 1,
  closed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  check(local_end>local_start and utc_end>utc_start),
  unique(user_id,epoch_id,period_type,local_start)
);

create index if not exists listening_period_snapshots_user_type_date_idx
  on public.listening_period_snapshots(user_id,period_type,local_start desc);
create index if not exists listening_daily_artist_lookup_idx
  on public.listening_daily_artist_counts(user_id,artist_id,local_date);

-- One bounded call calculates all event-relative Hybrid counters. Each window
-- remains indexable by user/release/track/time and avoids shipping or scanning
-- a 100k-row ledger in the Node process.
create or replace function public.hybrid_count_scrobble_windows(
  p_user_id text,p_epoch_id uuid,p_windows jsonb
)
returns table(metric_key text,scrobble_count bigint,first_played_at timestamptz,last_played_at timestamptz)
language sql stable security definer set search_path=public as $$
  select w->>'key',count(s.id),min(s.played_at),max(s.played_at)
  from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) w
  left join public.listening_scrobbles s
    on s.user_id=p_user_id and s.epoch_id=p_epoch_id
   and (nullif(w->>'release_group_id','') is null or s.release_group_id=nullif(w->>'release_group_id','')::uuid)
   and (nullif(w->>'track_id','') is null or s.track_id=nullif(w->>'track_id','')::uuid)
   and (nullif(w->>'after','') is null or s.played_at>nullif(w->>'after','')::timestamptz)
   and (nullif(w->>'before','') is null or s.played_at<=nullif(w->>'before','')::timestamptz)
  where exists(select 1 from public.lastfm_tracking_epochs e where e.id=p_epoch_id and e.user_id=p_user_id)
  group by w->>'key';
$$;

create or replace function public.hybrid_coverage_evidence(
  p_user_id text,p_epoch_id uuid,p_windows jsonb
)
returns table(metric_key text,covered_milliseconds bigint,coverage_ratio numeric,continuous boolean)
language sql stable security definer set search_path=public as $$
  with requested as (
    select w->>'key' metric_key,(w->>'start')::timestamptz window_start,(w->>'end')::timestamptz window_end
    from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) w
    where (w->>'end')::timestamptz>(w->>'start')::timestamptz
  ), calculated as (
    select r.metric_key,r.window_start,r.window_end,
      coalesce(sum(greatest(0,extract(epoch from least(c.coverage_end,r.window_end)-greatest(c.coverage_start,r.window_start))*1000)) filter(where c.status='covered'),0)::bigint covered_ms,
      count(c.id) filter(where c.status<>'covered') blockers
    from requested r left join public.listening_coverage_windows c
      on c.user_id=p_user_id and c.epoch_id=p_epoch_id
     and c.coverage_end>r.window_start and c.coverage_start<r.window_end
    group by r.metric_key,r.window_start,r.window_end
  )
  select metric_key,covered_ms,
    least(1::numeric,covered_ms::numeric/greatest(1,extract(epoch from window_end-window_start)*1000)) coverage_ratio,
    blockers=0 and covered_ms>=extract(epoch from window_end-window_start)*1000-1000 continuous
  from calculated
  where exists(select 1 from public.lastfm_tracking_epochs e where e.id=p_epoch_id and e.user_id=p_user_id);
$$;

alter table public.listening_period_closer_state enable row level security;
alter table public.listening_period_snapshots enable row level security;
revoke all on public.listening_period_closer_state,public.listening_period_snapshots from anon,authenticated;
grant select,insert,update,delete on public.listening_period_closer_state,public.listening_period_snapshots to service_role;

create or replace function public.prevent_listening_period_snapshot_mutation()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  raise exception 'Closed listening-period evidence is immutable';
end $$;
drop trigger if exists listening_period_snapshots_immutable on public.listening_period_snapshots;
create trigger listening_period_snapshots_immutable
before update or delete on public.listening_period_snapshots
for each row execute function public.prevent_listening_period_snapshot_mutation();

create or replace function public.enqueue_achievement_period_close()
returns void language plpgsql security definer set search_path=public,net as $$
declare v_token text;
begin
  select scheduler_token into v_token from public.listening_scheduler_config where singleton;
  perform net.http_post(
    url:='https://album-rater-bot.onrender.com/internal/achievements/period-close',
    headers:=jsonb_build_object('Content-Type','application/json','x-album-vault-scheduler',v_token),
    body:='{}'::jsonb,
    timeout_milliseconds:=25000
  );
end $$;

do $$ begin
  if exists(select 1 from cron.job where jobname='album_vault_achievement_period_close') then
    perform cron.unschedule(jobid) from cron.job where jobname='album_vault_achievement_period_close';
  end if;
  perform cron.schedule(
    'album_vault_achievement_period_close',
    '17 * * * *',
    $cron$select public.enqueue_achievement_period_close();$cron$
  );
end $$;

revoke all on function public.enqueue_achievement_period_close() from public,anon,authenticated;
grant execute on function public.enqueue_achievement_period_close() to service_role;
revoke all on function public.hybrid_count_scrobble_windows(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.hybrid_count_scrobble_windows(text,uuid,jsonb) to service_role;
revoke all on function public.hybrid_coverage_evidence(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.hybrid_coverage_evidence(text,uuid,jsonb) to service_role;
revoke all on function public.prevent_listening_period_snapshot_mutation() from public,anon,authenticated;
grant execute on function public.prevent_listening_period_snapshot_mutation() to service_role;
