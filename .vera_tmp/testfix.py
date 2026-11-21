def patch(p, pairs):
    s = open(p, encoding='utf-8').read()
    for old, new, cnt in pairs:
        n = s.count(old)
        assert (n == cnt) if cnt else n >= 1, (p, old[:60], n)
        s = s.replace(old, new)
    open(p, 'w', encoding='utf-8', newline='\n').write(s)


patch('tests/studio-describe.test.tsx', [(
    'for (const k of PARAM_KEYS) if (k !== "quality" && k !== "audio" && k !== "look") expect',
    'for (const k of PARAM_KEYS) if (k !== "quality" && k !== "audio" && k !== "look" && k !== "image_size") expect', 1)])
for f in ('tests/studio-video-tools.test.tsx', 'tests/studio-voice-tools.test.tsx'):
    patch(f, [('"video_edit", "video_reframe", "video_remove_bg"];', '"video_edit", "video_reframe", "video_remove_bg", "image_size"];', 1)])
patch('tests/studio-video-ops.test.tsx', [(
    '''    // No new param key: 0100 reuses prompt and aspect_ratio.
    expect(PARAM_KEYS).toHaveLength(17);''',
    '''    // No new param key: 0100 reuses prompt and aspect_ratio (the 18th, image_size, is 0208's: tests/geo-google.test.ts).
    expect(PARAM_KEYS.filter((k) => k !== "image_size")).toHaveLength(17);''', 1)])
s = open('tests/region-edit-routes.test.ts', encoding='utf-8').read()
old = 'headers: { "content-type": "application/json" }'
assert s.count(old) >= 1, 'region'
s = s.replace(old, 'headers: { "content-type": "application/json", ...UZ_VISITOR }')
i = s.index('const post = ')
s = s[:i] + ('// The edit model here is Google\'s, sold only where the visitor\'s country is known and listed (lib/geo/blocked.ts): these '
             'requests come\n// from an address the shipped table places in Uzbekistan. tests/geo-google.test.ts covers the refusals.\n'
             'const UZ_VISITOR = { "x-nightshift-client-ip": "84.54.64.1" };\n') + s[i:]
open('tests/region-edit-routes.test.ts', 'w', encoding='utf-8', newline='\n').write(s)

GEO_MOCK = ('// The country check is not what these tests are about (tests/geo-google.test.ts is): an unknown country would hide the Google rows.\n'
            'vi.mock("@/lib/server/geo", () => ({ hideBlockedModelsHere: async <T,>(m: T[]) => m }));\n')
for f in ('tests/model-switch.test.ts', 'tests/studio-shutdown-models.test.ts'):
    s = open(f, encoding='utf-8').read()
    a = 'vi.mock("server-only", () => ({}));\n'
    assert s.count(a) == 1, f
    s = s.replace(a, a + GEO_MOCK)
    open(f, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
