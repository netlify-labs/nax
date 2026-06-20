import { lazy, Suspense } from 'react'
import { ActionIcon, CopyButton, Text, Tooltip } from '@mantine/core'
import { Check, Copy } from 'lucide-react'

const StreamdownMarkdown = lazy(async () => {
  const [{ Streamdown }, { createCodePlugin }] = await Promise.all([
    import('streamdown'),
    import('@streamdown/code'),
  ])
  const codePlugin = createCodePlugin({ themes: ['github-light', 'github-dark'] })

  return {
    default: function StreamdownMarkdownRenderer({ children }: { children: string }) {
      return (
        <Streamdown
          mode="static"
          controls={{ code: false, table: false, mermaid: false }}
          linkSafety={{ enabled: false }}
          lineNumbers={false}
          plugins={{ code: codePlugin }}
        >
          {children}
        </Streamdown>
      )
    },
  }
})

export function MarkdownRenderer({
  children,
  copyLabel = 'Copy markdown',
  fallback = 'Rendering markdown...',
}: {
  children: string
  copyLabel?: string
  fallback?: string
}) {
  return (
    <>
      <CopyButton value={children} timeout={1200}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : copyLabel} position="left" withArrow>
            <ActionIcon
              aria-label={copyLabel}
              className="markdown-copy-button"
              color={copied ? 'green' : 'gray'}
              onClick={copy}
              size="sm"
              type="button"
              variant="light"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
      <Suspense fallback={<Text c="dimmed">{fallback}</Text>}>
        <StreamdownMarkdown>{children}</StreamdownMarkdown>
      </Suspense>
    </>
  )
}
