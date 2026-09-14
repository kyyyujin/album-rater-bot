-- Cover Phase 2 foreign keys for safe deletes/joins as the private ledger grows.
create index if not exists listening_coverage_epoch_idx on public.listening_coverage_windows(epoch_id);
create index if not exists listening_daily_artist_artist_idx on public.listening_daily_artist_counts(artist_id);
create index if not exists listening_daily_release_group_rg_idx on public.listening_daily_release_group_counts(release_group_id);
create index if not exists listening_lifetime_artist_artist_idx on public.listening_lifetime_artist_counts(artist_id);
create index if not exists listening_lifetime_release_group_rg_idx on public.listening_lifetime_release_group_counts(release_group_id);
create index if not exists listening_scrobbles_artist_fk_idx on public.listening_scrobbles(artist_id) where artist_id is not null;
create index if not exists listening_scrobbles_release_group_fk_idx on public.listening_scrobbles(release_group_id) where release_group_id is not null;
