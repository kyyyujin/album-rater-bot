-- Persist a canonical IANA timezone per application user. Raw listening times
-- remain UTC timestamptz; only local projections and their aggregates rebuild.
alter table public.users add column if not exists timezone text;

create or replace function public.set_user_listening_timezone(p_user_id text, p_timezone text)
returns table(timezone text, projected_scrobbles bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text := trim(p_timezone);
  v_current text;
  v_projected bigint := 0;
begin
  if v_timezone is null or v_timezone = '' or not exists (
    select 1 from pg_catalog.pg_timezone_names where name = v_timezone
  ) then
    raise exception 'invalid IANA timezone';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('lastfm:' || p_user_id));
  perform 1 from public.lastfm_tracking_epochs where user_id = p_user_id for update;

  select u.timezone into v_current from public.users u where u.username = p_user_id for update;
  if not found then raise exception 'unknown user'; end if;
  if v_current = v_timezone and not exists (
    select 1 from public.lastfm_tracking_epochs e where e.user_id = p_user_id and e.timezone <> v_timezone
  ) then
    update public.users set vault_profile = coalesce(vault_profile, '{}'::jsonb) || jsonb_build_object('timezone', v_timezone)
     where username = p_user_id;
    return query select v_timezone, 0::bigint;
    return;
  end if;

  update public.users
     set timezone = v_timezone,
         vault_profile = coalesce(vault_profile, '{}'::jsonb) || jsonb_build_object('timezone', v_timezone)
   where username = p_user_id;
  update public.lastfm_tracking_epochs
     set timezone = v_timezone, updated_at = clock_timestamp()
   where user_id = p_user_id;

  update public.listening_scrobbles
     set local_date = (played_at at time zone v_timezone)::date,
         local_hour = extract(hour from played_at at time zone v_timezone)::smallint
   where user_id = p_user_id;
  get diagnostics v_projected = row_count;

  delete from public.listening_daily_totals where user_id = p_user_id;
  delete from public.listening_daily_artist_counts where user_id = p_user_id;
  delete from public.listening_daily_release_group_counts where user_id = p_user_id;
  delete from public.listening_hour_totals where user_id = p_user_id;

  insert into public.listening_daily_totals(user_id, local_date, scrobble_count)
  select user_id, local_date, count(*) from public.listening_scrobbles
   where user_id = p_user_id group by user_id, local_date;
  insert into public.listening_daily_artist_counts(user_id, local_date, artist_id, scrobble_count)
  select user_id, local_date, artist_id, count(*) from public.listening_scrobbles
   where user_id = p_user_id and artist_id is not null group by user_id, local_date, artist_id;
  insert into public.listening_daily_release_group_counts(user_id, local_date, release_group_id, scrobble_count)
  select user_id, local_date, release_group_id, count(*) from public.listening_scrobbles
   where user_id = p_user_id and release_group_id is not null group by user_id, local_date, release_group_id;
  insert into public.listening_hour_totals(user_id, local_date, local_hour, scrobble_count)
  select user_id, local_date, local_hour, count(*) from public.listening_scrobbles
   where user_id = p_user_id group by user_id, local_date, local_hour;

  return query select v_timezone, v_projected;
end $$;

