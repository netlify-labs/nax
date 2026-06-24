import type { DynamicMeta } from 'nextra'

export default {
  index: {
    type: 'page',
    display: 'hidden'
  },
  'get-started': 'Get Started',
  guides: {
    title: 'Guides',
    items: {
      'run-workflows': 'Run Workflows',
      'write-custom-workflows': 'Write Custom Workflows',
      'use-the-dashboard': 'Use the Dashboard'
    }
  },
  reference: {
    title: 'Reference',
    items: {
      commands: 'Commands',
      'workflow-files': 'Workflow Files',
      configuration: 'Configuration'
    }
  },
  concepts: {
    title: 'Concepts',
    items: {
      architecture: 'Architecture',
      transports: 'Transports',
      artifacts: 'Artifacts',
      glossary: 'Glossary'
    }
  },
  troubleshooting: 'Troubleshooting',
  contributing: 'Contributing',
  github: {
    title: 'GitHub',
    href: 'https://github.com/netlify-labs/nax'
  }
} satisfies DynamicMeta
