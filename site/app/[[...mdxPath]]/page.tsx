import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents as getMDXComponents } from '../../mdx-components'

type PageProps = {
  params: Promise<{
    mdxPath?: string[]
  }>
}

export const generateStaticParams = generateStaticParamsFor('mdxPath')

function isNonDocumentRequest(pathSegments: string[] | undefined): boolean {
  if (!pathSegments?.length) {
    return false
  }

  return pathSegments.some((segment, index) => {
    const isLastSegment = index === pathSegments.length - 1
    return segment.startsWith('.') || (isLastSegment && segment.includes('.'))
  })
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const params = await props.params
  if (isNonDocumentRequest(params.mdxPath)) {
    notFound()
  }

  const { metadata } = await importPage(params.mdxPath)
  return metadata
}

const Wrapper = getMDXComponents().wrapper

export default async function Page(props: PageProps) {
  const params = await props.params
  if (isNonDocumentRequest(params.mdxPath)) {
    notFound()
  }

  const { default: MDXContent, toc, metadata } = await importPage(params.mdxPath)

  return (
    <Wrapper toc={toc} metadata={metadata}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  )
}
