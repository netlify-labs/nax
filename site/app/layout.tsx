import { Footer, Layout, Navbar, ThemeSwitch } from 'nextra-theme-docs'
import { getPageMap } from 'nextra/page-map'
import { Search } from 'nextra/components'
import 'nextra-theme-docs/style.css'
import './custom.css'

export const metadata = {
  title: { default: 'nax Docs', template: '%s - nax' },
  description: 'Documentation for the Netlify-Agent-eXecutor CLI.'
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pageMap = await getPageMap()
  const navbar = (
    <Navbar
      logo={<b>nax</b>}
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
