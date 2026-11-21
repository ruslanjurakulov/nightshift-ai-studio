import { apiError, newRequestId, toResponse } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** Any other /api/v1 path: the API's own 404, in the API's own shape. */
function notFound(): Response {
  return toResponse(apiError(404, "unknown_endpoint", "No such endpoint. See /docs/api."), newRequestId());
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
