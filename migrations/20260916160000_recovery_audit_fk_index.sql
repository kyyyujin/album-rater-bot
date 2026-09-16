-- Cover the audit table's scrobble foreign key for bounded deletes/joins.
create index if not exists listening_enrichment_recovery_audit_scrobble_idx
  on public.listening_enrichment_recovery_audit(scrobble_id);
