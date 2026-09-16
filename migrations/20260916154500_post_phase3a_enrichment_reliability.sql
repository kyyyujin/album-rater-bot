-- Post-Phase 3A reliability checkpoint.
-- 1. Recover only terminal jobs whose recorded failure is demonstrably a
--    MusicBrainz transport failure. Canonical no-match/ambiguous outcomes are
--    deliberately excluded.
-- 2. Schedule bounded enrichment independently from Last.fm ingestion.
-- Raw timestamps, fingerprints, epochs, watermarks and coverage are untouched.

alter table public.listening_scrobbles
  drop constraint if exists listening_scrobbles_enrichment_status_check;
alter table public.listening_scrobbles
  add constraint listening_scrobbles_enrichment_status_check
  check (enrichment_status in ('pending','resolved','unresolved','ambiguous','retry','failed'));

create table if not exists public.listening_enrichment_recovery_audit (
  id bigint generated always as identity primary key,
  migration_key text not null,
  scrobble_id uuid not null references public.listening_scrobbles(id) on delete cascade,
  previous_job_status text not null,
  previous_scrobble_status text not null,
  previous_reason text,
  attempts integer not null,
  last_error text,
  recovered_to_status text not null,
  recovered_reason text not null,
  recovered_at timestamptz not null default clock_timestamp(),
  unique(migration_key,scrobble_id)
);

alter table public.listening_enrichment_recovery_audit enable row level security;
revoke all on public.listening_enrichment_recovery_audit from public,anon,authenticated;
grant select,insert on public.listening_enrichment_recovery_audit to service_role;

insert into public.listening_enrichment_recovery_audit(
  migration_key,scrobble_id,previous_job_status,previous_scrobble_status,
  previous_reason,attempts,last_error,recovered_to_status,recovered_reason
)
select
  '20260916154500_transport_recovery',j.scrobble_id,j.status,s.enrichment_status,
  j.resolution_reason,j.attempts,j.last_error,'retry','musicbrainz_transport_error'
from public.listening_enrichment_jobs j
join public.listening_scrobbles s on s.id=j.scrobble_id
where j.status='unresolved'
  and j.resolution_reason='enrichment_error'
  and s.enrichment_status='unresolved'
  and s.enrichment_reason='enrichment_error'
  and coalesce(j.last_error,'') ~* '^request to https://musicbrainz\.org/.+ failed, reason:'
on conflict(migration_key,scrobble_id) do nothing;

update public.listening_enrichment_jobs j
set status='retry',
    next_attempt_at=clock_timestamp()
      + least(
          interval '24 hours',
          interval '30 minutes' * power(2,least(greatest(j.attempts,1)-1,6))
        ),
    locked_until=null,
    resolution_reason='musicbrainz_transport_error',
    updated_at=clock_timestamp()
where j.status='unresolved'
  and j.resolution_reason='enrichment_error'
  and exists (
    select 1 from public.listening_enrichment_recovery_audit a
    where a.migration_key='20260916154500_transport_recovery'
      and a.scrobble_id=j.scrobble_id
  );

update public.listening_scrobbles s
set enrichment_status='retry',
    enrichment_reason='musicbrainz_transport_error',
    enrichment_metadata=coalesce(s.enrichment_metadata,'{}'::jsonb)
      || jsonb_build_object(
        'recovered_by','20260916154500_transport_recovery',
        'previous_reason','enrichment_error',
        'retryable',true,
        'error_category','external_transport'
      )
where s.enrichment_status='unresolved'
  and s.enrichment_reason='enrichment_error'
  and exists (
    select 1 from public.listening_enrichment_recovery_audit a
    where a.migration_key='20260916154500_transport_recovery'
      and a.scrobble_id=s.id
  );

create or replace function public.enqueue_listening_enrichment_batch()
returns void language plpgsql security definer set search_path=public,net as $$
declare v_token text;
begin
  select scheduler_token into v_token
  from public.listening_scheduler_config where singleton;
  perform net.http_post(
    url:='https://album-rater-bot.onrender.com/internal/listening/enrich',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-album-vault-scheduler',v_token
    ),
    body:='{"limit":1}'::jsonb,
    timeout_milliseconds:=25000
  );
end $$;

do $$ begin
  if exists(select 1 from cron.job where jobname='album_vault_listening_enrichment') then
    perform cron.unschedule(jobid)
    from cron.job where jobname='album_vault_listening_enrichment';
  end if;
  perform cron.schedule(
    'album_vault_listening_enrichment',
    '2-59/5 * * * *',
    $cron$select public.enqueue_listening_enrichment_batch();$cron$
  );
end $$;

revoke all on function public.enqueue_listening_enrichment_batch() from public,anon,authenticated;
