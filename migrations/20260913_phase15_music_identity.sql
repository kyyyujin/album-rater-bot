-- Phase 1.5: conservative, private canonical identity for Vault achievements.
-- User-visible Vault JSON remains the source for display; these tables are an
-- internal identity layer and never grant a historical achievement baseline.

create table if not exists public.music_artists (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  normalized_name text not null,
  musicbrainz_artist_mbid uuid not null unique,
  aliases jsonb not null default '[]'::jsonb,
  source text not null,
  match_confidence numeric(4,3) not null check (match_confidence >= 0 and match_confidence <= 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists music_artists_normalized_name_idx on public.music_artists(normalized_name);

create table if not exists public.music_release_groups (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.music_artists(id),
  display_title text not null,
  normalized_title text not null,
  musicbrainz_release_group_mbid uuid not null unique,
  primary_type text,
  secondary_types jsonb not null default '[]'::jsonb,
  first_release_date date,
  is_main_project boolean not null default false,
  source text not null,
  match_confidence numeric(4,3) not null check (match_confidence >= 0 and match_confidence <= 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists music_release_groups_artist_order_idx on public.music_release_groups(artist_id, first_release_date, id);
create index if not exists music_release_groups_normalized_title_idx on public.music_release_groups(normalized_title);

-- Link a Vault object to a verified canonical release group without changing
-- title, artwork, scoreHistory, dates, reviews, or any other collection JSON.
create table if not exists public.vault_album_identities (
  user_id text not null,
  album_id text not null,
  artist_id uuid references public.music_artists(id),
  release_group_id uuid references public.music_release_groups(id),
  status text not null check (status in ('pending','resolved','unresolved','ambiguous','failed')),
  source text,
  match_confidence numeric(4,3),
  release_mbid_evidence uuid,
  observed_title text,
  observed_artist text,
  observed_year text,
  attempted_at timestamptz,
  retry_after timestamptz,
  resolution_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id, album_id),
  check ((status = 'resolved') = (release_group_id is not null))
);
create index if not exists vault_album_identities_resolution_idx on public.vault_album_identities(user_id,status,retry_after);
create index if not exists vault_album_identities_release_group_idx on public.vault_album_identities(user_id,release_group_id) where release_group_id is not null;

-- Discography completeness is an explicit proof requirement for Generational
-- Run. Partial/unknown indexes can never be used to infer adjacency.
create table if not exists public.music_artist_discography_state (
  artist_id uuid primary key references public.music_artists(id) on delete cascade,
  status text not null check (status in ('pending','complete','partial','failed')),
  release_group_ids jsonb not null default '[]'::jsonb,
  source text not null default 'musicbrainz_release_group_index',
  complete_at timestamptz,
  attempted_at timestamptz,
  retry_after timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Bounded/restartable resolver bookkeeping. One user job can be resumed without
-- re-querying resolved identities or fan-out against an entire collection.
create table if not exists public.vault_music_identity_jobs (
  user_id text primary key,
  status text not null check (status in ('idle','queued','running','complete','partial','failed')),
  requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  resolved_count integer not null default 0,
  unresolved_count integer not null default 0,
  ambiguous_count integer not null default 0,
  edition_duplicates_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Identity resolution is a durable system event, never a fake rating. It lets
-- the existing evaluator reconsider only already-eligible Vault facts once a
-- trustworthy identity exists.
alter table public.vault_achievement_events
  drop constraint if exists vault_achievement_events_type_check;
alter table public.vault_achievement_events
  add constraint vault_achievement_events_type_check
  check (type in ('album_rated','album_added','review_written','review_updated','album_rescored','track_scores_saved','collection_baselined','identity_resolved'));

create table if not exists public.vault_artist_achievement_progress (
  user_id text not null,
  achievement_key text not null references public.vault_achievement_definitions(key),
  artist_id uuid not null references public.music_artists(id),
  current_level integer not null default 0,
  current_value numeric,
  target_value numeric,
  evaluated_at timestamptz not null default now(),
  primary key(user_id,achievement_key,artist_id)
);
create index if not exists vault_artist_achievement_progress_profile_idx on public.vault_artist_achievement_progress(user_id,achievement_key,current_value desc);

alter table public.music_artists enable row level security;
alter table public.music_release_groups enable row level security;
alter table public.vault_album_identities enable row level security;
alter table public.music_artist_discography_state enable row level security;
alter table public.vault_music_identity_jobs enable row level security;
alter table public.vault_artist_achievement_progress enable row level security;

revoke all on public.music_artists, public.music_release_groups, public.vault_album_identities,
  public.music_artist_discography_state, public.vault_music_identity_jobs,
  public.vault_artist_achievement_progress from anon, authenticated;
grant select,insert,update,delete on public.music_artists, public.music_release_groups,
  public.vault_album_identities, public.music_artist_discography_state,
  public.vault_music_identity_jobs, public.vault_artist_achievement_progress to service_role;
