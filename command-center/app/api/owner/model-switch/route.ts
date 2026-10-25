import { requireSameOrigin } from "@/lib/server/same-origin";
import { handleOwnerPost } from "@/lib/server/owner-rpc";
import { modelSwitchOn } from "@/lib/server/model-switch";
import { parseModelSwitch } from "@/lib/model-switch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner's model switches (migration 0124, docs/MODEL_SWITCH.md): count what a switch-off touches (owner_model_switch_preview), switch a
 * model or a provider OFF or ON (owner_set_model_switch), dismiss the optional alert (owner_model_alert_dismiss).
 *
 * There is no action that switches everything, schedules a switch, re-routes a job or turns a switch on by itself. The database stops the
 * jobs not yet sent, releases their credits and writes the audit in the same transaction; this route only carries the request.
 *
 * Behind NIGHTSHIFT_MODEL_SWITCH (a same-origin POST gets 404 while it is not exactly `on`). The same checks, in the same order, as
 * /api/owner/*: same-origin, the switch, signed in, owner/admin, the second factor, a small JSON body, then ONE database function called as
 * the signed-in user (lib/server/owner-rpc.ts). The database itself refuses anyone who is not the platform OWNER.
 */
export const POST = requireSameOrigin(async (request: Request) => handleOwnerPost(request, parseModelSwitch, modelSwitchOn));
