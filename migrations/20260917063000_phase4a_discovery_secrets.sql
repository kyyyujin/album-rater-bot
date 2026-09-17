-- Phase 4A: server-only Discovery evidence. This migration never mutates raw
-- timestamps, fingerprints, tracking cutoffs, watermarks or coverage.

alter table public.vault_achievement_definitions
  add column if not exists is_discovery boolean not null default false,
  add column if not exists emblem_eligible boolean not null default true;

alter table public.vault_achievement_definitions
  drop constraint if exists vault_achievement_definitions_discovery_no_emblem;
alter table public.vault_achievement_definitions
  add constraint vault_achievement_definitions_discovery_no_emblem
  check (not is_discovery or emblem_eligible=false);

alter table public.listening_period_snapshots
  add column if not exists coverage_continuous boolean not null default false;

create table if not exists public.listening_discovery_artist_windows (
  user_id text not null,
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete restrict,
  artist_id uuid not null references public.music_artists(id) on delete restrict,
  first_played_at timestamptz not null,
  window_end timestamptz not null,
  evidence_version integer not null default 1,
  evaluated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(user_id,epoch_id,artist_id),
  check(window_end=first_played_at+interval '30 days')
);

create index if not exists listening_discovery_windows_due_idx
  on public.listening_discovery_artist_windows(user_id,epoch_id,window_end)
  where evaluated_at is null;
create index if not exists listening_scrobbles_user_epoch_time_idx
  on public.listening_scrobbles(user_id,epoch_id,played_at);
create index if not exists listening_scrobbles_user_epoch_artist_time_idx
  on public.listening_scrobbles(user_id,epoch_id,artist_id,played_at)
  where artist_id is not null;

create or replace function public.refresh_discovery_artist_windows()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_first timestamptz;
begin
  -- A late canonical identity can change every artist rank whose fixed window
  -- contains this play. Those already-closed projections become dirty again.
  if tg_op='UPDATE' and old.artist_id is distinct from new.artist_id then
    update public.listening_discovery_artist_windows w
       set evaluated_at=null,updated_at=clock_timestamp()
     where w.user_id=new.user_id and w.epoch_id=new.epoch_id
       and new.played_at>=w.first_played_at and new.played_at<w.window_end;
    if old.artist_id is not null then
      select min(s.played_at) into v_first from public.listening_scrobbles s
       where s.user_id=old.user_id and s.epoch_id=old.epoch_id and s.artist_id=old.artist_id;
      if v_first is null then
        delete from public.listening_discovery_artist_windows
         where user_id=old.user_id and epoch_id=old.epoch_id and artist_id=old.artist_id;
      else
        update public.listening_discovery_artist_windows set first_played_at=v_first,
          window_end=v_first+interval '30 days',evaluated_at=null,updated_at=clock_timestamp()
         where user_id=old.user_id and epoch_id=old.epoch_id and artist_id=old.artist_id;
      end if;
    end if;
  end if;
  if new.artist_id is null then return new; end if;
  insert into public.listening_discovery_artist_windows(
    user_id,epoch_id,artist_id,first_played_at,window_end,evaluated_at,updated_at
  ) values(new.user_id,new.epoch_id,new.artist_id,new.played_at,new.played_at+interval '30 days',null,clock_timestamp())
  on conflict(user_id,epoch_id,artist_id) do update set
    first_played_at=least(excluded.first_played_at,listening_discovery_artist_windows.first_played_at),
    window_end=least(excluded.first_played_at,listening_discovery_artist_windows.first_played_at)+interval '30 days',
    evaluated_at=case when excluded.first_played_at<listening_discovery_artist_windows.first_played_at then null else listening_discovery_artist_windows.evaluated_at end,
    updated_at=clock_timestamp();
  return new;
end $$;

drop trigger if exists listening_scrobbles_discovery_windows on public.listening_scrobbles;
create trigger listening_scrobbles_discovery_windows
after insert or update of artist_id on public.listening_scrobbles
for each row execute function public.refresh_discovery_artist_windows();

-- Backfill is a projection of legitimate post-cutoff ledger rows, not a
-- historical Last.fm import and not an achievement evaluation.
insert into public.listening_discovery_artist_windows(
  user_id,epoch_id,artist_id,first_played_at,window_end,evidence_version
)
select s.user_id,s.epoch_id,s.artist_id,min(s.played_at),min(s.played_at)+interval '30 days',1
from public.listening_scrobbles s
where s.artist_id is not null
group by s.user_id,s.epoch_id,s.artist_id
on conflict(user_id,epoch_id,artist_id) do nothing;

