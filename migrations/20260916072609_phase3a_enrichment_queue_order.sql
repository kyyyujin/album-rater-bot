-- Group enrichment work by album identity and prioritize cached releases. This
-- reduces MusicBrainz calls without changing retry/backoff or job semantics.
create or replace function public.claim_listening_enrichment_jobs(p_limit integer default 3)
returns table(scrobble_id uuid,user_id text,attempts integer)
language plpgsql security definer set search_path='' as $$
begin
  return query
  with picked as (
    select j.scrobble_id
    from public.listening_enrichment_jobs j
    join public.listening_scrobbles s on s.id=j.scrobble_id
    where j.status in ('queued','retry') and j.next_attempt_at<=clock_timestamp()
      and (j.locked_until is null or j.locked_until<clock_timestamp())
    order by
      exists(select 1 from public.music_releases r where r.musicbrainz_release_mbid=s.source_album_mbid) desc,
      coalesce(s.source_album_mbid::text,lower(s.source_artist)||'|'||lower(coalesce(s.source_album,''))),
      j.next_attempt_at,j.created_at,j.scrobble_id
    for update of j skip locked limit greatest(1,least(coalesce(p_limit,3),10))
  ), claimed as (
    update public.listening_enrichment_jobs j set status='running',attempts=j.attempts+1,
      locked_until=clock_timestamp()+interval '4 minutes',updated_at=clock_timestamp()
    from picked where j.scrobble_id=picked.scrobble_id
    returning j.scrobble_id,j.user_id,j.attempts
  ) select * from claimed;
end $$;

revoke all on function public.claim_listening_enrichment_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_listening_enrichment_jobs(integer) to service_role;