-- Local projections are derived from the epoch timezone inside PostgreSQL.
-- The server-supplied projection is intentionally ignored, so a timezone
-- change remains safe even if a sync request was already in flight.
create or replace function public.lastfm_apply_sync_batch(p_epoch_id uuid, p_user_id text, p_items jsonb, p_watermark timestamptz, p_coverage_until timestamptz, p_backlog_cursor_before timestamptz default null)
returns table(inserted integer, watermark_played_at timestamptz, coverage_cursor_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_epoch public.lastfm_tracking_epochs; v_inserted integer:=0; v_new_watermark timestamptz; v_new_coverage timestamptz;
begin
  select * into v_epoch from public.lastfm_tracking_epochs where id=p_epoch_id and user_id=p_user_id and status='active' for update;
  if not found then raise exception 'inactive or unknown Last.fm epoch'; end if;
  create temporary table if not exists pg_temp.lastfm_sync_inserted (user_id text, artist_id uuid, release_group_id uuid, played_at timestamptz, local_date date, local_hour smallint) on commit drop;
  truncate pg_temp.lastfm_sync_inserted;
  with source as (
    select p_epoch_id as epoch_id,p_user_id as user_id,nullif(x->>'artist_id','')::uuid as artist_id,nullif(x->>'release_group_id','')::uuid as release_group_id,x->>'source_artist' as source_artist,nullif(x->>'source_album','') as source_album,x->>'source_track' as source_track,nullif(x->>'source_artist_mbid','')::uuid as source_artist_mbid,nullif(x->>'source_album_mbid','')::uuid as source_album_mbid,(x->>'played_at')::timestamptz as played_at,((x->>'played_at')::timestamptz at time zone v_epoch.timezone)::date as local_date,extract(hour from (x->>'played_at')::timestamptz at time zone v_epoch.timezone)::smallint as local_hour,x->>'source_fingerprint' as source_fingerprint,nullif(x->>'match_confidence','')::numeric as match_confidence,coalesce(nullif(x->>'match_source',''),'unresolved') as match_source from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) x
  ), ins as (
    insert into public.listening_scrobbles(epoch_id,user_id,artist_id,release_group_id,source_artist,source_album,source_track,source_artist_mbid,source_album_mbid,played_at,local_date,local_hour,source_fingerprint,match_confidence,match_source)
    select epoch_id,user_id,artist_id,release_group_id,source_artist,source_album,source_track,source_artist_mbid,source_album_mbid,played_at,local_date,local_hour,source_fingerprint,match_confidence,match_source from source where played_at>=v_epoch.lastfm_tracking_started_at on conflict(epoch_id,source_fingerprint) do nothing returning user_id,artist_id,release_group_id,played_at,local_date,local_hour
  ) insert into pg_temp.lastfm_sync_inserted select * from ins;
  get diagnostics v_inserted=row_count;
  insert into public.listening_lifetime_artist_counts(user_id,artist_id,scrobble_count,first_played_at,last_played_at) select user_id,artist_id,count(*),min(played_at),max(played_at) from pg_temp.lastfm_sync_inserted where artist_id is not null group by user_id,artist_id on conflict(user_id,artist_id) do update set scrobble_count=public.listening_lifetime_artist_counts.scrobble_count+excluded.scrobble_count,first_played_at=least(public.listening_lifetime_artist_counts.first_played_at,excluded.first_played_at),last_played_at=greatest(public.listening_lifetime_artist_counts.last_played_at,excluded.last_played_at),updated_at=clock_timestamp();
  insert into public.listening_lifetime_release_group_counts(user_id,release_group_id,scrobble_count,first_played_at,last_played_at) select user_id,release_group_id,count(*),min(played_at),max(played_at) from pg_temp.lastfm_sync_inserted where release_group_id is not null group by user_id,release_group_id on conflict(user_id,release_group_id) do update set scrobble_count=public.listening_lifetime_release_group_counts.scrobble_count+excluded.scrobble_count,first_played_at=least(public.listening_lifetime_release_group_counts.first_played_at,excluded.first_played_at),last_played_at=greatest(public.listening_lifetime_release_group_counts.last_played_at,excluded.last_played_at),updated_at=clock_timestamp();
  insert into public.listening_daily_totals(user_id,local_date,scrobble_count) select user_id,local_date,count(*) from pg_temp.lastfm_sync_inserted group by user_id,local_date on conflict(user_id,local_date) do update set scrobble_count=public.listening_daily_totals.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  insert into public.listening_daily_artist_counts(user_id,local_date,artist_id,scrobble_count) select user_id,local_date,artist_id,count(*) from pg_temp.lastfm_sync_inserted where artist_id is not null group by user_id,local_date,artist_id on conflict(user_id,local_date,artist_id) do update set scrobble_count=public.listening_daily_artist_counts.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  insert into public.listening_daily_release_group_counts(user_id,local_date,release_group_id,scrobble_count) select user_id,local_date,release_group_id,count(*) from pg_temp.lastfm_sync_inserted where release_group_id is not null group by user_id,local_date,release_group_id on conflict(user_id,local_date,release_group_id) do update set scrobble_count=public.listening_daily_release_group_counts.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  insert into public.listening_hour_totals(user_id,local_date,local_hour,scrobble_count) select user_id,local_date,local_hour,count(*) from pg_temp.lastfm_sync_inserted group by user_id,local_date,local_hour on conflict(user_id,local_date,local_hour) do update set scrobble_count=public.listening_hour_totals.scrobble_count+excluded.scrobble_count,updated_at=clock_timestamp();
  if p_coverage_until is not null and p_coverage_until>v_epoch.coverage_cursor_at then insert into public.listening_coverage_windows(user_id,epoch_id,coverage_start,coverage_end,status,reason) values(p_user_id,p_epoch_id,v_epoch.coverage_cursor_at,p_coverage_until,'covered','recenttracks_reconciled'); end if;
  update public.lastfm_tracking_epochs as e set watermark_played_at=greatest(e.watermark_played_at,coalesce(p_watermark,e.watermark_played_at)),backlog_cursor_before=p_backlog_cursor_before,coverage_cursor_at=greatest(e.coverage_cursor_at,coalesce(p_coverage_until,e.coverage_cursor_at)),last_sync_at=clock_timestamp(),last_success_at=clock_timestamp(),last_error_at=null,last_error_code=null,consecutive_failures=0,updated_at=clock_timestamp() where e.id=p_epoch_id returning e.watermark_played_at,e.coverage_cursor_at into v_new_watermark,v_new_coverage;
  return query select v_inserted,v_new_watermark,v_new_coverage;
end $$;

revoke all on function public.set_user_listening_timezone(text,text) from public,anon,authenticated;
grant execute on function public.set_user_listening_timezone(text,text) to service_role;
revoke all on function public.lastfm_apply_sync_batch(uuid,text,jsonb,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.lastfm_apply_sync_batch(uuid,text,jsonb,timestamptz,timestamptz,timestamptz) to service_role;
