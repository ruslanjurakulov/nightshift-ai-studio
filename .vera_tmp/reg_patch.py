import json
import re

ts = open('command-center/lib/geo/blocked.ts', encoding='utf-8').read()


def arr(name):
    m = re.search(r'export const ' + name + r'[^=]*=\s*\[(.*?)\];', ts, re.S)
    return re.findall(r'"([A-Za-z0-9.\-]+)"', m.group(1))


iso = arr('ISO_3166_ALPHA2')
avail = arr('GOOGLE_AVAILABLE_REGIONS')
models = arr('GOOGLE_MODELS')
assert len(iso) == 249 and len(set(iso)) == 249, len(iso)
assert len(set(avail)) == len(avail), 'dup in available'
assert all(c in iso for c in avail if c != 'XK'), [c for c in avail if c not in iso]
blocked = [c for c in iso if c not in avail]
print('available', len(avail), 'blocked', len(blocked), blocked)

path = 'schemas/model_registry.json'
raw = open(path, encoding='utf-8').read()
d = json.loads(raw)
again = json.dumps(d, indent=2, ensure_ascii=False) + '\n'
print('roundtrip identical:', again == raw)
google = [m['id'] for m in d['models'] if m.get('provider') == 'google']
assert sorted(google) == sorted(models), (google, models)
for m in d['models']:
    if m.get('provider') != 'google':
        continue
    m['blocked_countries'] = blocked
    if not m.get('terms_gate'):
        # 0142 / model_registry.py: a country list needs a terms_gate until the database checks the country by itself.
        m['terms_gate'] = 'terms_review_required'
        m['terms_notes'] = list(m.get('terms_notes') or []) + [
            "Gemini API Additional Terms (effective 2026-03-23): 'You may only access the Services (or make API Clients available to users) within an available region' (aistudio.google.com/docs/available-regions, read 2026-11-21). blocked_countries carries every ISO code not on that list; terms_review_required added 2026-11-21 because a country list needs a terms gate (0142). This row is past its shutdown date, so nothing on sale changes."
        ]
out = json.dumps(d, indent=2, ensure_ascii=False) + '\n'
if again == raw:
    open(path, 'w', encoding='utf-8', newline='\n').write(out)
    print('written')
