p = 'tests/geo-google.test.ts'
s = open(p, encoding='utf-8').read()
i = s.index('describe("the region editor\'s run", () => {')
s = s[:i].rstrip('\n') + '\n'
s = s.replace('const regionRun = await import("@/app/api/region-edit/run/route");\n', '')
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
