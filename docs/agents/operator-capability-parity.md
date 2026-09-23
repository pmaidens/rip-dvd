# Operator capability parity

The web interface and `rip-dvd` CLI are separate adapters over the same
application operations. A web operator feature is not complete until this
inventory names its CLI equivalent and its externally observable behavior
coverage. SQL access, a worker-only API, or a test of an internal helper does
not count as a CLI equivalent.

For every operator change:

1. Update the matching inventory row. Add a row when the capability is new.
2. Implement the CLI behavior without calling the web service.
3. Test the workflow through the public command runner with real persistence.
4. Add focused HTTP parity coverage when the web and CLI adapters mutate or
   validate the same operation.
5. Add browser coverage only for behavior that depends on browser interaction.
6. Run `pnpm check`, `pnpm test:browser`, and the installed-executable smoke.

The repository test suite checks that every operator API route and every
top-level CLI command remains represented here. That catches additions, but it
does not prove a row is honest. Reviewers must follow the cited behavior test
and compare both adapters with the same application rule.

## Capability inventory

<!-- capability-inventory:start -->
| Operator capability | Web boundary | CLI boundary | Behavior coverage |
| --- | --- | --- | --- |
| Command discovery, schemas, examples, and key generation | Web forms expose required inputs; no HTTP-only discovery contract | `rip-dvd commands`, `rip-dvd help`, `rip-dvd generate-key` | `apps/operator-cli/src/command.test.ts`, `scripts/smoke-operator-cli.sh` |
| Database health and deployment readiness | `apps/web/app/api/health/route.ts`, `apps/web/app/api/deployment-readiness/route.ts` | `rip-dvd health`, `rip-dvd readiness` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Operations overview, recent activity, and action overview | `apps/web/app/api/dashboard/route.ts`, `apps/web/app/api/dashboard/events/route.ts`, `apps/web/app/api/action-overview/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd inspect activity`, `rip-dvd inspect worker-incidents`, `rip-dvd inspect archive-requests`, `rip-dvd inspect encode-jobs` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Optical Drive status and inspection history | `apps/web/app/api/dashboard/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd inspect optical-drives [id]` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Detected Disc detail, current work, archives, and available actions | `apps/web/app/api/dashboard/discs/[id]/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd inspect detected-discs [id]` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Disc Inspection attempts, progress, evidence, failure diagnosis, retry, status, and wait | `apps/web/app/api/dashboard/discs/[id]/route.ts`, `apps/web/app/api/disc-inspections/[id]/retry/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd inspect disc-inspections [id]`, `rip-dvd retry-disc-inspection`, `rip-dvd wait disc-inspections` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Submit preservation intent | `apps/web/app/api/archive-requests/route.ts` | `rip-dvd submit-archive-request` | `apps/web/app/api/workflow-mutations.test.ts`, `apps/operator-cli/src/command.test.ts`, `apps/web/test/browser/archive-request.e2e.ts` |
| Archive Request detail, waiting reason, cancellation, retry, status, and wait | `apps/web/app/api/archive-requests/[id]/route.ts`, `apps/web/app/api/archive-requests/[id]/retry/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd inspect archive-requests [id]`, `rip-dvd cancel-archive-request`, `rip-dvd retry-archive-request`, `rip-dvd wait archive-requests` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Archive Job attempts, progress, evidence, failure detail, status, and wait | `apps/web/app/api/archive-jobs/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd inspect archive-jobs [id]`, `rip-dvd wait archive-jobs` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Catalog Review detail, coverage, decisions, correction history, and replacement history | `apps/web/app/api/catalog-reviews/[id]/route.ts` | `rip-dvd catalog-review show` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts`, `apps/web/test/browser/catalog-review.e2e.ts` |
| Metadata suggestions and candidate selection | `apps/web/app/api/catalog-reviews/[id]/suggestion/route.ts` | `rip-dvd catalog-review suggest` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Media Item search and detail | `apps/web/app/api/media-items/route.ts`, `apps/web/app/api/media-items/[id]/route.ts` | `rip-dvd media-item search`, `rip-dvd media-item show` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Media Item creation, previewed changes, deletion, and replay | `apps/web/app/api/media-items/route.ts`, `apps/web/app/api/media-items/[id]/route.ts` | `rip-dvd media-item preview`, `rip-dvd media-item create`, `rip-dvd media-item update`, `rip-dvd media-item delete` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Disc Selection detail, creation, and ordinary edits | `apps/web/app/api/catalog-reviews/[id]/route.ts` | `rip-dvd disc-selection show`, `rip-dvd disc-selection create`, `rip-dvd disc-selection update` | `apps/operator-cli/src/disc-selection.test.ts`, `apps/web/components/operations-dashboard-workflow.integration.test.tsx` |
| Disc Selection preview, repair, correction, deletion, history, and provenance protection | `apps/web/app/api/catalog-reviews/[id]/route.ts` | `rip-dvd disc-selection preview`, `rip-dvd disc-selection repair`, `rip-dvd disc-selection correct`, `rip-dvd disc-selection delete` | `apps/operator-cli/src/disc-selection.test.ts`, `apps/web/components/operations-dashboard-workflow.integration.test.tsx`, `apps/web/test/browser/catalog-review.e2e.ts` |
| Atomic movie and episodic mapping proposals | `apps/web/app/api/catalog-reviews/[id]/route.ts` | `rip-dvd catalog-review apply-proposal` | `apps/operator-cli/src/mapping-proposal.test.ts`, `apps/web/components/operations-dashboard-workflow.integration.test.tsx` |
| Catalog Review completion, stale revision protection, and explicit replacement plan | `apps/web/app/api/catalog-reviews/[id]/route.ts` | `rip-dvd catalog-review preview-completion`, `rip-dvd catalog-review complete` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/catalog-review-completion.test.ts` |
| Encode queue options, search, history, resolution, and conflicts | `apps/web/app/api/encode-jobs/route.ts` | `rip-dvd encode-queue`, `rip-dvd encode-resolve` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts`, `apps/web/test/browser/encode-jobs.e2e.ts` |
| Encode Job submission | `apps/web/app/api/encode-jobs/route.ts` | `rip-dvd encode-enqueue` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts`, `apps/web/test/browser/encode-jobs.e2e.ts` |
| Encode Job previewed requeue, cancellation, detail, status, and wait | `apps/web/app/api/encode-jobs/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd encode-requeue-preview`, `rip-dvd encode-requeue`, `rip-dvd encode-cancel`, `rip-dvd inspect encode-jobs [id]`, `rip-dvd wait encode-jobs` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts`, `apps/web/test/browser/encode-jobs.e2e.ts` |
| Encoding Profile list, creation, and versioning | `apps/web/app/api/encoding-profiles/route.ts` | `rip-dvd list-encoding-profiles`, `rip-dvd create-encoding-profile`, `rip-dvd version-encoding-profile` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Encoding Profile activation and deactivation previews | `apps/web/app/api/encoding-profiles/route.ts` | `rip-dvd preview-encoding-profile-state`, `rip-dvd activate-encoding-profile`, `rip-dvd deactivate-encoding-profile` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Original Disc Archive inventory, lineage, references, storage observations, and re-archive eligibility | `apps/web/app/api/operations/route.ts`, `apps/web/app/api/action-overview/route.ts` | `rip-dvd inspect original-disc-archives [id]` | `apps/operator-cli/src/command.test.ts`, `apps/operator-cli/src/full-operator-parity.integration.test.ts` |
| Filesystem Verification submission, retained result, status, and wait | `apps/web/app/api/filesystem-verification/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd submit-filesystem-verification`, `rip-dvd inspect filesystem-verifications [id]`, `rip-dvd wait filesystem-verifications` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Bounded Archive Audit submission, findings, truncation, status, and wait | No dedicated web screen; results remain available through operations APIs | `rip-dvd submit-archive-audit`, `rip-dvd inspect archive-audits [id]`, `rip-dvd wait archive-audits` | `apps/operator-cli/src/command.test.ts` |
| Worker Incident activity, failure detail, and recovery | `apps/web/app/api/dashboard/events/route.ts`, `apps/web/app/api/operations/route.ts` | `rip-dvd inspect worker-incidents [id]`, `rip-dvd inspect activity` | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts` |
| Fresh Re-archive Request with source identity and waiting reason | `apps/web/app/api/rearchive-requests/route.ts` | `rip-dvd request-rearchive`, `rip-dvd inspect archive-requests [id]` | `apps/web/app/api/workflow-mutations.test.ts`, `apps/operator-cli/src/command.test.ts`, `apps/operator-cli/src/full-operator-parity.integration.test.ts` |
| Re-archive Mapping Proposal preview, validation, save, and replay | `apps/web/app/api/catalog-reviews/[id]/route.ts` | `rip-dvd catalog-review preview-rearchive-proposal`, `rip-dvd catalog-review save-rearchive-proposal` | `apps/operator-cli/src/rearchive-mapping-proposal.test.ts`, `apps/web/components/operations-dashboard-workflow.integration.test.tsx`, `apps/operator-cli/src/full-operator-parity.integration.test.ts` |
| Re-archive Acceptance preview, affected work, adoption, and optional replacement encodes | `apps/web/app/api/catalog-reviews/[id]/route.ts` | `rip-dvd catalog-review preview-rearchive-acceptance`, `rip-dvd catalog-review accept-rearchive` | `apps/operator-cli/src/rearchive-acceptance.test.ts`, `apps/web/components/operations-dashboard-workflow.integration.test.tsx`, `apps/operator-cli/src/full-operator-parity.integration.test.ts` |
| JSON-only success and stable machine-readable failures | All operator mutation and query routes above | Every `rip-dvd` command | `apps/operator-cli/src/command.test.ts`, `scripts/smoke-operator-cli.sh` |
| Flags plus inline JSON, stdin, and file input | Web forms submit the same complete application inputs | `rip-dvd media-item`, `rip-dvd disc-selection`, and `rip-dvd catalog-review` mutations | `apps/operator-cli/src/command.test.ts`, `apps/operator-cli/src/mapping-proposal.test.ts`, `apps/operator-cli/src/disc-selection.test.ts`, `scripts/smoke-operator-cli.sh` |
| Mutation keys, same-input replay, changed-input conflict, response loss, and process restart | All operator mutation routes above | Every mutating `rip-dvd` command | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/command.test.ts`, `apps/operator-cli/src/mapping-proposal.test.ts`, `apps/operator-cli/src/full-operator-parity.integration.test.ts` |
| Consequential previews, acknowledgement, and stale revision rejection | Catalog Review, Disc Selection, Media Item, Encoding Profile, Encode Job, and Re-archive routes above | Matching `rip-dvd` preview and mutation commands | `apps/web/app/api/operator-command-parity.test.ts`, `apps/operator-cli/src/disc-selection.test.ts`, `apps/operator-cli/src/catalog-review-completion.test.ts`, `apps/operator-cli/src/rearchive-acceptance.test.ts`, `apps/web/test/browser/catalog-review.e2e.ts`, `apps/web/test/browser/encode-jobs.e2e.ts` |
| Durable background work, bounded waits, restart observation, and prior provenance | `apps/web/app/api/operations/route.ts` and the work-specific routes above | `rip-dvd inspect`, `rip-dvd wait` for Disc Inspections, Archive Requests, Archive Jobs, Encode Jobs, Archive Audits, and Filesystem Verifications | `apps/operator-cli/src/command.test.ts`, `apps/operator-cli/src/full-operator-parity.integration.test.ts`, `scripts/smoke-operator-cli.sh` |
| Connected diagnosis, recovery, fresh preservation, review, acceptance, and replacement | The preservation, Catalog Review, and encoding routes above | Supported `rip-dvd` request, inspect, retry, review, acceptance, and encoding commands | `apps/operator-cli/src/full-operator-parity.integration.test.ts` |
<!-- capability-inventory:end -->

`pnpm test:browser` builds every workspace package imported by the production
Next build before starting Playwright. This is intentional. A browser pass that
depends on stale `dist` output is not a valid parity result.
