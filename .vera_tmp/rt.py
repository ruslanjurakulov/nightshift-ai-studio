import json
raw = open('schemas/model_registry.json', encoding='utf-8').read()
d = json.loads(raw)
for ea in (True, False):
    for nl in ('', '\n'):
        again = json.dumps(d, indent=2, ensure_ascii=ea) + nl
        print(ea, repr(nl), again == raw)
again = json.dumps(d, indent=2, ensure_ascii=False) + '\n'
for i, (a, b) in enumerate(zip(raw, again)):
    if a != b:
        print(i, repr(raw[i-80:i+80]), '\n---\n', repr(again[i-80:i+80]))
        break
print(len(raw), len(again), raw.count('\r'))
