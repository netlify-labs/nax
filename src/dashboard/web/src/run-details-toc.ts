import { generateToc } from '@davidwells/md-utils/toc'
import { findHeadings } from '@davidwells/md-utils/find-headings'

export type MarkdownTocEntry = {
  key: string
  level: number
  text: string
  index: number
  headingIndex: number
}

type MarkdownTocItem = {
  level?: number
  text?: string
  index?: number
  children?: MarkdownTocItem[]
}

type MarkdownHeading = {
  index?: number
}

const EXCLUDED_TOC_HEADINGS = new Set([
  'contents',
  'repository state',
])

function stripHeadingNumberPrefix(text: string): string {
  return text.replace(/^\d+\.\s+/, '').trim()
}

function stripMarkdownInlineText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function tocDisplayText(text: string): string {
  return stripHeadingNumberPrefix(stripMarkdownInlineText(text))
}

function normalizedTocText(text: string): string {
  return tocDisplayText(text).replace(/\s+/g, ' ').toLowerCase()
}

function shouldIncludeTocHeading(text: string): boolean {
  return !EXCLUDED_TOC_HEADINGS.has(normalizedTocText(text))
}

function flattenTocItems(items: MarkdownTocItem[], headingIndexes: Map<number, number>, depth = 1): MarkdownTocEntry[] {
  const entries: MarkdownTocEntry[] = []
  for (const item of items) {
    const text = String(item.text || '').trim()
    const displayText = tocDisplayText(text)
    const index = typeof item.index === 'number' ? item.index : -1
    if (text && index >= 0 && shouldIncludeTocHeading(text)) {
      entries.push({
        key: `${index}:${displayText}`,
        level: depth,
        text: displayText,
        index,
        headingIndex: headingIndexes.get(index) ?? 0,
      })
    }
    if (Array.isArray(item.children)) {
      entries.push(...flattenTocItems(item.children, headingIndexes, depth + 1))
    }
  }
  return entries
}

export function extractMarkdownToc(markdown: string): MarkdownTocEntry[] {
  const headings = findHeadings(markdown, {
    maxDepth: 6,
    includeHtmlHeaders: true,
  }) as MarkdownHeading[]
  const headingIndexes = new Map<number, number>()
  headings.forEach((heading, index) => {
    if (typeof heading.index === 'number') headingIndexes.set(heading.index, index)
  })
  const result = generateToc(markdown, {
    stripFirstH1: true,
    maxDepth: 4,
  }) as { tocItems?: MarkdownTocItem[] }
  return flattenTocItems(result.tocItems || [], headingIndexes)
}
