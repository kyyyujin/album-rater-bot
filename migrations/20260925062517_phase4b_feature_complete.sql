-- Phase 4B: final private-beta meta progression, approved cosmetics,
-- privacy-safe prevalence cache, and bounded evidence for temporal Listening.

create table public.vault_emblem_state (
  user_id text primary key,
  current_level smallint not null default 0 check(current_level between 0 and 6),
  pending_level smallint check(pending_level between 1 and 6),
  pending_snapshot jsonb,
  progress jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(pending_level is null or pending_level>current_level)
);
create table public.vault_emblem_upgrades (
  id uuid primary key default gen_random_uuid(), user_id text not null,
  tier_level smallint not null check(tier_level between 1 and 6), tier_key text not null,
  evidence jsonb not null, eligible_at timestamptz not null, acknowledged_at timestamptz not null default clock_timestamp(),
  rule_version integer not null default 1, unique(user_id,tier_level)
);
create index vault_emblem_upgrades_user_idx on public.vault_emblem_upgrades(user_id,tier_level desc);

create table public.vault_cosmetic_entitlements (
  user_id text not null, cosmetic_key text not null,
  source_achievement_key text not null references public.vault_achievement_definitions(key),
  source_unlock_id uuid not null references public.vault_achievement_unlocks(id) on delete restrict,
  granted_at timestamptz not null default clock_timestamp(), metadata jsonb not null default '{}'::jsonb,
  primary key(user_id,cosmetic_key), unique(user_id,source_unlock_id)
);
create table public.vault_cosmetic_state (
  user_id text primary key, equipped_key text, updated_at timestamptz not null default clock_timestamp()
);
alter table public.vault_cosmetic_state add constraint vault_cosmetic_state_entitlement_fk
  foreign key(user_id,equipped_key) references public.vault_cosmetic_entitlements(user_id,cosmetic_key) on delete restrict;

create table public.vault_achievement_prevalence (
  achievement_key text primary key references public.vault_achievement_definitions(key) on delete cascade,
  eligible_population integer not null check(eligible_population>=0), unlocked_population integer not null check(unlocked_population>=0),
  percentage numeric(6,3), display_enabled boolean not null default false,
  calculated_at timestamptz not null default clock_timestamp(),
  check(unlocked_population<=eligible_population),
  check(display_enabled=false or eligible_population>=30)
);

create or replace function public.prevent_phase4b_evidence_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$ begin
  raise exception 'Earned Emblem and cosmetic evidence is immutable';
end $$;
create trigger vault_emblem_upgrades_immutable before update or delete on public.vault_emblem_upgrades for each row execute function public.prevent_phase4b_evidence_mutation();
create trigger vault_cosmetic_entitlements_immutable before update or delete on public.vault_cosmetic_entitlements for each row execute function public.prevent_phase4b_evidence_mutation();

