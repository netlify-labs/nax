import Link from 'next/link'
import type { ReactNode } from 'react'

type HomeCardsProps = {
  children: ReactNode
}

type HomeCardProps = {
  children: ReactNode
  href: string
  title: string
}

export function HomeCards({ children }: HomeCardsProps) {
  return <div className="nax-home-cards">{children}</div>
}

export function HomeCard({ children, href, title }: HomeCardProps) {
  return (
    <Link className="nax-home-card" href={href}>
      <span className="nax-home-card-copy">{children}</span>
      <span className="nax-home-card-title">
        {title}
        <span aria-hidden="true">-&gt;</span>
      </span>
    </Link>
  )
}
