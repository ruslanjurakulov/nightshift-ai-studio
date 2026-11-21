import json
import re

ts = open('command-center/lib/geo/blocked.ts', encoding='utf-8').read()


def arr(name):
    m = re.search(r'export const ' + name + r'[^=]*=\s*\[(.*?)\];', ts, re.S)
    return re.findall(r'"([A-Za-z0-9.\-]+)"', m.group(1))


iso = arr('ISO_3166_ALPHA2')
avail = arr('GOOGLE_AVAILABLE_REGIONS')
blocked = [c for c in iso if c not in avail]
path = 'schemas/model_registry.json'
raw = open(path, encoding='utf-8').read()
lines = raw.split('\n')
d = json.loads(raw)
google = {m['id'] for m in d['models'] if m.get('provider') == 'google'}
NOTE = ("Gemini API Additional Terms (effective 2026-03-23): 'You may only access the Services (or make API Clients available to "
        "users) within an available region' (aistudio.google.com/docs/available-regions, read 2026-11-21). blocked_countries carries "
        "every ISO code not on that list; terms_review_required added 2026-11-21 because a country list needs a terms gate until the "
        "database checks the country (0142). This row is past its shutdown date, so nothing on sale changes.")
out = []
cur = None
pending_note = False
i = 0
while i < len(lines):
    ln = lines[i]
    m = re.match(r'^      "id": "([^"]+)",$', ln)
    if m:
        cur = m.group(1)
    if cur in google and ln == '      "terms_gate": null,':
        ln = '      "terms_gate": "terms_review_required",'
        pending_note = True
    if cur in google and pending_note and ln == '      "terms_notes": [':
        out.append(ln)
        i += 1
        # copy notes until the closing bracket, adding a comma to the last and our note
        while lines[i] != '      ],':
            out.append(lines[i])
            i += 1
        out[-1] = out[-1] + ','
        out.append('        ' + json.dumps(NOTE, ensure_ascii=False))
        out.append(lines[i])
        pending_note = False
        i += 1
        continue
    out.append(ln)
    if cur in google and ln == '      "api_exposure": "web_only",':
        out.append('      "blocked_countries": [')
        for k, c in enumerate(blocked):
            out.append('        "%s"%s' % (c, ',' if k < len(blocked) - 1 else ''))
        out.append('      ],')
    i += 1
new = '\n'.join(out)
d2 = json.loads(new)
for mm in d2['models']:
    if mm['id'] in google:
        assert mm['blocked_countries'] == blocked, mm['id']
        assert mm['terms_gate'], mm['id']
assert sum(1 for mm in d2['models'] if mm.get('blocked_countries')) == len(google) + 1
open(path, 'w', encoding='utf-8', newline='\n').write(new)
print('ok', len(google))
