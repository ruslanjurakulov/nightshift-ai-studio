import "server-only";
import { resolvePaddleApi, type PaddleApiConfig } from "@/lib/paddle";

/**
 * Paddle's server API, for API balance top-ups only: a custom amount needs a
 * transaction with a non-catalog price, which only a server holding the
 * Paddle API key can create. The key is read here and sent only to Paddle —
 * never logged, never returned. Errors carry the HTTP status alone.
 */
export const paddleApi: PaddleApiConfig | null = resolvePaddleApi({
  PADDLE_API_KEY: process.env.PADDLE_API_KEY,
  PADDLE_API_TOPUP_PRODUCT_ID: process.env.PADDLE_API_TOPUP_PRODUCT_ID,
  NEXT_PUBLIC_PADDLE_ENV: process.env.NEXT_PUBLIC_PADDLE_ENV,
});

async function paddle(cfg: PaddleApiConfig, path: string, init: RequestInit): Promise<{ status: number; json: unknown }> {
  const res = await fetch(cfg.baseUrl + path, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    cache: "no-store",
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export async function createTopupTransaction(
  cfg: PaddleApiConfig,
  body: Record<string, unknown>,
): Promise<{ ok: true; id: string } | { ok: false; status: number }> {
  const { status, json } = await paddle(cfg, "/transactions", { method: "POST", body: JSON.stringify(body) });
  const id = (json as { data?: { id?: unknown } } | null)?.data?.id;
  if (status >= 200 && status < 300 && typeof id === "string" && /^txn_[a-z0-9]{10,40}$/.test(id)) return { ok: true, id };
  return { ok: false, status };
}

/** A short-lived link to the transaction's invoice PDF, or null. */
export async function transactionInvoiceUrl(cfg: PaddleApiConfig, transactionId: string): Promise<string | null> {
  if (!/^txn_[a-z0-9]{10,40}$/.test(transactionId)) return null;
  const { status, json } = await paddle(cfg, `/transactions/${transactionId}/invoice`, { method: "GET" });
  const url = (json as { data?: { url?: unknown } } | null)?.data?.url;
  return status === 200 && typeof url === "string" && url.startsWith("https://") ? url : null;
}
