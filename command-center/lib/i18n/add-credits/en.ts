/**
 * The Credits page's "Add credits" sheet (a typed USD amount next to the packs, through Dodo Payments) and its purchase history
 * (migration 0157). English is the source of truth; ru.ts and uz.ts are typed against it. `{name}` fillers are filled with fmt().
 *
 * Words to keep: credits, never a "wallet" or a dollar balance (what is bought is credits, not stored money). "Total" is the
 * price before any tax: Dodo, the Merchant of Record, computes tax and shows it on its own page before anything is paid.
 * Counts are written so that no language needs a plural form ("Credits to add" + a number).
 */
export const addCreditsEn = {
  title: "Add credits",
  tabsLabel: "How to add credits",
  tabOnce: "One-time purchase",
  tabAuto: "Auto recharge",
  autoChip: "Not available yet",
  autoBody:
    "Auto recharge isn't available yet: charging a saved card automatically needs our payment provider's written approval first. Add credits any time with a one-time purchase.",
  customLabel: "How many credits?",
  sliderLabel: "Credits",
  bounds: "Minimum {min} credits. One purchase is up to {max} credits ({maxPrice}).",
  creditsToAdd: "Credits to add",
  perCredit: "Price per credit",
  total: "Total",
  totalUnknown: "—",
  taxNote: "Price in US dollars. Any tax is calculated by Dodo Payments and shown on the checkout page before you pay.",
  /** The volume rates (lib/topup.ts TOPUP); the more credits, the lower the price per credit. */
  tiers: "1,000–4,999 credits: $0.010 each · 5,000–19,999: $0.009 each · 20,000 and more: $0.008 each.",
  contactTitle: "More than {max} credits?",
  contactBody: "One purchase is at most {maxPrice}. Write to us and we'll arrange a larger purchase.",
  contactLink: "Contact us",
  /** Dodo's docs: "When amount is provided, the checkout uses that exact amount"; said in case its page ever lets it be edited. */
  keepAmount: "Dodo's page should show exactly this amount. Don't change it there: a payment of a different amount isn't credited and has to be refunded.",
  invalid: {
    empty: "Enter a number of credits.",
    format: "Enter a whole number of credits, like 5000.",
    below: "The minimum is {min} credits.",
  },
  payWith: "Payment: card or another method, entered on Dodo's secure checkout page. Your card details never reach us.",
  submit: "Add credits",
  processing: "Processing…",
  tooMany: "The checkout was opened too many times today. Try again tomorrow, or contact support.",
  notOnSale: "This isn't on sale right now. Refresh the page and try again.",
  history: {
    title: "Purchase history",
    lead: "Payments that added credits to this workspace. Invoices are issued by Dodo Payments, our Merchant of Record.",
    colDate: "Date",
    colItem: "Item",
    colCredits: "Credits",
    colAmount: "Amount",
    colStatus: "Status",
    colPayment: "Payment ID",
    colInvoice: "Invoice",
    itemPack: "{name} pack",
    itemAmount: "Custom amount",
    itemPlan: "Plan payment",
    unknown: "—",
    status: {
      paid: "Paid",
      partly_refunded: "Partly refunded",
      refunded: "Refunded",
      refund_recorded: "Refund recorded",
      chargeback: "Charged back",
    },
    amountNote: "Amounts include any tax Dodo charged.",
    empty: "No purchases yet. Credits you buy appear here with their invoice.",
    readFailed: "Couldn't read the purchase history. Refresh the page to try again.",
    notMigrated: "The purchase history needs database migration 0157. Buying still works; ask your administrator to apply it.",
    limit: "Showing the latest 100 payments.",
    download: "Download",
    preparing: "Preparing…",
    invoiceError: {
      rate_limited: "Dodo allows only a few invoice downloads a minute. Try again in a minute.",
      not_found: "Dodo has no invoice for this payment yet. Try again later, or use the link in your payment receipt.",
      failed: "Couldn't get the invoice. Try again, or use the link in your payment receipt.",
      unavailable: "This invoice can't be opened from this workspace. Refresh the page; if it stays, use the link in your payment receipt.",
      busy: "Too many invoice downloads in a minute. Wait a minute and try again.",
    },
  },
};

export type AddCreditsDictionary = typeof addCreditsEn;
