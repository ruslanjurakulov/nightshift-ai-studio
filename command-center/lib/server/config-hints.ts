import "server-only";
import type { Locale } from "@/lib/i18n/core";
import type { MarketingConfigHints } from "@/lib/marketing-text";
import {
  ALERT_EMAIL_FROM_ENV,
  ALERT_EMAIL_TO_ENV,
  CREDITS_ENFORCE_ENV,
  DODO_PAYMENTS_API_KEY_ENV,
  DODO_PLAN_PREFIX,
  DODO_PRODUCT_PREFIX,
  DODO_TEST_ORG_IDS_ENV,
  GITHUB_SECRETS_REPO_ENV,
  GITHUB_SECRETS_TOKEN_ENV,
  GOOGLE_OAUTH_CLIENT_ID_ENV,
  GOOGLE_OAUTH_CLIENT_SECRET_ENV,
  MARKETING_POSTS_ENV,
  MARKETING_TELEGRAM_CHAT_ENV,
  MEDIA_URL_SECRET_ENV,
  MODEL_KEYS_SWITCH_ENV,
  MODEL_SWITCH_ENV,
  PAYMENTS_PROVIDER_ENV,
  RESEND_API_KEY_ENV,
  SLACK_WEBHOOK_URL_ENV,
  TELEGRAM_CHANNEL_BOT_TOKEN_ENV,
} from "@/lib/server/config-env";

/**
 * The operator's setup sentences that name a configuration variable (lib/server/config-env.ts), in en and ru.
 *
 * Server-only, for the same reason as lib/server/price-config-hints.ts: these sentences were in the shared dictionary, a static
 * chunk every signed-in page loads, a customer's included, and the variables are our deployment's, which no customer can set.
 * The dictionary now says what is not set up, in plain words; a page that has checked isOperator() (or guardOperatorPage())
 * passes the matching sentence here, and the screen shows it instead.
 *
 * No Uzbek entry, on purpose (as in price-config-hints.ts): the owner reads Uzbek, and his copy says "ask the developer" in words
 * instead of naming a variable (tests/owner-plain-copy.test.ts). An Uzbek page keeps the dictionary's sentence.
 */
export interface ConfigHints {
  /** Run now (Agents) and the Create form, when on-demand runs cannot be dispatched. */
  runs: string;
  providers: {
    /** The keys board, when secrets cannot be forwarded. */
    github: string;
    /** The routing panel, when variables cannot be written. */
    routing: string;
    /** The Connect YouTube card, when the OAuth client is missing. */
    ytSetup: string;
    /** The ?yt=not_configured banner after a connect attempt. */
    ytNotConfigured: string;
  };
  channels: {
    /** The new-channel wizard's keys step, when forwarding is off. */
    keys: string;
    /** A channel's YouTube panel when Google refused the OAuth client. */
    needsClient: string;
    /** A channel's YouTube panel when Google sign-in is not configured. */
    oauthNotConfigured: string;
  };
  /** The alert channels page's setup note. */
  alerts: string;
  /** The Credits page's operator tools. */
  credits: { enforcedOff: string; buyNotConfigured: string; testOnlyDodo: string; notConfiguredDodo: string };
  /** The library, when preview links cannot be signed. */
  mediaNoSigning: string;
  /** The Model API keys page while its switch is off. */
  modelKeysOff: string;
  /** The model switches view while its switch is off. */
  modelSwitchOff: string;
  /** The marketing page's own state (off page, poster panel, failure fixes). */
  marketing: MarketingConfigHints & { off: string };
}

const GH = (and: string) => `${GITHUB_SECRETS_TOKEN_ENV} ${and} ${GITHUB_SECRETS_REPO_ENV}`;
const OAUTH = `${GOOGLE_OAUTH_CLIENT_ID_ENV} / ${GOOGLE_OAUTH_CLIENT_SECRET_ENV}`;

