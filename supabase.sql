-- rikin-auto-IG storage table.
-- Run this once in Supabase → SQL Editor (New query → paste → Run).

create table if not exists app_store (
  id text primary key,
  data jsonb
);

-- Locks the table so only your server (service_role key) can read/write it.
alter table app_store enable row level security;
