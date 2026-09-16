-- Establish the real Phase 3B period-closing cutoff. This creates no period,
-- ranking, listening event or unlock; the containing week/month will remain
-- explicitly partial when it eventually closes.
insert into public.listening_period_closer_state(user_id,epoch_id,timezone,closing_started_at)
select user_id,id,timezone,clock_timestamp()
from public.lastfm_tracking_epochs
where status='active'
on conflict(user_id,epoch_id) do nothing;
