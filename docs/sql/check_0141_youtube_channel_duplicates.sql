-- check_0141_youtube_channel_duplicates.sql — READ-ONLY. Run in the Supabase SQL editor BEFORE applying migration 0141.
--
-- Lists every YouTube channel id that is connected in more than one organization today, one row per Nightshift channel that holds it,
-- with how it holds it. 0141 refuses to apply while this returns any row; it never picks a winner. Decide which connection stays,
-- disconnect the others (select public.revoke_channel_token('<channel_id>'); for a Vault connection, and for an operator channel that is
-- only confirmed (via = 'confirmed') rewrite its credential without the stamp), then run this again until it returns no row.
--
-- "Holds" is 0141's definition of connected:
--   via = 'vault_token'  channel_token_refs: vault_secret_id is not null and revoked_at is null (an active Vault connection);
--   via = 'confirmed'    channels.credential_ref: verified_at is set (confirmed against YouTube) for that youtube_channel_id.
-- The id is compared after btrim, case-sensitively. Writes nothing; takes no lock beyond a plain read.
with claims as (
  select c.channel_id, c.org_id, btrim(c.credential_ref ->> 'youtube_channel_id') as youtube_channel_id,
         'confirmed'::text as via, c.created_at::text as channel_created_at, null::timestamptz as connected_at
    from public.channels c
   where coalesce(c.credential_ref ->> 'verified_at', '') <> ''
     and coalesce(btrim(c.credential_ref ->> 'youtube_channel_id'), '') <> ''
  union all
  select r.channel_id, c.org_id, btrim(r.youtube_channel_id), 'vault_token', c.created_at::text, r.connected_at
    from public.channel_token_refs r
    join public.channels c on c.channel_id = r.channel_id
   where r.vault_secret_id is not null and r.revoked_at is null
     and coalesce(btrim(r.youtube_channel_id), '') <> ''
), shared as (
  select youtube_channel_id
    from claims
   group by youtube_channel_id
  having count(distinct coalesce(org_id::text, '')) > 1
)
select cl.youtube_channel_id, cl.org_id, o.name as org_name, cl.channel_id, cl.via, cl.channel_created_at, cl.connected_at
  from claims cl
  join shared s on s.youtube_channel_id = cl.youtube_channel_id
  left join public.organizations o on o.id = cl.org_id
 order by cl.youtube_channel_id, cl.org_id, cl.channel_id, cl.via;
