# App redesign, group G5: account, onboarding and the shared states

Branch `app-design-g5`, stacked on the Foundation commit (`app-design-1`). Page CSS: `command-center/app/(app)/app-pages-g5.css`
(all `g5-` prefixed; it needs only tokens from `globals.css`, so it also loads on the error boundary and first run).

Done: Getting started (desk = progress + the one next step, ruled checklist), Team (claim / invite desk, ruled roster, role legend),
Security (assurance level, enrol desk, authenticators), Billing (unit economics, runway meter, providers as ruled rows, "Pay all"
desk with a plan that turns into blocks on a phone), Command Center (the run is the desk, instruments are ruled sections, stages
are lamps), Error Center (failures as two-line rows), the notifications centre panel, the shared states (`StateBlock`: could not
read, nothing yet, not configured, error boundary, loading skeleton), first-run welcome (rail of steps + one desk).
Unchanged on purpose: the OAuth consent and 404 screens were already built from the public site's system; every consent guard is as it was.

Screenshots (fake backend, `tools/visual-qa`): `*-before-*` sheets are the Foundation commit (light, English); "after" is light,
dark, and ru/uz at 390. Dark and ru/uz "before" were not captured. The fake data came from a local proxy in front of
`fake-supabase.mjs` (operator account, a working team, a failed-read state); nothing in `tools/` changed.