const HINTS: Partial<Record<Locale, ConfigHints>> = {
  en: {
    runs: `On-demand runs aren't configured (set ${GH("and")}).`,
    providers: {
      github: `Secret forwarding is not configured. Set ${GH("and")} on the Command Center, then keys typed here reach the bot repository.`,
      routing: `Set ${GH("and")} to change routing.`,
      ytSetup: `Set ${GOOGLE_OAUTH_CLIENT_ID_ENV} and ${GOOGLE_OAUTH_CLIENT_SECRET_ENV} on the Command Center to enable one-click connect.`,
      ytNotConfigured: `YouTube connect isn't configured yet (missing ${OAUTH}).`,
    },
    channels: {
      keys: `Forwarding is off: set ${GH("and")} on the server. Until then you can still create the channel and add the secrets on GitHub by hand.`,
      needsClient: `Google refused the OAuth client behind this connection, so Reconnect will not fix it. Make sure ${GOOGLE_OAUTH_CLIENT_ID_ENV} and ${GOOGLE_OAUTH_CLIENT_SECRET_ENV} on the pipeline (GitHub Actions) are the same values the Command Center uses, then connect again.`,
      oauthNotConfigured: `Google sign-in is not configured on this deployment (${OAUTH}).`,
    },
    alerts: `Set ${SLACK_WEBHOOK_URL_ENV} and ${RESEND_API_KEY_ENV} as GitHub Actions secrets, and ${ALERT_EMAIL_TO_ENV} / ${ALERT_EMAIL_FROM_ENV} as Actions variables, in the bot repository (the same secret forwarding the Providers page uses). Delivery with the real credential happens where that secret env is present — the Actions pipeline; this page confirms configuration and keeps the feed.`,
    credits: {
      enforcedOff: `Credits are not enforced on this deployment yet (${CREDITS_ENFORCE_ENV}): runs start without a hold.`,
      buyNotConfigured: "Buying credits is not configured on this deployment (NEXT_PUBLIC_PADDLE_* — see docs/PADDLE_SETUP.md).",
      testOnlyDodo: `Dodo Payments is in test mode on this deployment: only the test workspaces listed in ${DODO_TEST_ORG_IDS_ENV} can buy, so nothing is on sale here — see docs/DODO_SETUP.md.`,
      notConfiguredDodo: `Selling through Dodo Payments is switched on (${PAYMENTS_PROVIDER_ENV}=dodo) but not configured: set ${DODO_PAYMENTS_API_KEY_ENV} and the ${DODO_PRODUCT_PREFIX}* / ${DODO_PLAN_PREFIX}* product ids — see docs/DODO_SETUP.md.`,
    },
    mediaNoSigning: `Previews are off on this server: ${MEDIA_URL_SECRET_ENV} is not set. Files are stored, but not shown.`,
    modelKeysOff: `The server switch ${MODEL_KEYS_SWITCH_ENV} is not “on”, so this page reads nothing and no key can be checked. Nothing was changed.`,
    modelSwitchOff: `The server switch ${MODEL_SWITCH_ENV} is not “on”, so this view reads nothing and no switch can be changed. Nothing was changed.`,
    marketing: {
      off: `The server switch ${MARKETING_POSTS_ENV} is not “on”, so this page reads nothing and no post can be approved. Nothing was changed.`,
      serverNote: `This is the database switch. The server switch ${MARKETING_POSTS_ENV} and the worker must be on as well; this page cannot see whether the worker is running.`,
      channelUnknown: `unknown: ${MARKETING_TELEGRAM_CHAT_ENV} on this server is missing or is not a valid @name or chat id`,
      needChannel: `The channel is not known to this page, so nothing can be approved here. Check ${MARKETING_TELEGRAM_CHAT_ENV} (a valid @name or chat id) and deploy again.`,
      fix: {
        bad_request: `Telegram refused this post or the channel name. Check the channel name in ${MARKETING_TELEGRAM_CHAT_ENV} and the text; this post will not be tried again.`,
        not_configured: `Telegram refused the bot token. Replace the secret ${TELEGRAM_CHANNEL_BOT_TOKEN_ENV} (never paste it here) and deploy again. Nothing was posted.`,
      },
    },
  },
  ru: {
    runs: `Запуск по требованию не настроен (задайте ${GH("и")}).`,
    providers: {
      github: `Переброс секретов не настроен. Задайте ${GH("и")} в Центре управления — тогда введённые здесь ключи попадут в репозиторий бота.`,
      routing: `Задайте ${GH("и")}, чтобы менять маршрутизацию.`,
      ytSetup: `Задайте ${GOOGLE_OAUTH_CLIENT_ID_ENV} и ${GOOGLE_OAUTH_CLIENT_SECRET_ENV} в Центре управления, чтобы включить подключение в один клик.`,
      ytNotConfigured: `Подключение YouTube ещё не настроено (нет ${OAUTH}).`,
    },
    channels: {
      keys: `Передача выключена: задайте ${GH("и")} на сервере. До этого канал можно создать, а секреты добавить в GitHub вручную.`,
      needsClient: `Google отклонил OAuth-клиент этого подключения, поэтому «Переподключить» не поможет. Убедитесь, что ${GOOGLE_OAUTH_CLIENT_ID_ENV} и ${GOOGLE_OAUTH_CLIENT_SECRET_ENV} у конвейера (GitHub Actions) совпадают со значениями Центра управления, и подключите снова.`,
      oauthNotConfigured: `Вход через Google не настроен на этом развёртывании (${OAUTH}).`,
    },
    alerts: `Задайте ${SLACK_WEBHOOK_URL_ENV} и ${RESEND_API_KEY_ENV} как секреты GitHub Actions, а ${ALERT_EMAIL_TO_ENV} / ${ALERT_EMAIL_FROM_ENV} как переменные Actions в репозитории бота (та же передача секретов, что и на странице «Провайдеры»). Доставка с реальными данными происходит там, где доступна эта секретная среда — в конвейере Actions; эта страница подтверждает настройку и ведёт ленту.`,
    credits: {
      enforcedOff: `Кредиты на этом развертывании ещё не включены (${CREDITS_ENFORCE_ENV}): запуски стартуют без удержания.`,
      buyNotConfigured: "Покупка кредитов на этом развёртывании не настроена (NEXT_PUBLIC_PADDLE_* — см. docs/PADDLE_SETUP.md).",
      testOnlyDodo: `Dodo Payments на этом развёртывании в тестовом режиме: покупать могут только тестовые пространства из ${DODO_TEST_ORG_IDS_ENV}, поэтому здесь ничего не продаётся — см. docs/DODO_SETUP.md.`,
      notConfiguredDodo: `Продажа через Dodo Payments включена (${PAYMENTS_PROVIDER_ENV}=dodo), но не настроена: задайте ${DODO_PAYMENTS_API_KEY_ENV} и id продуктов ${DODO_PRODUCT_PREFIX}* / ${DODO_PLAN_PREFIX}* — см. docs/DODO_SETUP.md.`,
    },
    mediaNoSigning: `Предпросмотр на этом сервере выключен: не задан ${MEDIA_URL_SECRET_ENV}. Файлы сохраняются, но не показываются.`,
    modelKeysOff: `Серверный переключатель ${MODEL_KEYS_SWITCH_ENV} не равен «on», поэтому страница ничего не читает и проверить ключ нельзя. Ничего не изменилось.`,
    modelSwitchOff: `Серверный переключатель ${MODEL_SWITCH_ENV} не равен «on», поэтому страница ничего не читает и изменить переключатель нельзя. Ничего не изменилось.`,
    marketing: {
      off: `Серверный переключатель ${MARKETING_POSTS_ENV} не равен «on», поэтому страница ничего не читает и одобрить пост нельзя. Ничего не изменилось.`,
      serverNote: `Это переключатель в базе данных. Серверный переключатель ${MARKETING_POSTS_ENV} и воркер тоже должны быть включены; эта страница не видит, работает ли воркер.`,
      channelUnknown: `неизвестен: ${MARKETING_TELEGRAM_CHAT_ENV} на этом сервере не задан или не является корректным @именем или номером чата`,
      needChannel: `Странице неизвестен канал, поэтому одобрить здесь ничего нельзя. Проверьте ${MARKETING_TELEGRAM_CHAT_ENV} (корректное @имя или номер чата) и разверните заново.`,
      fix: {
        bad_request: `Telegram отклонил этот пост или имя канала. Проверьте имя канала в ${MARKETING_TELEGRAM_CHAT_ENV} и текст; этот пост больше пробовать не будут.`,
        not_configured: `Telegram отклонил токен бота. Замените секрет ${TELEGRAM_CHANNEL_BOT_TOKEN_ENV} (сюда его никогда не вставляйте) и разверните заново. Ничего не опубликовано.`,
      },
    },
  },
};

/** The operator's sentences in `locale`, or null where the dictionary's own sentence is the one to show (Uzbek). */
export function configHints(locale: Locale): ConfigHints | null {
  return HINTS[locale] ?? null;
}
