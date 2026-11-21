-- 0095: customer-facing plan names. 'creator' becomes Plus and 'studio' becomes
-- Business; "Studio" is also the name of the generation tool, and "Creator" was
-- also the name of a credit pack. Only the display name changes: the plan ids
-- (creator / pro / studio), entitlements, credits and Paddle price mappings are
-- untouched. A name an admin already edited is left alone (the where clause only
-- matches the old seeded name), so re-running changes nothing.
update public.plans set name = 'Plus'     where id = 'creator' and name = 'Creator';
update public.plans set name = 'Business' where id = 'studio'  and name = 'Studio';
