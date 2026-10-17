/** Real `Response` objects for tests that mock fetch: status, headers and JSON body exactly as the browser would give them. */
export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** What a followed redirect looks like to the caller: 200, `redirected`, an HTML sign-in page. */
export function redirectedToLogin(): Response {
  const res = new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(res, "redirected", { value: true });
  Object.defineProperty(res, "url", { value: "https://nightshift.test/login" });
  return res;
}
