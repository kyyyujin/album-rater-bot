-- Discord posting configuration belongs to the authenticated Rater user, not to
-- untrusted browser form data. This table is consumed only by the backend's
-- service-role path; no browser-facing grants are added here.
begin;

create table if not exists public.rater_discord_settings (
  user_id text primary key references public.users(username) on delete cascade,
  thread_id text not null check (thread_id ~ '^[0-9]{17,20}$'),
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.rater_discord_settings enable row level security;
revoke all on table public.rater_discord_settings from anon, authenticated;

commit;
