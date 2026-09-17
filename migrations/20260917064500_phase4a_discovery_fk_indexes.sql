-- Cover Phase 4A foreign keys used by maintenance/deletion checks without
-- changing Discovery evaluation or any listening evidence.
create index if not exists listening_discovery_windows_epoch_idx
  on public.listening_discovery_artist_windows(epoch_id);
create index if not exists listening_discovery_windows_artist_idx
  on public.listening_discovery_artist_windows(artist_id);
