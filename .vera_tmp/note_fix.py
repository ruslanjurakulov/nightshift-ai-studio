import json
p = 'schemas/model_registry.json'
s = open(p, encoding='utf-8').read()
OLD = ("Gemini API Additional Terms (effective 2026-03-23): 'You may only access the Services (or make API Clients available to "
       "users) within an available region' (aistudio.google.com/docs/available-regions, read 2026-11-21). blocked_countries carries "
       "every ISO code not on that list; terms_review_required added 2026-11-21 because a country list needs a terms gate until the "
       "database checks the country (0142). This row is past its shutdown date, so nothing on sale changes.")
NEW = ("Gemini API Additional Terms (eff. 2026-03-23): use only 'within an available region' (aistudio.google.com/docs/available-regions, "
       "read 2026-11-21). blocked_countries = every ISO code not listed; this gate added 2026-11-21: a country list needs "
       "a terms gate (0142). Past shutdown.")
assert len(NEW) <= 300, len(NEW)
o, n = json.dumps(OLD, ensure_ascii=False), json.dumps(NEW, ensure_ascii=False)
assert s.count(o) == 3, s.count(o)
s = s.replace(o, n)
json.loads(s)
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok', len(NEW))
