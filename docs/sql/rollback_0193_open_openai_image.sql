-- Rollback of 0193_open_openai_image.sql (owner-applied, SQL editor). Puts the OpenAI GPT Image models back to hidden. It writes and
-- deletes no credit_prices row: 0193 wrote none. A model the owner set to ga or disabled by hand is left as it is. The entitlement stays
-- NULL (0173's diagnosis: plan tiers are not enforced anywhere yet).
update public.model_registry
   set availability = 'hidden'
 where id in ('openai-gpt-image-2', 'openai-gpt-image-2.5-flare', 'openai-gpt-image-2.5-sunburst',
              'openai-gpt-image-2.6-flare', 'openai-gpt-image-2.6-sunburst')
   and availability = 'beta';
