---
title: Audit SEO
description: Independently inspect routes, metadata, links, assets, and content for SEO issues.
instruction: audit this site for SEO issues including metadata, crawlability, structured data, links, content, and performance
---

# SEO Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This is a domain-specific `codebase-audit` prompt for public web discoverability. If the repository has no public web surface, adapt to package/docs discoverability and say so explicitly.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Map The SEO Surface

Identify:

- Framework and routing model.
- Public routes, dynamic routes, docs/blog/content collections, marketing pages, product pages, and localized routes.
- Metadata APIs, head tags, templates, layout files, sitemap/robots generation, RSS/feed files, redirects, canonical handling, and Open Graph/Twitter images.
- Image/media usage, heading structure, internal links, navigation, breadcrumbs, pagination, and structured data.
- Build/deploy config that affects public URLs.

## Audit Checks

- Indexability: accidental `noindex`, robots blocks, missing sitemap entries, bad canonical URLs, duplicate canonicals, incorrect status codes, client-only content that crawlers may miss, and redirect chains.
- Metadata: missing/duplicate/weak titles, descriptions, canonical, OG/Twitter tags, alternates/hreflang, and route-specific metadata for dynamic pages.
- Content structure: one meaningful H1, heading order, search intent match, thin/duplicated content, unclear product/category language, stale docs, and internal linking.
- Structured data: Organization, WebSite, BreadcrumbList, Article, Product, FAQ, SoftwareApplication, or other schema only where accurate.
- Links: broken internal links, orphan pages, poor anchor text, external link attributes where needed, and pagination/crawl traps.
- Images: meaningful alt text, stable dimensions, responsive sizes, non-huge hero images, and useful social preview images.
- Performance SEO: LCP image handling, render-blocking scripts, excessive client JS, layout shift, font loading, and mobile page speed risks.
- Internationalization: language tags, alternates, canonical-per-locale, and translated metadata where applicable.

## Output

Start with `## Repository State`, then `## SEO Surface Map`, then `## Structured Findings` as fenced JSON:

```json
[
  {
    "id": "SEO-1",
    "severity": "high",
    "category": "metadata|crawlability|content|links|images|performance|structured-data",
    "file": "app/blog/[slug]/page.tsx",
    "line": 31,
    "issue": "Dynamic blog posts do not generate canonical URLs",
    "search_impact": "Duplicate URLs can split ranking signals",
    "recommended_fix": "Add canonical metadata from resolved slug",
    "verification": "Inspect rendered head and sitemap entry"
  }
]
```

Then include `## Quick Wins`, `## Needs Runtime Crawl`, `## Content Opportunities`, and `## Positive Findings`.
