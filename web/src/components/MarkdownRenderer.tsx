import { lazy, Suspense } from 'react'
import { Text } from '@mantine/core'

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
          lineNumbers={false}
          plugins={{ code: codePlugin }}
        >
          {children}
        </Streamdown>
      )
    },
  }
})

export function MarkdownRenderer({ children, fallback = 'Rendering markdown...' }: { children: string; fallback?: string }) {
  return (
    <Suspense fallback={<Text c="dimmed">{fallback}</Text>}>
      <StreamdownMarkdown>{children}</StreamdownMarkdown>
    </Suspense>
  )
}
