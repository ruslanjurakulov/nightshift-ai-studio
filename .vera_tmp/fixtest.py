p = 'tests/geo-google.test.ts'
s = open(p, encoding='utf-8').read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:70], s.count(old))
    s = s.replace(old, new)


rep('''const TABLE = parseGeoTable(new Uint8Array(gunzipSync(readFileSync(join(__dirname, "..", "data", "geoip", "country.bin.gz")))));
// Addresses the shipped table (DB-IP, 2026-11) places in Russia, Belarus and Uzbekistan (asserted below), and one it has no country for.
const RU = "77.88.8.8";
const BY = "93.84.0.1";
const UZ = "84.54.64.1";
const NOWHERE = "11.0.0.1";''', '''const TABLE = parseGeoTable(new Uint8Array(gunzipSync(readFileSync(join(__dirname, "..", "data", "geoip", "country.bin.gz")))));
// The small fixture table (tests/fixtures) has no country for 11.0.0.1: DB-IP's real one covers every public address, so a visitor's
// "not_in_table" is read from the fixture.
const FIXTURE = parseGeoTable(new Uint8Array(readFileSync(join(__dirname, "fixtures", "geoip-fixture.bin"))));
const fixture = () => FIXTURE;
// Addresses the shipped table (DB-IP, 2026-11) places in Russia, Belarus and Uzbekistan (asserted below).
const RU = "77.88.8.8";
const BY = "93.84.0.1";
const UZ = "84.54.64.1";
const NOWHERE = "11.0.0.1";''')
rep('''    expect([lookupCountry(TABLE, RU), lookupCountry(TABLE, BY), lookupCountry(TABLE, UZ), lookupCountry(TABLE, NOWHERE)]).toEqual(["RU", "BY", "UZ", null]);''',
    '''    expect([lookupCountry(TABLE, RU), lookupCountry(TABLE, BY), lookupCountry(TABLE, UZ), lookupCountry(FIXTURE, NOWHERE)]).toEqual(["RU", "BY", "UZ", null]);''')
rep('''        const r = geoRefusal(m, new Headers(hd), BLOCKED_COUNTRIES, undefined, false);''',
    '''        const r = geoRefusal(m, new Headers(hd), BLOCKED_COUNTRIES, fixture, false);''')
rep('''    const shown = hideBlockedModels(models, new Headers(ip(NOWHERE)), BLOCKED_COUNTRIES, undefined, false).map((m) => m.id);''',
    '''    const shown = hideBlockedModels(models, new Headers(ip(NOWHERE)), BLOCKED_COUNTRIES, fixture, false).map((m) => m.id);''')
rep('''    const forbidden = blockedModelsHere(new Headers(ip(NOWHERE)), BLOCKED_COUNTRIES, undefined, false);''',
    '''    const forbidden = blockedModelsHere(new Headers(ip(NOWHERE)), BLOCKED_COUNTRIES, fixture, false);''')
# routes: unknown = no trusted address at all (outside production that is "unknown", not "broken": still refused for Google)
rep('''      for (const res of [await quote(m, ip(NOWHERE)), await create(m, ip(NOWHERE))]) {''',
    '''      for (const res of [await quote(m, {}), await create(m, {})]) {''')
rep('''      for (const a of [RU, BY, NOWHERE]) {
        for (const res of [await wfQuote(ip(a)), await wfRun(ip(a))]) expect([m, a, res.status]).toEqual([m, a, 451]);
      }''', '''      for (const hd of [ip(RU), ip(BY), {}]) {
        for (const res of [await wfQuote(hd), await wfRun(hd)]) expect([m, hd, res.status]).toEqual([m, hd, 451]);
      }''')
rep('''    expect(geoClaimHeaders(["gemini-3.1-flash-image"], new Headers(ip(NOWHERE)), USER)).toBeUndefined();''',
    '''    expect(geoClaimHeaders(["gemini-3.1-flash-image"], new Headers(ip(NOWHERE)), USER, { load: fixture })).toBeUndefined();
    expect(geoClaimHeaders(["gemini-3.1-flash-image"], new Headers(), USER)).toBeUndefined();''')
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
