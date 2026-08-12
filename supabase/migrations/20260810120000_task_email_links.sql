-- Task ↔ Gmail thread links (TMG-Toolbar-and-Email-Brief_1.md, Feature 2 §2.1).
-- A task can have zero or more linked Gmail threads. This table is a READ-ONLY
-- MIRROR: it caches just enough of each thread to render a row without another
-- Gmail round-trip (from/subject/snippet/date) plus a stable permalink back to
-- the real message in Gmail. It never stores full message bodies — those are
-- fetched live from Gmail (via the google-calendar edge function's gmail_thread
-- action) when the task's Email tab is opened. Deleting a row here only clears
-- the link; it never touches the actual email [brief §2.6].
--
-- Not run automatically — paste into the Supabase SQL editor (Dashboard →
-- SQL Editor) or `supabase db push` once linked, same as this project's other
-- ad-hoc schema changes.

create table if not exists public.task_email_links (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  thread_id    text not null,
  message_id   text,
  permalink    text not null,
  from_addr    text,
  subject      text,
  snippet      text,
  email_date   timestamptz,
  auto_linked  boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles(id) on delete set null,

  -- A given thread can only be linked to the same task once (re-attaching is a no-op,
  -- not a duplicate row) — matches the mailbox's "already linked" chip [brief §2.2].
  unique (task_id, thread_id)
);

create index if not exists task_email_links_task_id_idx on public.task_email_links(task_id);
create index if not exists task_email_links_thread_id_idx on public.task_email_links(thread_id);

alter table public.task_email_links enable row level security;

-- Same visibility model as `tasks` itself: any active, signed-in TMG profile can
-- read/write links (this app has no per-task ACL to piggyback on — matches how
-- `tasks` and `google_tokens` are scoped elsewhere in this project).
create policy "task_email_links_select_active" on public.task_email_links
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'));

create policy "task_email_links_insert_active" on public.task_email_links
  for insert to authenticated
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'));

create policy "task_email_links_delete_active" on public.task_email_links
  for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'));
