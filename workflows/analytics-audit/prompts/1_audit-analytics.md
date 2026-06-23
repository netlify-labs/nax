---
title: Audit Analytics
description: Independently map existing telemetry and identify missing high-value tracking.
instruction: audit product analytics and recommend the events this app should track
---

# Analytics Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt embeds the relevant `ga4` workflow for remote runners while staying provider-neutral when the app does not use GA4/GTM.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Map The Product Funnel

Use code and docs as ground truth. Identify:

- Acquisition: landing pages, pricing, docs, blog, referral links, campaigns.
- Conversion: CTA clicks, signup/login, OAuth callbacks, waitlist, demo booking, checkout.
- Activation: onboarding, first project/import/setup, first successful core action.
- Engagement: feature usage, exports, invites, collaboration, dashboard visits, recurring jobs.
- Monetization: plan views, checkout started/completed, upgrade/downgrade, seat changes, payment failure, cancellation.
- Retention: repeat usage, saved settings, notifications, reactivation, support interactions.
- Failure moments: validation errors, empty states, auth failures, API failures, paywall hits.

## Audit Existing Tracking

Find analytics providers and event surfaces:

- GA4/GTM, `dataLayer`, Segment, PostHog, RudderStack, Plausible, Amplitude, Mixpanel, custom analytics helpers, server logs, conversion pixels, ad pixels, A/B test assignment, and feature flag events.
- Event helper consistency: one shared tracking function vs scattered calls.
- Client/server placement: events should fire where the action is actually confirmed.
- Duplicate or noisy events.
- Missing parameters needed for decisions.
- Privacy risks: PII, secrets, full URLs with tokens, free-form user content, high-cardinality IDs, or tenant-sensitive data.

## Event Design Rules

- Track decisions the team can act on. Do not add events only because they are easy.
- Prefer stable event names: `cta_click`, `sign_up`, `checkout_started`, `checkout_completed`, `feature_use`, `paywall_view`, `error_shown`, `invite_sent`, `export_completed`.
- Use parameters for dimensions: `cta_text`, `cta_position`, `page_path`, `feature_name`, `feature_category`, `plan`, `tier`, `experiment_id`, `variant`, `method`, `error_code`.
- Avoid event-name sprawl. For feature usage, prefer one `feature_use` event with `feature_name` unless the product already has a different convention.
- Mark true conversion events explicitly, such as `sign_up`, `checkout_completed`, or `demo_booked`.
- Ensure conversion events fire once per conversion, after the backend or auth provider confirms success.
- For A/B tests, assignment should be server-side or otherwise flicker-free, and all downstream events should include variant metadata.

## Validation Plan

For each recommended event, state how to validate:

- Unit test for analytics helper payload.
- E2E test that action pushes the event.
- GTM Preview / GA4 DebugView / provider realtime.
- Server log or webhook confirmation.
- Data quality check: no duplicates, no PII, expected parameter cardinality.

## Output

Start with `## Repository State`, then `## Current Telemetry`, then `## Structured Tracking Plan` as fenced JSON:

```json
[
  {
    "event": "checkout_completed",
    "priority": "P0",
    "trigger": "After payment provider confirms checkout",
    "file": "path/to/file.ts",
    "line": 123,
    "client_or_server": "server",
    "parameters": ["plan", "billing_period", "seat_count"],
    "conversion": true,
    "decision_enabled": "Measure paid conversion rate by plan",
    "privacy_notes": "No email, provider customer id, or raw checkout URL",
    "validation": "Provider realtime plus E2E assertion"
  }
]
```

Then include `## Missing Funnel Coverage`, `## Noisy Or Risky Tracking`, and `## Implementation Order`.
