-- A channel is an account only once YouTube says so.
--
-- Until now the Command Center could confirm a channel against the YouTube
-- Data API — it fetched the avatar, the title and the counts — but nothing
-- required it. A row created with a name, a niche and a guessed channel id was
-- indistinguishable from a real one, and the scheduler ran it. That is how the
-- `ruslanjurakulov` channel came to hold an ElevenLabs voice id of
-- "16516516145" and to be dispatched a job on every manual run.
--
-- Two guarantees, both enforced here rather than only in the browser, because
-- a rule that lives only in a form is a rule until someone uses the API.

-- ── 1. ACTIVE requires proof ────────────────────────────────────────────────
-- Anyone can create a channel. Nobody can activate one that YouTube has not
-- answered for. An unconfirmed row stays in the registry — visible, editable,
-- and doing nothing — which is exactly what a draft should do.
--
-- The 'default' channel is exempt. It predates the registry: it is the single
-- channel this bot has always published as, its identity comes from config.py,
-- and it never passed through a form that could have confirmed it.

-- First make the data satisfy the rule. An ACTIVE channel with no proof is
-- demoted rather than deleted: the operator's work is kept, the scheduling is
-- not. Re-confirming it in the Command Center is what brings it back.
update public.channels
   set status = 'PAUSED',
       updated_at = now()
 where status = 'ACTIVE'
   and channel_id <> 'default'
   and coalesce(credential_ref->>'verified_at', '') = '';

alter table public.channels
  drop constraint if exists channels_active_requires_verification;
alter table public.channels
  add constraint channels_active_requires_verification
  check (
    status <> 'ACTIVE'
    or channel_id = 'default'
    or coalesce(credential_ref->>'verified_at', '') <> ''
  );

comment on constraint channels_active_requires_verification on public.channels is
  'A channel may only be ACTIVE once the Command Center has confirmed it against the YouTube Data API and written credential_ref.verified_at. Unconfirmed rows stay dormant instead of being scheduled.';

-- ── 2. One ElevenLabs voice, one channel ────────────────────────────────────
-- Two channels narrated by the same voice sound like one channel with two
-- names, which defeats the point of running more than one. Partial, so it only
-- constrains channels that actually use ElevenLabs; edge channels share the
-- default edge voice harmlessly, and that is a separate (cosmetic) choice.
create unique index if not exists channels_elevenlabs_voice_unique
  on public.channels ((agent_config->>'elevenlabs_voice_id'))
  where agent_config->>'tts_provider' = 'elevenlabs'
    and coalesce(agent_config->>'elevenlabs_voice_id', '') <> '';
