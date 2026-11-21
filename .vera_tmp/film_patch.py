def patch(p, pairs):
    s = open(p, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (p, old[:70])
        s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8', newline='\n').write(s)


patch('lib/server/films.ts', [
    ('import { parseJsonCapped } from "@/lib/server/json-body";',
     'import { parseJsonCapped } from "@/lib/server/json-body";\nimport { blockedCountriesOf } from "@/lib/geo/blocked";'),
])

GUARD = '''  // A model sold by region cannot run in Film Studio (filmGeoGatedModels): refused before the database prices or holds anything.
  const gated = await filmGeoGatedModels(gate.supabase, filmId);
  if (gated === null) return filmFail("failed", 502);
  if (gated.length > 0) {
    return filmFail("model_not_offered", 422, { detail: `${gated.join(", ")} is sold by region and cannot run in Film Studio yet` });
  }
'''
patch('app/api/films/[id]/quote/route.ts', [
    ('import { NO_STORE, filmFail, filmGateFor, filmRate, filmRefusal, readFilmBody } from "@/lib/server/films";',
     'import { NO_STORE, filmFail, filmGateFor, filmGeoGatedModels, filmRate, filmRefusal, readFilmBody } from "@/lib/server/films";'),
    ('''  const { data, error } = await gate.supabase.rpc("quote_film", { p_film: filmId, p_version: version });''',
     GUARD + '''  const { data, error } = await gate.supabase.rpc("quote_film", { p_film: filmId, p_version: version });'''),
])
patch('app/api/films/[id]/start/route.ts', [
    ('import { NO_STORE, filmFail, filmGateFor, filmRate, filmRefusal, readFilmBody } from "@/lib/server/films";',
     'import { NO_STORE, filmFail, filmGateFor, filmGeoGatedModels, filmRate, filmRefusal, readFilmBody } from "@/lib/server/films";'),
    ('''  const { data, error } = await gate.supabase.rpc("start_film", {''',
     GUARD + '''  const { data, error } = await gate.supabase.rpc("start_film", {'''),
])

# Studio jobs route: attach the claim
patch('app/api/creative/jobs/route.ts', [
    ('import { blockedModelsHere, geoRefusal } from "@/lib/server/geo";',
     'import { blockedModelsHere, geoRefusal } from "@/lib/server/geo";\nimport { geoClaimHeaders } from "@/lib/server/geo-claim";'),
    ('''  const out = await createGeneration(session.db, input);''',
     '''  // 0208: the database refuses a job on a model with a country list unless this server vouches for the country (sent only then).
  const out = await createGeneration(session.db, input, geoClaimHeaders([input.model], request.headers, session.userId));'''),
    (''' * held or queued (docs/GEO_BLOCK.md). An unknown country is allowed (and logged).''',
     ''' * held or queued (docs/GEO_BLOCK.md). An unknown country is allowed (and logged), except for a model sold only inside listed
 * regions (Google's): 451 `country_unverified`. For such a model the call carries a server-signed country (lib/server/geo-claim.ts),
 * without which the database refuses the job itself (0208).'''),
])

# Region edit run: explicit refusal and the claim
patch('app/api/region-edit/run/route.ts', [
    ('import { parseJsonCapped } from "@/lib/server/json-body";',
     'import { parseJsonCapped } from "@/lib/server/json-body";\nimport { geoRefusal } from "@/lib/server/geo";\nimport { geoClaimHeaders } from "@/lib/server/geo-claim";'),
])
s = open('app/api/region-edit/run/route.ts', encoding='utf-8').read()
i = s.index('  const out = await createGeneration(session.db, {')
s = s[:i] + '''  // The picker already leaves out a model this country forbids (loadStudioModels); said again here, by name, so a refusal is the
  // region's words and not "not sellable", and the call carries 0208's server-signed country for a model with a country list.
  const blocked = geoRefusal(picked.model.id, request.headers);
  if (blocked) return NextResponse.json(blocked.body, { status: blocked.status });
''' + s[i:]
j = s.index('  const out = await createGeneration(session.db, {')
k = s.index('});', j)
seg = s[j:k + 3]
assert seg.count('});') == 1, seg
s = s[:j] + seg[:-3] + '}, geoClaimHeaders([picked.model.id], request.headers, session.userId));' + s[k + 3:]
open('app/api/region-edit/run/route.ts', 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
