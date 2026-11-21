p = 'lib/server/geo.ts'
s = open(p, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:80]
    s = s.replace(old, new, 1)


rep('import { BLOCKED_COUNTRIES, blockedCountriesOf, withoutBlocked, type BlockedMap } from "@/lib/geo/blocked";',
    'import { BLOCKED_COUNTRIES, blockedCountriesOf, refusesUnknownCountry, withoutBlocked, type BlockedMap } from "@/lib/geo/blocked";')
rep('''): { status: 451; body: { error: "country_blocked" } } | null {
  const list = blockedCountriesOf(model, map);
  if (list.length === 0) return null;
  const reading = readCountry(h, load);
  if (reading.country === null) {
    if (unknownRefuses(reading.why, strict)) {''', '''): GeoRefusal | null {
  const list = blockedCountriesOf(model, map);
  if (list.length === 0) return null;
  const reading = readCountry(h, load);
  if (reading.country === null) {
    // An allow-list vendor (Google): its terms allow use only inside a listed region, so "we could not tell" is refused for every
    // reason, a visitor's not_in_table included, and the answer names the remedy (a connection whose country can be read).
    if (refusesUnknownCountry(model)) {
      console.warn("geo: the country is unknown (%s) for a model sold only in listed regions; refused", reading.why);
      return { status: 451, body: { error: "country_unverified" } };
    }
    if (unknownRefuses(reading.why, strict)) {''')
rep('''): { status: 451; body: { error: "country_blocked" } } | null {
  for (const m of new Set(models)) {''', '''): GeoRefusal | null {
  for (const m of new Set(models)) {''')
rep('''export function geoRefusal(''', '''/** country_blocked: the country is known and the model is not offered there. country_unverified: an allow-list model, no known country. */
export type GeoRefusal = { status: 451; body: { error: "country_blocked" | "country_unverified" } };

export function geoRefusal(''')
rep('''  if (reading.country === null) {
    if (!unknownRefuses(reading.why, strict)) return null;
    ids = new Set(listed);
  } else {''', '''  if (reading.country === null) {
    // A broken setup forbids every listed model; otherwise only the allow-list ones (their terms need a known, listed country).
    ids = new Set(unknownRefuses(reading.why, strict) ? listed : listed.filter(refusesUnknownCountry));
  } else {''')
rep('''    console.warn("geo: the country is unknown (%s); no model is hidden", reading.why);''',
    '''    console.warn("geo: the country is unknown (%s); only models sold in listed regions are hidden", reading.why);''')
rep('''  } catch {
    return GEO_STRICT ? withoutListed(models, BLOCKED_COUNTRIES) : models;
  }''', '''  } catch {
    return GEO_STRICT ? withoutListed(models, BLOCKED_COUNTRIES) : models.filter((m) => !refusesUnknownCountry(m.id));
  }''')
rep(''' * "Unknown" is never guessed. What happens next depends on why''', ''' * "Unknown" is never guessed. For a model whose vendor allows use only inside listed regions (REFUSE_UNKNOWN_COUNTRY in lib/geo/blocked,
 * Google's), an unknown country is refused and hidden whatever the reason (451 country_unverified). For every other listed model,
 * what happens next depends on why''')
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print("ok")
