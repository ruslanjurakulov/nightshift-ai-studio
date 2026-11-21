import re


def patch(p, pairs):
    s = open(p, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (p, old[:70])
        s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8', newline='\n').write(s)


IFACE_OLD = '  rpc(fn: string, args: Record<string, unknown>): Promise<DbAnswer>;'
IFACE_NEW = ('  /** `headers`: extra request headers for this one call (0208\'s server-signed country, lib/server/geo-claim.ts). */\n'
             '  rpc(fn: string, args: Record<string, unknown>, headers?: Record<string, string>): Promise<DbAnswer>;')
patch('lib/creative/operations.ts', [(IFACE_OLD, IFACE_NEW)])
patch('lib/workflows-operations.ts', [(IFACE_OLD, IFACE_NEW)])

DOOR_OLD = '''    async rpc(fn, args) {
      const { data, error } = await supabase.rpc(fn, args);
      return { data, error };
    },'''
DOOR_NEW = '''    async rpc(fn, args, headers) {
      let call = supabase.rpc(fn, args);
      for (const [k, v] of Object.entries(headers ?? {})) call = call.setHeader(k, v);
      const { data, error } = await call;
      return { data, error };
    },'''
patch('lib/server/creative.ts', [
    (DOOR_OLD, DOOR_NEW),
    ('''  { ok: true; db: CreativeDb; defaultOrg: string | null } | { ok: false; result: CreativeResult }
> {
  const user = await getUser();
  if (!user) return { ok: false, result: { status: 401, body: { error: "unauthorized" } } };
  const supabase = await createClient();
  if (!supabase) return { ok: false, result: { status: 503, body: { error: "not_configured" } } };
  const org = await getOrgContext();
  return { ok: true, db: creativeDb(supabase), defaultOrg: org.current?.id ?? null };''',
     '''  { ok: true; db: CreativeDb; defaultOrg: string | null; userId: string } | { ok: false; result: CreativeResult }
> {
  const user = await getUser();
  if (!user) return { ok: false, result: { status: 401, body: { error: "unauthorized" } } };
  const supabase = await createClient();
  if (!supabase) return { ok: false, result: { status: 503, body: { error: "not_configured" } } };
  const org = await getOrgContext();
  return { ok: true, db: creativeDb(supabase), defaultOrg: org.current?.id ?? null, userId: user.id };'''),
])
patch('lib/server/workflows.ts', [
    (DOOR_OLD, DOOR_NEW),
    ('''  { ok: true; db: WorkflowDb; defaultOrg: string | null } | { ok: false; result: CreativeResult }
> {
  const user = await getUser();
  if (!user) return { ok: false, result: { status: 401, body: { error: "unauthorized" } } };
  const supabase = await createClient();
  if (!supabase) return { ok: false, result: { status: 503, body: { error: "not_configured" } } };
  const org = await getOrgContext();
  return { ok: true, db: workflowDb(supabase), defaultOrg: org.current?.id ?? null };''',
     '''  { ok: true; db: WorkflowDb; defaultOrg: string | null; userId: string } | { ok: false; result: CreativeResult }
> {
  const user = await getUser();
  if (!user) return { ok: false, result: { status: 401, body: { error: "unauthorized" } } };
  const supabase = await createClient();
  if (!supabase) return { ok: false, result: { status: 503, body: { error: "not_configured" } } };
  const org = await getOrgContext();
  return { ok: true, db: workflowDb(supabase), defaultOrg: org.current?.id ?? null, userId: user.id };'''),
])

# createGeneration forwards the headers
patch('lib/creative/operations.ts', [
    ('''export async function createGeneration(db: CreativeDb, input: GenerationInput): Promise<CreativeResult> {
  if (input.maxCredits === null) return fail(400, "confirm_price");
  const { data, error } = await db.rpc("create_creative_job", {''',
     '''export async function createGeneration(
  db: CreativeDb,
  input: GenerationInput,
  headers?: Record<string, string>,
): Promise<CreativeResult> {
  if (input.maxCredits === null) return fail(400, "confirm_price");
  const { data, error } = await db.rpc("create_creative_job", {'''),
    ('''    p_idempotency_key: input.idempotencyKey,
    p_max_credits: input.maxCredits,
  });
  if (error) return degraded(input.capability, mapCreativeError(error));
  const out = obj(data);
  const job = obj(out?.job);''',
     '''    p_idempotency_key: input.idempotencyKey,
    p_max_credits: input.maxCredits,
  }, headers);
  if (error) return degraded(input.capability, mapCreativeError(error));
  const out = obj(data);
  const job = obj(out?.job);'''),
])
print('ok')
