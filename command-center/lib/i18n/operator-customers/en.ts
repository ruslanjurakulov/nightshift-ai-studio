/**
 * The Customers page (/{channel}/customers, migration 0138): how many people and workspaces there are, and per workspace the
 * credits it spent, bought and holds. English is the source of truth; ru.ts and uz.ts are typed against it. `{name}` fillers
 * are filled with fmt().
 *
 * Words to keep: "spent" is only what a finished run was charged (a hold is never a spend); "paid" is USD only, and a payment in
 * another currency is said to be counted apart, never converted. The refusal and the subtitle name no role and no one who may
 * open the page.
 */
export const operatorCustomersEn = {
  title: "Customers",
  subtitle: "How many people and workspaces there are, and what each one spent, bought and still holds in credits.",
  forbidden: "This page is not available.",
  notEnabled: "The customers report (migration 0138) is not applied on this deployment yet.",
  readFailed: "The customers report could not be read, so nothing is shown rather than a number that could be wrong. Nothing was changed — try again shortly.",

  figPeople: "People",
  figNewSub: "+{d7} in 7 days · +{d30} in 30 days",
  figWorkspaces: "Workspaces",
  figActive: "Active workspaces (30 days)",
  figActiveSub: "{n} in the last 7 days",
  figSpent: "Credits spent",
  figSpentSub: "{n} in the last 30 days",
  figBought: "Credits bought",
  figBoughtSub: "Credits that came with a payment",
  figGranted: "Credits granted",
  figGrantedSub: "Welcome credits, invite rewards and grants by hand",
  figPaid: "Paid (USD)",
  figPaidSub: "Gross: before refunds, tax and fees",
  figPaidOther: "{n} more payments in another currency are not added here",
  figBalance: "Credits outstanding",
  figBalanceSub: "{n} of them on hold right now",

  dailyTitle: "Last 30 days",
  dailyCaption: "Day by day (UTC): new workspaces and credits spent",
  colDay: "Day",
  colSignups: "New workspaces",
  colSpent: "Credits spent",
  colActive: "Workspaces that spent",

  accountsTitle: "Workspaces",
  searchLabel: "Search",
  searchPlaceholder: "Name, email or ID",
  searchSubmit: "Search",
  searchClear: "Clear",
  sortLabel: "Sort by",
  sort_spent_total: "Spent, all time",
  sort_spent_30d: "Spent, 30 days",
  sort_balance: "Balance",
  sort_paid: "Paid",
  sort_signup: "Sign-up date",
  sort_activity: "Last activity",
  colWorkspace: "Workspace",
  colSignedUp: "Signed up",
  colLastSignIn: "Last sign-in",
  colActivity: "Last activity",
  colSpent30d: "Spent (30 days)",
  colSpentTotal: "Spent (all time)",
  colBalance: "Balance",
  colBought: "Bought",
  colPaid: "Paid",
  colPlan: "Plan",
  colJobs: "Generations",
  cellOnHold: "{n} on hold",
  cellNoAccount: "no credit account",
  cellNever: "never",
  cellNoActivity: "nothing yet",
  cellNoEmail: "no address",
  cellFailed: "{n} failed",
  cellGranted: "+{n} granted",
  cellOtherCurrency: "+{n} in another currency",
  countLine: "Workspaces: {n}",
  pageOf: "Page {page} of {pages}",
  prev: "Previous",
  next: "Next",
  pager: "Pages",
  empty: "No workspaces yet.",
  noMatch: "No workspace matches “{q}”.",
  pastEnd: "There is nothing on this page.",
  firstPage: "Go to the first page",

  rulesTitle: "How the numbers are counted",
  ruleSpent: "Credits spent are what finished runs were charged, less paid downloads that failed and were given back. Credits held when a run starts and returned when it fails are not spent.",
  rulePaid: "Paid counts each completed payment once, in USD only. A payment in another currency is counted apart and never converted into dollars.",
  ruleScope: "The platform’s own workspace is in none of these numbers. An active workspace spent credits at least once in the period.",
};

export type OperatorCustomersDictionary = typeof operatorCustomersEn;
