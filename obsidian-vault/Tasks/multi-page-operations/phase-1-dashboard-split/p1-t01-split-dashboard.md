# P1-T01 — Split the operations dashboard into focused pages

- Status: complete
- Phase: 1 — Dashboard split
- Parent plan: `obsidian-vault/Plans/multi-page-operations.md`
- Type: AFK-ready
- Dependencies: none
- Blocks: none

## User value

Operators can immediately see what needs intervention, then move into a focused workflow without scanning one oversized page.

## Technical story

Add shared App Router navigation, create focused route entries and loading states, add an exact action overview with bounded previews, and make the existing dashboard controller compose only the controls relevant to the selected route.

## Acceptance criteria

- `/` renders only the actionable overview and shared page controls.
- `/discs`, `/catalog`, `/encoding`, and `/verification` each render their intended detailed surface.
- Every attention category has loading, error, clear, and populated behavior.
- Existing actions and live refresh behavior are preserved.
- Navigation is active-state aware, responsive, and keyboard accessible.

## Validation

- `pnpm --filter @rip-dvd/web test`
- `pnpm --filter @rip-dvd/web typecheck`
- Browser inspection at mobile and desktop widths.
