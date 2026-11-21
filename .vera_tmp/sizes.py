import json
d = json.load(open('schemas/model_registry.json', encoding='utf-8'))
for m in d['models']:
    by = ((m.get('pricing') or {}).get('variants') or {}).get('by')
    if m.get('image_sizes') or by == 'image_size':
        print(m['id'], m['adapter'], 'by=', by, m.get('image_sizes'), m.get('terms_gate'))
