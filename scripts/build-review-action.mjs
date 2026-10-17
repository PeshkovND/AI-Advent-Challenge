import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const result = await build({
  entryPoints: ['server/code-review-action-cli.ts'], outfile: 'dist-action/index.cjs',
  bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  minify: false, sourcemap: false, legalComments: 'eof', metafile: true,
  // Node built-ins (including node:sqlite) remain provided by Node 24.
})
const packages = [...new Set(Object.keys(result.metafile.inputs).filter((path) => path.includes('node_modules/'))
  .map((path) => path.split('node_modules/').pop().split('/')[0]))].sort()
if (packages.some((name) => name !== 'zod')) throw new Error('Update third-party notices for bundled packages: ' + packages.join(', '))
writeFileSync('dist-action/THIRD_PARTY_NOTICES.txt', 'Bundled dependency: zod\n\n' + readFileSync('node_modules/zod/LICENSE', 'utf8'))
