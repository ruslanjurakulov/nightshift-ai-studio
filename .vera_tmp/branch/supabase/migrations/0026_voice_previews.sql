-- 0026: private Storage bucket for voice preview clips.
--
-- ── Voice preview clips (tools/voice_previews.py) ───────────────────────────
-- The Create page lets people listen to a voice before choosing it. The clips
-- are written by the voice_previews workflow with the service key (which
-- bypasses RLS) and read by signed-in users through short-lived signed URLs.
-- Private: a cloned voice's sample is nobody else's business.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-previews', 'voice-previews', false, 5242880, array['audio/mpeg'])
on conflict (id) do nothing;

drop policy if exists voice_previews_read on storage.objects;
create policy voice_previews_read on storage.objects
  for select to authenticated using (bucket_id = 'voice-previews');