create or replace function public.discovery_love_dive_evidence(
  p_user_id text,p_epoch_id uuid,p_limit integer default 50
)
returns table(
  artist_id uuid,first_played_at timestamptz,window_end timestamptz,
  artist_scrobbles bigint,total_scrobbles bigint,resolved_artist_scrobbles bigint,
  artist_rank bigint,pending_identity bigint,evidence_version integer
)
language sql stable security definer set search_path=public as $$
  with due as (
    select w.* from public.listening_discovery_artist_windows w
    where w.user_id=p_user_id and w.epoch_id=p_epoch_id
      and w.evaluated_at is null and w.window_end<=clock_timestamp()
    order by w.window_end asc limit greatest(1,least(coalesce(p_limit,50),100))
  ), counts as (
    select d.artist_id,d.first_played_at,d.window_end,d.evidence_version,
      count(s.id)::bigint total_scrobbles,
      count(s.artist_id)::bigint resolved_artist_scrobbles,
      count(s.id) filter(where s.enrichment_status in ('pending','retry','running'))::bigint pending_identity
    from due d left join public.listening_scrobbles s
      on s.user_id=d.user_id and s.epoch_id=d.epoch_id
     and s.played_at>=d.first_played_at and s.played_at<d.window_end
    group by d.artist_id,d.first_played_at,d.window_end,d.evidence_version
  ), artist_counts as (
    select d.artist_id candidate_artist,s.artist_id,count(*)::bigint plays
    from due d join public.listening_scrobbles s
      on s.user_id=d.user_id and s.epoch_id=d.epoch_id
     and s.played_at>=d.first_played_at and s.played_at<d.window_end
    where s.artist_id is not null group by d.artist_id,s.artist_id
  ), ranked as (
    select candidate_artist,artist_id,plays,dense_rank() over(partition by candidate_artist order by plays desc) artist_rank
    from artist_counts
  )
  select c.artist_id,c.first_played_at,c.window_end,
    coalesce(r.plays,0),c.total_scrobbles,c.resolved_artist_scrobbles,
    coalesce(r.artist_rank,9223372036854775807),c.pending_identity,c.evidence_version
  from counts c left join ranked r
    on r.candidate_artist=c.artist_id and r.artist_id=c.artist_id;
$$;

create or replace function public.discovery_period_artist_segments(
  p_user_id text,p_epoch_id uuid,p_windows jsonb
)
returns table(metric_key text,segment text,artist_id uuid,scrobble_count bigint)
language sql stable security definer set search_path=public as $$
  select w->>'key',case when s.local_hour between 0 and 4 then 'night' else 'day' end,
         s.artist_id,count(*)::bigint
  from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) w
  join public.listening_scrobbles s
    on s.user_id=p_user_id and s.epoch_id=p_epoch_id
   and s.played_at>=(w->>'start')::timestamptz and s.played_at<(w->>'end')::timestamptz
  where exists(select 1 from public.lastfm_tracking_epochs e where e.id=p_epoch_id and e.user_id=p_user_id)
  group by w->>'key',case when s.local_hour between 0 and 4 then 'night' else 'day' end,s.artist_id;
$$;

-- The immutable Memory Card and its delivery record commit atomically. Unique
-- (user,family,level) remains the idempotency authority under concurrency.
create or replace function public.achievement_unlock_with_inbox(
  p_user_id text,p_achievement_key text,p_level integer,p_source text,
  p_rule_version integer,p_snapshot jsonb,p_unlocked_at timestamptz default clock_timestamp()
)
returns setof public.vault_achievement_unlocks
language plpgsql security definer set search_path=public as $$
declare v_unlock public.vault_achievement_unlocks%rowtype;
begin
  if not exists(
    select 1 from public.vault_achievement_definitions d
    where d.key=p_achievement_key and d.enabled=true
  ) then return; end if;
  insert into public.vault_achievement_unlocks(
    user_id,achievement_key,level,unlocked_at,source,rule_version,snapshot
  ) values(p_user_id,p_achievement_key,p_level,p_unlocked_at,p_source,p_rule_version,coalesce(p_snapshot,'{}'::jsonb))
  on conflict(user_id,achievement_key,level) do nothing returning * into v_unlock;
  if v_unlock.id is null then return; end if;
  insert into public.vault_achievement_inbox(user_id,unlock_id,source)
  values(p_user_id,v_unlock.id,p_source) on conflict(user_id,unlock_id) do nothing;
  return next v_unlock;
end $$;

alter table public.listening_discovery_artist_windows enable row level security;
revoke all on public.listening_discovery_artist_windows from public,anon,authenticated;
grant select,insert,update,delete on public.listening_discovery_artist_windows to service_role;
revoke all on function public.refresh_discovery_artist_windows() from public,anon,authenticated;
grant execute on function public.refresh_discovery_artist_windows() to service_role;
revoke all on function public.discovery_love_dive_evidence(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.discovery_love_dive_evidence(text,uuid,integer) to service_role;
revoke all on function public.discovery_period_artist_segments(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.discovery_period_artist_segments(text,uuid,jsonb) to service_role;
revoke all on function public.achievement_unlock_with_inbox(text,text,integer,text,integer,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.achievement_unlock_with_inbox(text,text,integer,text,integer,jsonb,timestamptz) to service_role;
