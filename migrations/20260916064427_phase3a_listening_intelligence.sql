-- Phase 3A: canonical recording/release-track identity, bounded enrichment,
-- reusable session projections and exact Album Run evidence. Raw scrobbles,
-- coverage, epochs and Phase 2 watermarks are not rewritten by this migration.

create table public.music_tracks (
  id uuid primary key default gen_random_uuid(),
  display_title text not null,
  normalized_title text not null,
  artist_id uuid references public.music_artists(id),
  artist_credit jsonb not null default '[]'::jsonb,
  musicbrainz_recording_mbid uuid not null unique,
  duration_ms integer check (duration_ms is null or duration_ms > 0),
  duration_source text,
  duration_confidence numeric(4,3) check (duration_confidence is null or duration_confidence between 0 and 1),
  source text not null,
  match_confidence numeric(4,3) not null check (match_confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index music_tracks_artist_idx on public.music_tracks(artist_id) where artist_id is not null;
create index music_tracks_normalized_title_idx on public.music_tracks(normalized_title);

create table public.music_releases (
  id uuid primary key default gen_random_uuid(),
  release_group_id uuid not null references public.music_release_groups(id),
  musicbrainz_release_mbid uuid not null unique,
  display_title text not null,
  normalized_title text not null,
  release_date date,
  country text,
  status text,
  packaging text,
  media_formats jsonb not null default '[]'::jsonb,
  tracklist_status text not null check (tracklist_status in ('complete','partial','ambiguous','unavailable')),
  duration_complete boolean not null default false,
  total_duration_ms bigint check (total_duration_ms is null or total_duration_ms > 0),
  source text not null,
  match_confidence numeric(4,3) not null check (match_confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index music_releases_group_date_idx on public.music_releases(release_group_id,release_date,id);

create table public.music_release_tracks (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.music_releases(id) on delete cascade,
  track_id uuid not null references public.music_tracks(id),
  musicbrainz_track_mbid uuid not null unique,
  display_title text not null,
  normalized_title text not null,
  medium_position smallint not null check (medium_position > 0),
  track_position smallint not null check (track_position > 0),
  absolute_position smallint not null check (absolute_position > 0),
  duration_ms integer check (duration_ms is null or duration_ms > 0),
  duration_source text,
  duration_confidence numeric(4,3) check (duration_confidence is null or duration_confidence between 0 and 1),
  source text not null,
  match_confidence numeric(4,3) not null check (match_confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(release_id,medium_position,track_position),
  unique(release_id,absolute_position)
);
create index music_release_tracks_recording_idx on public.music_release_tracks(track_id);
create index music_release_tracks_release_title_idx on public.music_release_tracks(release_id,normalized_title);

create table public.music_release_group_representatives (
  release_group_id uuid primary key references public.music_release_groups(id) on delete cascade,
  release_id uuid not null references public.music_releases(id),
  selection_version integer not null,
  selection_source text not null,
  selection_evidence jsonb not null,
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index music_release_group_representatives_release_idx on public.music_release_group_representatives(release_id);

alter table public.listening_scrobbles
  add column track_id uuid references public.music_tracks(id),
  add column release_track_id uuid references public.music_release_tracks(id),
  add column source_track_mbid uuid,
  add column enrichment_status text not null default 'pending' check (enrichment_status in ('pending','resolved','unresolved','ambiguous','retry')),
  add column enrichment_reason text,
  add column enrichment_metadata jsonb not null default '{}'::jsonb,
  add column enriched_at timestamptz;
create index listening_scrobbles_track_time_idx on public.listening_scrobbles(user_id,track_id,played_at desc) where track_id is not null;
create index listening_scrobbles_release_track_idx on public.listening_scrobbles(release_track_id) where release_track_id is not null;
create index listening_scrobbles_enrichment_pending_idx on public.listening_scrobbles(enrichment_status,played_at) where enrichment_status in ('pending','retry');

create table public.listening_enrichment_jobs (
  scrobble_id uuid primary key references public.listening_scrobbles(id) on delete cascade,
  user_id text not null,
  status text not null default 'queued' check (status in ('queued','running','resolved','unresolved','ambiguous','retry','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  resolution_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listening_enrichment_jobs_queue_idx on public.listening_enrichment_jobs(status,next_attempt_at,created_at) where status in ('queued','retry');
create index listening_enrichment_jobs_user_idx on public.listening_enrichment_jobs(user_id,status);

create table public.listening_lifetime_track_counts (
  user_id text not null,
  track_id uuid not null references public.music_tracks(id),
  scrobble_count bigint not null default 0,
  first_played_at timestamptz not null,
  last_played_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(user_id,track_id)
);
create index listening_lifetime_track_track_idx on public.listening_lifetime_track_counts(track_id);
create table public.listening_daily_track_counts (
  user_id text not null,
  local_date date not null,
  track_id uuid not null references public.music_tracks(id),
  scrobble_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(user_id,local_date,track_id)
);
create index listening_daily_track_lookup_idx on public.listening_daily_track_counts(user_id,track_id,local_date);
create index listening_daily_track_track_idx on public.listening_daily_track_counts(track_id);

create table public.listening_track_bursts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  track_id uuid not null references public.music_tracks(id),
  window_start timestamptz not null,
  window_end timestamptz not null,
  scrobble_ids jsonb not null,
  timestamps jsonb not null,
  timezone text not null,
  projection_version integer not null,
  detected_at timestamptz not null default now(),
  unique(user_id,track_id,window_start),
  check (window_end >= window_start)
);
create index listening_track_bursts_user_time_idx on public.listening_track_bursts(user_id,window_start desc);
create index listening_track_bursts_track_idx on public.listening_track_bursts(track_id);

create table public.listening_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  started_at_is_derived boolean not null,
  item_count integer not null check (item_count > 0),
  identity_status text not null check (identity_status in ('resolved','partial')),
  duration_status text not null check (duration_status in ('complete','partial')),
  coverage_status text not null check (coverage_status in ('covered','gap')),
  projection_version integer not null,
  session_fingerprint char(64) not null,
  metadata jsonb not null default '{}'::jsonb,
  projected_at timestamptz not null default now(),
  unique(user_id,session_fingerprint),
  check (ended_at >= started_at)
);
create index listening_sessions_user_time_idx on public.listening_sessions(user_id,started_at desc);
create table public.listening_session_items (
  session_id uuid not null references public.listening_sessions(id) on delete cascade,
  scrobble_id uuid not null references public.listening_scrobbles(id) on delete cascade,
  item_position integer not null check (item_position > 0),
  projected_start_at timestamptz,
  primary key(session_id,scrobble_id),
  unique(session_id,item_position)
);
create index listening_session_items_scrobble_idx on public.listening_session_items(scrobble_id);

create table public.listening_album_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  epoch_id uuid not null references public.lastfm_tracking_epochs(id) on delete cascade,
  release_group_id uuid not null references public.music_release_groups(id),
  release_id uuid not null references public.music_releases(id),
  local_date date not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  inferred_start boolean not null,
  elapsed_ms bigint not null check (elapsed_ms > 0),
  album_duration_ms bigint not null check (album_duration_ms > 0),
  track_count integer not null check (track_count >= 5),
  foreign_scrobble_count smallint not null check (foreign_scrobble_count between 0 and 1),
  qualifies_dash boolean not null default false,
  run_fingerprint char(64) not null,
  evidence jsonb not null,
  projection_version integer not null,
  detected_at timestamptz not null default now(),
  unique(user_id,run_fingerprint),
  check (ended_at >= started_at)
);
create index listening_album_runs_user_time_idx on public.listening_album_runs(user_id,started_at desc);
create index listening_album_runs_album_day_idx on public.listening_album_runs(user_id,release_group_id,local_date);
create index listening_album_runs_release_group_fk_idx on public.listening_album_runs(release_group_id);
create index listening_album_runs_release_fk_idx on public.listening_album_runs(release_id);

create or replace function public.enqueue_listening_enrichment()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.listening_enrichment_jobs(scrobble_id,user_id)
  values(new.id,new.user_id) on conflict(scrobble_id) do nothing;
  return new;
end $$;
create trigger listening_scrobbles_enqueue_enrichment
after insert on public.listening_scrobbles for each row execute function public.enqueue_listening_enrichment();
insert into public.listening_enrichment_jobs(scrobble_id,user_id)
select id,user_id from public.listening_scrobbles on conflict(scrobble_id) do nothing;

create or replace function public.listening_capture_source_track_mbids(p_epoch_id uuid,p_items jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  with source as (
    select x->>'source_fingerprint' fingerprint,nullif(x->>'source_track_mbid','')::uuid track_mbid
    from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
  )
  update public.listening_scrobbles s set source_track_mbid=source.track_mbid
  from source where s.epoch_id=p_epoch_id and s.source_fingerprint=source.fingerprint and source.track_mbid is not null and s.source_track_mbid is distinct from source.track_mbid;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.claim_listening_enrichment_jobs(p_limit integer default 3)
returns table(scrobble_id uuid,user_id text,attempts integer)
language plpgsql security definer set search_path='' as $$
begin
  return query
  with picked as (
    select j.scrobble_id from public.listening_enrichment_jobs j
    where j.status in ('queued','retry') and j.next_attempt_at<=clock_timestamp()
      and (j.locked_until is null or j.locked_until<clock_timestamp())
    order by j.next_attempt_at,j.created_at
    for update skip locked limit greatest(1,least(coalesce(p_limit,3),10))
  ), claimed as (
    update public.listening_enrichment_jobs j set status='running',attempts=j.attempts+1,
      locked_until=clock_timestamp()+interval '4 minutes',updated_at=clock_timestamp()
    from picked where j.scrobble_id=picked.scrobble_id
    returning j.scrobble_id,j.user_id,j.attempts
  ) select * from claimed;
end $$;

create or replace function public.listening_reconcile_scrobble_identity(
  p_scrobble_id uuid,p_artist_id uuid,p_release_group_id uuid,p_track_id uuid,p_release_track_id uuid,
  p_status text,p_reason text,p_match_source text,p_match_confidence numeric,p_metadata jsonb default '{}'::jsonb)
returns public.listening_scrobbles language plpgsql security definer set search_path='' as $$
declare v_old public.listening_scrobbles; v_new public.listening_scrobbles;
begin
  if p_status not in ('resolved','unresolved','ambiguous','retry') then raise exception 'invalid enrichment status'; end if;
  select * into v_old from public.listening_scrobbles where id=p_scrobble_id for update;
  if not found then raise exception 'unknown scrobble'; end if;
  update public.listening_scrobbles set artist_id=p_artist_id,release_group_id=p_release_group_id,track_id=p_track_id,release_track_id=p_release_track_id,
    enrichment_status=p_status,enrichment_reason=p_reason,enrichment_metadata=coalesce(p_metadata,'{}'::jsonb),enriched_at=clock_timestamp(),
    match_source=coalesce(nullif(p_match_source,''),match_source),match_confidence=p_match_confidence
  where id=p_scrobble_id returning * into v_new;

  delete from public.listening_lifetime_artist_counts where user_id=v_old.user_id and artist_id in (v_old.artist_id,v_new.artist_id);
  insert into public.listening_lifetime_artist_counts(user_id,artist_id,scrobble_count,first_played_at,last_played_at)
  select user_id,artist_id,count(*),min(played_at),max(played_at) from public.listening_scrobbles where user_id=v_old.user_id and artist_id in (v_old.artist_id,v_new.artist_id) group by user_id,artist_id;
  delete from public.listening_daily_artist_counts where user_id=v_old.user_id and artist_id in (v_old.artist_id,v_new.artist_id);
  insert into public.listening_daily_artist_counts(user_id,local_date,artist_id,scrobble_count)
  select user_id,local_date,artist_id,count(*) from public.listening_scrobbles where user_id=v_old.user_id and artist_id in (v_old.artist_id,v_new.artist_id) group by user_id,local_date,artist_id;

  delete from public.listening_lifetime_release_group_counts where user_id=v_old.user_id and release_group_id in (v_old.release_group_id,v_new.release_group_id);
  insert into public.listening_lifetime_release_group_counts(user_id,release_group_id,scrobble_count,first_played_at,last_played_at)
  select user_id,release_group_id,count(*),min(played_at),max(played_at) from public.listening_scrobbles where user_id=v_old.user_id and release_group_id in (v_old.release_group_id,v_new.release_group_id) group by user_id,release_group_id;
  delete from public.listening_daily_release_group_counts where user_id=v_old.user_id and release_group_id in (v_old.release_group_id,v_new.release_group_id);
  insert into public.listening_daily_release_group_counts(user_id,local_date,release_group_id,scrobble_count)
  select user_id,local_date,release_group_id,count(*) from public.listening_scrobbles where user_id=v_old.user_id and release_group_id in (v_old.release_group_id,v_new.release_group_id) group by user_id,local_date,release_group_id;

  delete from public.listening_lifetime_track_counts where user_id=v_old.user_id and track_id in (v_old.track_id,v_new.track_id);
  insert into public.listening_lifetime_track_counts(user_id,track_id,scrobble_count,first_played_at,last_played_at)
  select user_id,track_id,count(*),min(played_at),max(played_at) from public.listening_scrobbles where user_id=v_old.user_id and track_id in (v_old.track_id,v_new.track_id) group by user_id,track_id;
  delete from public.listening_daily_track_counts where user_id=v_old.user_id and track_id in (v_old.track_id,v_new.track_id);
  insert into public.listening_daily_track_counts(user_id,local_date,track_id,scrobble_count)
  select user_id,local_date,track_id,count(*) from public.listening_scrobbles where user_id=v_old.user_id and track_id in (v_old.track_id,v_new.track_id) group by user_id,local_date,track_id;
  return v_new;
end $$;

alter table public.music_tracks enable row level security;
alter table public.music_releases enable row level security;
alter table public.music_release_tracks enable row level security;
alter table public.music_release_group_representatives enable row level security;
alter table public.listening_enrichment_jobs enable row level security;
alter table public.listening_lifetime_track_counts enable row level security;
alter table public.listening_daily_track_counts enable row level security;
alter table public.listening_track_bursts enable row level security;
alter table public.listening_sessions enable row level security;
alter table public.listening_session_items enable row level security;
alter table public.listening_album_runs enable row level security;

revoke all on public.music_tracks,public.music_releases,public.music_release_tracks,public.music_release_group_representatives,
  public.listening_enrichment_jobs,public.listening_lifetime_track_counts,public.listening_daily_track_counts,public.listening_track_bursts,
  public.listening_sessions,public.listening_session_items,public.listening_album_runs from anon,authenticated;
grant select,insert,update,delete on public.music_tracks,public.music_releases,public.music_release_tracks,public.music_release_group_representatives,
  public.listening_enrichment_jobs,public.listening_lifetime_track_counts,public.listening_daily_track_counts,public.listening_track_bursts,
  public.listening_sessions,public.listening_session_items,public.listening_album_runs to service_role;

revoke all on function public.enqueue_listening_enrichment() from public,anon,authenticated;
revoke all on function public.listening_capture_source_track_mbids(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.claim_listening_enrichment_jobs(integer) from public,anon,authenticated;
revoke all on function public.listening_reconcile_scrobble_identity(uuid,uuid,uuid,uuid,uuid,text,text,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.listening_capture_source_track_mbids(uuid,jsonb) to service_role;
grant execute on function public.claim_listening_enrichment_jobs(integer) to service_role;
grant execute on function public.listening_reconcile_scrobble_identity(uuid,uuid,uuid,uuid,uuid,text,text,text,numeric,jsonb) to service_role;
