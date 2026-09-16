-- Cover Phase 3B epoch foreign keys for bounded joins and future epoch cleanup.
create index if not exists listening_period_closer_state_epoch_idx
  on public.listening_period_closer_state(epoch_id);
create index if not exists listening_period_snapshots_epoch_idx
  on public.listening_period_snapshots(epoch_id);
