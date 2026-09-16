-- Cover Phase 3A foreign keys used by cleanup and epoch maintenance. The
-- user/time partial track index remains for lookups; this full index covers FK
-- validation when a canonical recording is maintained.
create index if not exists listening_scrobbles_track_fk_idx
  on public.listening_scrobbles(track_id);
create index if not exists listening_sessions_epoch_idx
  on public.listening_sessions(epoch_id);
create index if not exists listening_album_runs_epoch_idx
  on public.listening_album_runs(epoch_id);
