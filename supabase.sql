-- rikin-auto-IG storage table.
-- Run this once in Supabase → SQL Editor (New query → paste → Run).

create table if not exists app_store (
  id text primary key,
  data jsonb
);

-- Locks the table so only your server (service_role key) can read/write it.
alter table app_store enable row level security;

-- Activity log: one row per automation action (invite, link sent, nudge, public reply).
create table if not exists dm_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  type text,
  status text,
  ig_account_id text,
  recipient_id text,
  recipient_username text,
  comment_id text,
  media_id text,
  rule_id text,
  rule_name text,
  link text,
  message text,
  error text
);
create index if not exists dm_events_created_at_idx on dm_events (created_at desc);
alter table dm_events enable row level security;
