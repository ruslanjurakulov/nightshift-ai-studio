-- Rollback of 0195_open_llm_describe.sql (owner-applied, SQL editor): the two describe models hidden again. 0195 wrote no price, so this
-- deletes none. A model the owner set to ga or disabled by hand is left as it is.
update public.model_registry
   set availability = 'hidden'
 where id in ('anthropic-claude-sonnet-5-5', 'openai-gpt-6-luna')
   and availability = 'beta';
