-- ─────────────────────────────────────────────────────────────────────────
-- ai_config gains a SECOND dial: model_fast
--
-- The rule has always been "one row decides the model for every AI activity
-- in the app". That rule is not being broken here — it is being given a
-- cheap lane. `model` is still what every feature gets. `model_fast` is what
-- a feature gets ONLY if it explicitly asks ai-chat for tier:"fast".
--
-- Today exactly one feature asks: the (i) contact summary on the Calls tab.
-- It is the only AI call in the app an agent sits and waits on — two to four
-- sentences off a 6,000-character context, the most mechanical job the app
-- gives a model, and about 1.2 seconds of the ~6.8s tap.
--
-- To put that feature back on the main model, blank this column. Nothing is
-- redeployed and nothing else changes: ai-chat falls through to `model`.
--
-- ai-chat reads `model, model_fast` and RETRIES with `model` alone if that
-- select errors, because PostgREST fails the whole row on an unknown column —
-- which would have dropped every AI feature in the app onto the hardcoded
-- default the moment the function shipped ahead of this file.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.ai_config add column if not exists model_fast text;

comment on column public.ai_config.model_fast is
  'Optional quicker/cheaper model for features that send tier:"fast" to ai-chat. Blank = those features use `model` like everything else.';

update public.ai_config
   set model_fast = 'claude-haiku-4-5-20251001'
 where id = 1
   and (model_fast is null or btrim(model_fast) = '');
