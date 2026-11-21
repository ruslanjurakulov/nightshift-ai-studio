p = 'components/studio/GeneratePanel.tsx'
s = open(p, encoding='utf-8').read()
old_def = '''  const sizes: readonly ImageSize[] = takesQuality(capability) && !locked ? (current?.imageSizes ?? []) : [];
  const sizeBlock ='''
assert s.count(old_def) == 1
s = s.replace(old_def, '''  const sizes: readonly ImageSize[] = takesQuality(capability) && !locked ? (current?.imageSizes ?? []) : [];
  const imageSizeBlock =''')
bad = '            {qualityBlock}\n          {sizeBlock}\n            {sizeBlock}\n'
assert s.count(bad) == 1
s = s.replace(bad, '            {qualityBlock}\n            {imageSizeBlock}\n')
two = '          {promptBlock}\n          {qualityBlock}\n'
assert s.count(two) == 1
s = s.replace(two, two + '          {imageSizeBlock}\n')
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
