# Multi-page operations dashboard

- Status: complete
- Source: User request on 2026-08-10 to replace the single crowded front page with multiple pages and keep a high-level actionable overview on the front page.

## Problem

The control plane places configuration, queue creation, verification inventory, hardware state, active jobs, and catalog review in one long page. Important operator actions compete with detailed and low-frequency controls.

## Goals

- Make `/` a concise overview of work requiring operator attention.
- Move detailed workflows into clearly named routes.
- Preserve all existing controls, live updates, failure states, and operational data.
- Keep navigation and page hierarchy usable on mobile and desktop.

## Non-goals

- No database, API, worker, or domain-model changes.
- No redesign of the individual forms and editors beyond fitting them into focused pages.
- No authentication or permission changes.

## Proposed behavior

- `/`: actionable overview covering discs awaiting approval, failed archive jobs, failed encode jobs, catalog reviews, and recorded filesystem verification problems.
- `/discs`: optical drives, detected discs, and archive jobs.
- `/catalog`: pending catalog review and its editor.
- `/encoding`: encoding profiles, queue creation, and encode jobs.
- `/verification`: filesystem verification inventory.
- A shared responsive navigation makes every destination visible from every page.
- Each new route includes an instant loading state shaped like the destination surface.

## Resolved decisions and assumptions

- The direct implementation request is explicit acceptance of this focused information architecture.
- “Needs to be actioned” means operator-intervention states, not healthy/running work.
- A purpose-built action-summary API returns exact counts and bounded previews; the paged activity feed is not authoritative enough for the overview.
- English-only copy follows this repository's current convention; no i18n catalog exists.
- There are no remaining HITL decisions.

## Functional requirements

1. Overview cards expose an accurate count and item names when their dashboard section is loaded.
2. Loading, unavailable, clear, and needs-attention states are distinct.
3. Each card links to the page where the work can be completed.
4. Existing actions remain on the applicable detail page.
5. Current live-update connection and manual refresh behavior remain available.
6. Navigation exposes a meaningful active-page state and works with keyboard focus.

## Implementation requirements

- Keep shared detail-page dashboard fetching and mutation handling in `OperationsDashboard`; overview mode uses the exact action summary instead of opening the broader activity stream.
- Add a page-mode interface instead of duplicating network state across new components.
- Use Next.js App Router pages and `loading.tsx` boundaries.
- Use `next/link` for internal navigation and `usePathname` for the active state.
- Preserve existing dark green and amber visual language.
- Validate with web component tests, the web package test suite, type checking, and responsive browser inspection.

## Acceptance criteria

- The front page no longer renders detailed profile, queue, verification, hardware, or full job-management surfaces.
- All five attention categories appear on the overview.
- Each previous front-page surface is reachable on exactly one focused detail page.
- Navigation and content do not overflow at narrow mobile widths.
- Existing dashboard tests remain green and new overview/navigation tests pass.

## Risks and recovery

- Risk: operators could miss a category if filtering is incorrect. Mitigation: pure rendered-output tests for every attention category and clear/error states.
- Risk: controls could be lost during the split. Mitigation: retain the current components and conditionally compose them by route.
- Recovery is a normal code revert; no persisted data changes are involved.

## Phase summary

| Phase | Status | Tasks |
| --- | --- | --- |
| 1 — Dashboard split | complete | P1-T01 |
| 2 — Optimize action summary | complete (P2-T01 deferred) | P2-T01 |

## Build handoff

Implement `P1-T01` from `obsidian-vault/Tasks/multi-page-operations/phase-1-dashboard-split/p1-t01-split-dashboard.md`.
