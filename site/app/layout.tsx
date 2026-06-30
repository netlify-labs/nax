import { Footer, Layout, Navbar, ThemeSwitch } from 'nextra-theme-docs'
import { getPageMap } from 'nextra/page-map'
import { Search } from 'nextra/components'
import 'nextra-theme-docs/style.css'
import './custom.css'

export const metadata = {
  title: { default: 'nax Docs', template: '%s - nax' },
  description: 'Documentation for the Netlify-Agent-eXecutor CLI.'
}

function NetlifyLogo() {
  return (
    <svg
      viewBox="0 0 128 128"
      aria-hidden="true"
      className="nax-docs-logo-mark"
    >
      <path
        className="nax-docs-logo-diamond"
        d="m125.2 54.8-52-52L71.3.9 69.2 0H58.8l-2.1.9-1.9 1.9-52 52-1.9 1.9-.9 2.1v10.3l.9 2.1 1.9 1.9 52 52 1.9 1.9 2.1.9h10.3l2.1-.9 1.9-1.9 52-52 1.9-1.9.9-2.1V58.8l-.9-2.1-1.8-1.9z"
      />
      <path
        className="nax-docs-logo-n"
        d="M78.9 80.5H71l-.7-.7V61.3c0-3.3-1.3-5.9-5.3-6-2-.1-4.4 0-6.9.1l-.4.4v24l-.7.7h-7.9l-.7-.7V48.1l.7-.7H67c6.9 0 12.6 5.6 12.6 12.6v19.8l-.7.7z"
      />
      <path
        className="nax-docs-logo-spark"
        d="m38.4 30.8 7.3 7.3v5.8l-.8.8h-5.8l-7.3-7.3v-1.1l5.5-5.5h1.1zm.2 37.2v-8l-.7-.7h-28l-.7.7v8l.7.7H38l.6-.7zm.5 15.7L31.8 91v1.1l5.5 5.5h1.1l7.3-7.3v-5.8l-.8-.8h-5.8zM60 11.3l-.6.7v25l.7.7H68l.7-.7V12l-.7-.7h-8zm0 79.1-.7.7v25l.7.7h8l.7-.7v-25l-.7-.7h-8zm58.1-31h-28l-.7.6v8l.7.7h28.1l.7-.7v-8l-.8-.6z"
      />
    </svg>
  )
}

function DocsLogo() {
  return (
    <span className="nax-docs-logo">
      <NetlifyLogo />
      <span className="nax-docs-logo-text">Netlify Agent Executor</span>
    </span>
  )
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pageMap = await getPageMap()
  const navbar = (
    <Navbar
      logo={<DocsLogo />}
      projectLink="https://github.com/netlify-labs/nax"
    />
  )
  const search = (
    <div className="nax-navbar-tools">
      <ThemeSwitch />
      <Search />
    </div>
  )
  const footer = <Footer>nax documentation</Footer>

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <Layout
          pageMap={pageMap}
          navbar={navbar}
          footer={footer}
          docsRepositoryBase="https://github.com/netlify-labs/nax/blob/main/site/content"
          editLink="Edit this page on GitHub"
          feedback={{ content: 'Question? Give us feedback' }}
          search={search}
          sidebar={{ defaultMenuCollapseLevel: 1, autoCollapse: true }}
          nextThemes={{ defaultTheme: 'dark' }}
          themeSwitch={{ dark: 'Dark', light: 'Light', system: 'System' }}
          toc={{ float: true }}
          navigation={{ prev: true, next: true }}
          darkMode
        >
          {children ?? null}
        </Layout>
      </body>
    </html>
  )
}
