def patch(p, pairs):
    s = open(p, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (p, old[:70])
        s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8', newline='\n').write(s)


patch('lib/workflows-operations.ts', [
    ('''export async function startRun(db: WorkflowDb, workflowId: string, input: RunInput): Promise<CreativeResult> {''',
     '''export async function startRun(
  db: WorkflowDb,
  workflowId: string,
  input: RunInput,
  headers?: Record<string, string>,
): Promise<CreativeResult> {'''),
    ('''    p_max_credits: input.maxCredits,
  });
  if (error) return mapWorkflowError(error);
  const run = coerceRun(data);
  if (!run) return fail(502, "failed");
  const replay''', '''    p_max_credits: input.maxCredits,
  }, headers);
  if (error) return mapWorkflowError(error);
  const run = coerceRun(data);
  if (!run) return fail(502, "failed");
  const replay'''),
    ('''async function runCall(db: WorkflowDb, fn: "advance_workflow_run" | "cancel_workflow_run", id: string): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const { data, error } = await db.rpc(fn, { p_run: id });''',
     '''async function runCall(
  db: WorkflowDb,
  fn: "advance_workflow_run" | "cancel_workflow_run",
  id: string,
  headers?: Record<string, string>,
): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const { data, error } = await db.rpc(fn, { p_run: id }, headers);'''),
    ('''export function advanceRun(db: WorkflowDb, id: string): Promise<CreativeResult> {
  return runCall(db, "advance_workflow_run", id);''',
     '''export function advanceRun(db: WorkflowDb, id: string, headers?: Record<string, string>): Promise<CreativeResult> {
  return runCall(db, "advance_workflow_run", id, headers);'''),
])

patch('app/api/workflows/[id]/run/route.ts', [
    ('''import { geoRefusalAny } from "@/lib/server/geo";''',
     '''import { geoRefusalAny } from "@/lib/server/geo";
import { geoClaimHeaders } from "@/lib/server/geo-claim";'''),
    ('''  if (Object.keys(BLOCKED_COUNTRIES).length > 0 && isUuid(id)) {''',
     '''  let claim: Record<string, string> | undefined;
  if (Object.keys(BLOCKED_COUNTRIES).length > 0 && isUuid(id)) {'''),
    ('''    const blocked = geoRefusalAny(wf.steps.map((s) => s.model), request.headers);
    if (blocked) return NextResponse.json(blocked.body, { status: blocked.status });
  }
  const out = await startRun(session.db, id, parsed.input);''',
     '''    const blocked = geoRefusalAny(wf.steps.map((s) => s.model), request.headers);
    if (blocked) return NextResponse.json(blocked.body, { status: blocked.status });
    // 0208: the first step's job is created inside start_workflow_run, and the database refuses one on a model with a country list
    // unless this server vouches for the country (sent only when a step names such a model).
    claim = geoClaimHeaders(wf.steps.map((s) => s.model), request.headers, session.userId);
  }
  const out = await startRun(session.db, id, parsed.input, claim);'''),
])

patch('app/api/workflows/runs/[id]/advance/route.ts', [
    ('''import { requireSameOrigin } from "@/lib/server/same-origin";''',
     '''import { requireSameOrigin } from "@/lib/server/same-origin";
import { geoClaimHeaders } from "@/lib/server/geo-claim";
import { geoRefusalAny } from "@/lib/server/geo";
import { blockedCountriesOf } from "@/lib/geo/blocked";
import { isUuid } from "@/lib/creative/operations";'''),
    ('''export const POST = requireSameOrigin(async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  const out = await advanceRun(session.db, id);''',
     '''export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  // 0208: a later step's job is created here, and the database refuses one on a model with a country list unless this server
  // vouches for the country. Only a run with such a step is read for it, and only then is the country sent. A run that cannot be
  // read gets no claim: the database then refuses such a step, never runs it unchecked.
  let claim: Record<string, string> | undefined;
  if (isUuid(id)) {
    const read = await session.db.readRun(id);
    const steps = (read.data as { steps?: Array<{ model?: unknown }> } | null)?.steps ?? [];
    const models = steps.map((s) => (typeof s.model === "string" ? s.model : null)).filter((m): m is string => m !== null);
    if (models.some((m) => blockedCountriesOf(m).length > 0)) {
      // A run started elsewhere and carried on from a country its steps' models are not offered in, or an allow-list model with no
      // known country: refused before anything is held, as at Run now.
      const blocked = geoRefusalAny(models, request.headers);
      if (blocked) return NextResponse.json(blocked.body, { status: blocked.status });
      claim = geoClaimHeaders(models, request.headers, session.userId);
    }
  }
  const out = await advanceRun(session.db, id, claim);'''),
])
print('ok')
