/**
 * The origin the API reference and its OpenAPI document are written against:
 * this deployment's APP_ORIGIN (compose sets it from DOMAIN), else the
 * production domain. Server-side env only, never the request's Host header.
 */
export function docsOrigin(): string {
  try {
    const u = new URL(process.env.APP_ORIGIN?.trim() || "https://nightshift-ai.studio");
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "https://nightshift-ai.studio";
  } catch {
    return "https://nightshift-ai.studio";
  }
}
