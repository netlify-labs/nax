import type { NextConfig } from 'next'
import path from 'node:path'
import { createRequire } from 'node:module'
import nextra from 'nextra'

const require = createRequire(import.meta.url)
const mermaidPackagePath = require.resolve('@theguild/remark-mermaid/package.json')
const mermaidComponentPath = path.join(
  path.dirname(mermaidPackagePath),
  'dist',
  'mermaid.js'
)
const mermaidTurbopackAlias = path.relative(__dirname, mermaidComponentPath)

const withNextra = nextra({
  latex: true,
  defaultShowCopyCode: true,
  search: {
    codeblocks: false
  },
  contentDirBasePath: '/'
})

const config: NextConfig = withNextra({
  reactStrictMode: true,
  outputFileTracingRoot: __dirname,
  turbopack: {
    resolveAlias: {
      '@theguild/remark-mermaid/mermaid': mermaidTurbopackAlias
    }
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve ??= {}
    webpackConfig.resolve.alias ??= {}
    webpackConfig.resolve.alias['@theguild/remark-mermaid/mermaid'] =
      mermaidComponentPath

    return webpackConfig
  }
})

if (config.experimental && 'turbo' in config.experimental) {
  const experimental = config.experimental as NonNullable<
    NextConfig['experimental']
  > & {
    turbo?: NonNullable<NextConfig['turbopack']>
  }
  const turbo = experimental.turbo

  if (turbo) {
    config.turbopack = {
      ...turbo,
      ...config.turbopack,
      rules: {
        ...turbo.rules,
        ...config.turbopack?.rules
      },
      resolveAlias: {
        ...turbo.resolveAlias,
        ...config.turbopack?.resolveAlias
      }
    }
  }

  delete experimental.turbo
}

export default config
