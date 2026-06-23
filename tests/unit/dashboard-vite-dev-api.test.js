const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const viteConfigPath = path.resolve(__dirname, '..', '..', 'src', 'dashboard', 'web', 'vite.config.mjs')

test('Vite fallback dev API reuses dashboard serializers instead of local copies', () => {
  const source = fs.readFileSync(viteConfigPath, 'utf8')

  assert.match(source, /require\(['"]\.\.\/api\/serializers['"]\)/)
  assert.doesNotMatch(source, /function publicFlow\(/)
  assert.doesNotMatch(source, /function publicRunState\(/)
})
