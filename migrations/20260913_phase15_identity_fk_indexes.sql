-- Cover Phase 1.5 foreign keys used by identity maintenance and avoid
-- unnecessary parent-table scans on canonical entity cleanup.
create index if not exists vault_album_identities_artist_id_idx
  on public.vault_album_identities(artist_id) where artist_id is not null;
create index if not exists vault_album_identities_release_group_id_idx
  on public.vault_album_identities(release_group_id) where release_group_id is not null;
create index if not exists vault_artist_achievement_progress_artist_id_idx
  on public.vault_artist_achievement_progress(artist_id);
create index if not exists vault_artist_achievement_progress_achievement_key_idx
  on public.vault_artist_achievement_progress(achievement_key);
