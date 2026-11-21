import type { PaymeDictionary } from "./en";

/** Покупка кредитов через Payme (Uzcard/Humo). Источник — ./en.ts. */
export const paymeRu: PaymeDictionary = {
  title: "Оплата картой Uzcard или Humo",
  lead: "Пополнение через Payme. Вы платите в сумах на странице Payme, данные карты получает только Payme. Кредиты начисляются, когда Payme подтвердит оплату.",
  testMode: "Тестовый режим Payme · без реальных списаний",
  credits: "{credits} кредитов",
  buy: "Оплатить {price} через Payme",
  opening: "Открываем Payme…",
  returned: "Вы вернулись из Payme. Если оплата прошла, кредиты появятся здесь в течение минуты.",
  failed: "Не удалось открыть Payme. Попробуйте ещё раз.",
  tooMany: "Сегодня открыто слишком много оплат. Попробуйте завтра.",
  notOnSale: "Этот пакет сейчас не продаётся через Payme.",
};