create or replace function public.achievement_temporal_listening_evidence(p_user_id text,p_epoch_id uuid,p_now timestamptz default clock_timestamp())
returns jsonb language sql stable security definer set search_path='' as $$
with epoch as (
  select e.id,e.timezone from public.lastfm_tracking_epochs e where e.id=p_epoch_id and e.user_id=p_user_id
), w30 as (
  select s.* from public.listening_scrobbles s,epoch e where s.user_id=p_user_id and s.epoch_id=e.id and s.played_at>p_now-interval '30 days' and s.played_at<=p_now
), w60 as (
  select s.* from public.listening_scrobbles s,epoch e where s.user_id=p_user_id and s.epoch_id=e.id and s.played_at>p_now-interval '60 days' and s.played_at<=p_now
), coverage as (
  select days,not exists(
    select 1 from public.listening_coverage_windows c,epoch e
    where c.user_id=p_user_id and c.epoch_id=e.id and c.status<>'covered'
      and c.coverage_end>p_now-make_interval(days=>days) and c.coverage_start<p_now
  ) and coalesce((select sum(extract(epoch from least(c.coverage_end,p_now)-greatest(c.coverage_start,p_now-make_interval(days=>days))))
    from public.listening_coverage_windows c,epoch e where c.user_id=p_user_id and c.epoch_id=e.id and c.status='covered'
      and c.coverage_end>p_now-make_interval(days=>days) and c.coverage_start<p_now),0)>=days*86400-1 continuous
  from (values(30),(60)) d(days)
), totals as (select count(*) total,count(*) filter(where artist_id is null) unresolved from w30),
artist30 as (
  select s.artist_id,count(*) artist_scrobbles,count(*) filter(where s.local_hour<5) night_scrobbles
  from w30 s where s.artist_id is not null group by s.artist_id
), artist_evidence as (
  select a.artist_id,a.artist_scrobbles,a.night_scrobbles,t.total,t.unresolved,m.display_name,m.musicbrainz_artist_mbid
  from artist30 a cross join totals t join public.music_artists m on m.id=a.artist_id
), decade as (
  select (extract(year from g.first_release_date)::int/10)*10 decade,array_agg(distinct s.track_id) tracks
  from w30 s join public.music_release_groups g on g.id=s.release_group_id
  where s.track_id is not null and g.first_release_date is not null group by 1
), hours as (select local_hour,count(*) count from w60 group by local_hour),
recent_returns as (
  select s.id return_id,s.release_group_id,s.played_at return_at,prev.id previous_id,prev.played_at previous_at,
    floor(extract(epoch from s.played_at-prev.played_at)/86400)::int gap_days,
    exists(select 1 from public.listening_coverage_windows c where c.user_id=p_user_id and c.epoch_id=p_epoch_id and c.status='covered' and prev.played_at>=c.coverage_start and prev.played_at<c.coverage_end) previous_covered,
    exists(select 1 from public.listening_coverage_windows c where c.user_id=p_user_id and c.epoch_id=p_epoch_id and c.status='covered' and s.played_at>=c.coverage_start and s.played_at<c.coverage_end) return_covered
  from w30 s cross join lateral(select x.id,x.played_at from public.listening_scrobbles x where x.user_id=p_user_id and x.epoch_id=p_epoch_id and x.release_group_id=s.release_group_id and x.played_at<s.played_at order by x.played_at desc limit 1) prev
  where s.release_group_id is not null and s.track_id is not null and s.played_at-prev.played_at>=interval '365 days'
)
select jsonb_build_object(
  'window30',jsonb_build_object('start',p_now-interval '30 days','end',p_now,'continuous',(select continuous from coverage where days=30),'identity_complete',(select unresolved=0 from totals)),
  'window60',jsonb_build_object('start',p_now-interval '60 days','end',p_now,'continuous',(select continuous from coverage where days=60)),
  'artists',coalesce((select jsonb_agg(jsonb_build_object('artist_id',artist_id,'display_name',display_name,'musicbrainz_artist_mbid',musicbrainz_artist_mbid,'artist_scrobbles',artist_scrobbles,'night_scrobbles',night_scrobbles,'total_scrobbles',total)) from artist_evidence),'[]'::jsonb),
  'decade_tracks',coalesce((select jsonb_object_agg(decade,tracks) from decade),'{}'::jsonb),
  'hour_counts',coalesce((select jsonb_object_agg(local_hour,count) from hours),'{}'::jsonb),
  'lost_found',coalesce((select jsonb_agg(jsonb_build_object('return_scrobble_id',return_id,'release_group_id',release_group_id,'return_played_at',return_at,'previous_scrobble_id',previous_id,'previous_played_at',previous_at,'gap_days',gap_days,'coverage_at_previous',previous_covered,'coverage_at_return',return_covered)) from recent_returns),'[]'::jsonb),
  'epoch_id',p_epoch_id,'timezone',(select timezone from epoch)
);
$$;

alter table public.vault_emblem_state enable row level security;
alter table public.vault_emblem_upgrades enable row level security;
alter table public.vault_cosmetic_entitlements enable row level security;
alter table public.vault_cosmetic_state enable row level security;
alter table public.vault_achievement_prevalence enable row level security;
revoke all on public.vault_emblem_state,public.vault_emblem_upgrades,public.vault_cosmetic_entitlements,public.vault_cosmetic_state,public.vault_achievement_prevalence from public,anon,authenticated;
grant select,insert,update,delete on public.vault_emblem_state,public.vault_cosmetic_state,public.vault_achievement_prevalence to service_role;
grant select,insert on public.vault_emblem_upgrades,public.vault_cosmetic_entitlements to service_role;
revoke all on function public.prevent_phase4b_evidence_mutation() from public,anon,authenticated;
revoke all on function public.achievement_temporal_listening_evidence(text,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.prevent_phase4b_evidence_mutation() to service_role;
grant execute on function public.achievement_temporal_listening_evidence(text,uuid,timestamptz) to service_role;
