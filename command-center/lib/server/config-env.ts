import "server-only";

/**
 * The names of our deployment's own configuration: the server's GitHub forwarding, Google sign-in, alert delivery, credits,
 * payments, media signing, and the operator features' server switches. Server-only: they are our infrastructure's names, which
 * no customer can set and the site must not show. They sat in the shared dictionary (lib/i18n/{en,ru,uz}.ts), a static chunk
 * every signed-in page loads, a customer's included; the dictionary now says only that a thing is not set up, and
 * lib/server/config-hints.ts names them to the operator. scripts/vendor-bundle-check.mjs reads every `export const` string here
 * and fails a build whose static chunks carry one, so a name added here is guarded without a second list.
 *
 * Names, never values: nothing here reads process.env. Each is the name its reader uses (the module named beside it); a test
 * (tests/security-config-env-names.test.tsx) checks that some server module or pipeline file still reads each one.
 *
 * Not here, on purpose: NEXT_PUBLIC_* names. Next.js puts those in the browser by design (the Paddle client reads
 * NEXT_PUBLIC_PADDLE_* there), so a bundle check on them could never pass; the dictionary still stops naming them.
 */

/** lib/server/github-secrets.ts: the token and repository the Command Center forwards secrets and dispatches runs with. */
export const GITHUB_SECRETS_TOKEN_ENV = "GITHUB_SECRETS_TOKEN";
export const GITHUB_SECRETS_REPO_ENV = "GITHUB_SECRETS_REPO";

/** lib/server/google-oauth.ts and modules/channel_tokens.py: the Google OAuth client behind Connect YouTube. */
export const GOOGLE_OAUTH_CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
export const GOOGLE_OAUTH_CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";

/** lib/server/alerts.ts, modules/notifier.py, modules/email_notify.py: where the operator's alerts are delivered. */
export const SLACK_WEBHOOK_URL_ENV = "SLACK_WEBHOOK_URL";
export const RESEND_API_KEY_ENV = "RESEND_API_KEY";
export const ALERT_EMAIL_TO_ENV = "ALERT_EMAIL_TO";
export const ALERT_EMAIL_FROM_ENV = "ALERT_EMAIL_FROM";

/** lib/server/credits.ts and modules/credits.py: whether runs are paid with credits on this deployment. */
export const CREDITS_ENFORCE_ENV = "NIGHTSHIFT_CREDITS_ENFORCE";

/** lib/server/payments.ts and lib/server/dodo-api.ts: which seller sells credits, and Dodo Payments' settings. */
export const PAYMENTS_PROVIDER_ENV = "PAYMENTS_PROVIDER";
export const DODO_PAYMENTS_API_KEY_ENV = "DODO_PAYMENTS_API_KEY";
export const DODO_TEST_ORG_IDS_ENV = "DODO_TEST_ORG_IDS";
/** Prefixes: one variable per pack (DODO_PRODUCT_<PACK>) and per plan (DODO_PLAN_<PLAN>). */
export const DODO_PRODUCT_PREFIX = "DODO_PRODUCT_";
export const DODO_PLAN_PREFIX = "DODO_PLAN_";

/** lib/server/paddle-api.ts: the server-side Paddle key behind the customer portal. */
export const PADDLE_API_KEY_ENV = "PADDLE_API_KEY";

/** lib/server/media.ts: the key that signs preview links of stored files. */
export const MEDIA_URL_SECRET_ENV = "MEDIA_URL_SECRET";

/** The operator features' server switches (lib/server/model-keys.ts, model-switch.ts, marketing.ts), each exactly `on`. */
export const MODEL_KEYS_SWITCH_ENV = "NIGHTSHIFT_MODEL_KEYS";
export const MODEL_SWITCH_ENV = "NIGHTSHIFT_MODEL_SWITCH";
export const MARKETING_POSTS_ENV = "NIGHTSHIFT_MARKETING_POSTS";

/** lib/server/marketing.ts and tools/marketing_worker.py: the public Telegram channel, and the bot that posts to it. */
export const MARKETING_TELEGRAM_CHAT_ENV = "MARKETING_TELEGRAM_CHAT";
export const TELEGRAM_CHANNEL_BOT_TOKEN_ENV = "TELEGRAM_CHANNEL_BOT_TOKEN";
