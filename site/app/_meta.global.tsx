import type { DynamicMeta } from 'nextra'

export default {
  index: {
    type: 'page',
    display: 'hidden',
    theme: {
      layout: 'full'
    }
  },
  'get-started': 'Get Started',
  'for-agents': 'For Agents',
  guides: {
    title: 'Guides',
    items: {
      'run-workflows': 'Run Workflows',
      'write-custom-workflows': 'Write Custom Workflows',
      'use-the-dashboard': 'Use the Dashboard',
      'run-nax-in-ci': 'Run NAX in CI'
    }
  },
  reference: {
    title: 'Reference',
    items: {
      commands: 'Commands',
      'workflow-files': 'Workflow Files',
      'security-policies': 'Security Policies',
      configuration: 'Configuration'
    }
  },
  concepts: {
    title: 'Concepts',
    items: {
      'council-pattern': 'Council Pattern',
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
