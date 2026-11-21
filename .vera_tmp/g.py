import json
d = json.load(open('schemas/model_registry.json', encoding='utf-8'))
ms = d['models'] if isinstance(d, dict) else d
for m in ms:
    if m.get('provider') == 'google':
        p = m.get('pricing') or {}
        v = p.get('variants') or {}
        print(m['id'], m['capabilities'], 'tg=', m.get('terms_gate'), 'exp=', m.get('api_exposure'), 'mcp=', m.get('mcp_oauth_exposure'),
              'unit=', p.get('unit'), 'by=', v.get('by'), list((v.get('prices') or {}).keys()), 'cu=', m.get('credit_unit'),
              'sizes=', m.get('image_sizes'), 'res=', m.get('resolutions'), 'dur=', m.get('durations_s'),
              'defres=', m.get('default_resolution'), 'audio=', m.get('audio_out'), 'shut=', bool(m.get('shutdown')))
