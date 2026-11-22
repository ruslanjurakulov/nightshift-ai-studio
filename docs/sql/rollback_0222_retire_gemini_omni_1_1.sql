-- rollback_0222_retire_gemini_omni_1_1.sql — owner-applied only. Puts gemini-omni-1.1-flash back to 'hidden' (0035's default: not
-- sold, still terms-gated). It does NOT put it on sale: that would need a new probe, a price and a cleared terms gate, and from
-- 2026-12-03 Google serves gemini-omni-1.2-flash behind this id (docs/studio/S10_GOOGLE_MODELS.md), so read 0222's header first.
begin;
update public.model_registry set availability = 'hidden' where id = 'gemini-omni-1.1-flash' and availability = 'disabled';
commit;
