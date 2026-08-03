declare module '@davidwells/md-utils/toc' {
  export type TocItem = {
    level: number
    text: string
    slug?: string
    match?: string
    index?: number
    children?: TocItem[]
  }

  export type TocOptions = {
    collapse?: boolean
    collapseText?: string
    excludeText?: string
    stripFirstH1?: boolean
    sub?: boolean
    maxDepth?: number
  }

  export function generateToc(
    contents: string,
    options?: TocOptions,
  ): {
    tocItems: TocItem[]
    text: string
    tree: TocItem[]
  }
}

declare module '@davidwells/md-utils/find-headings' {
  export type MarkdownHeading = {
    text: string
    match: string
    level: number
    index?: number
  }

  export type FindHeadingsOptions = {
    maxDepth?: number
    includeHtmlHeaders?: boolean
    excludeIndex?: boolean
    filter?: (heading: MarkdownHeading) => boolean
  }

  export function findHeadings(
    text: string,
    options?: FindHeadingsOptions,
  ): MarkdownHeading[]
}
