# Browser notifications

Open Settings in primary navigation, then Notifications, for current-browser
status, opt-in, opt-out, a test and recent deliveries. Bookmark
`/settings#notifications` to open this section directly. Section links work
after refresh and with browser Back and Forward. Opening Settings or following
a section link never requests permission or enables an opted-out browser.
Existing subscriptions and saved opt-out choices continue to apply.

New test notifications from Settings and the JSON CLI open
`/settings#notifications` directly. The legacy `/notifications` page redirects
there, so bookmarks, queued test notifications and older worker fallbacks still
reach the controls. Operational links under `/notifications/target` retain their
Archive Job or Original Disc Archive details and query parameters. Their
Notification settings link opens the new Settings section.

On iPhone, open the app in Safari, use Share > Add to Home Screen, then open
that app and enable notifications. Permission is requested only after the
Enable notifications button is tapped. Denied permission must be changed in
browser or system settings. Supporting browsers use the standard Push API.
A trusted HTTPS application origin is required. Localhost is also a browser
secure context for development and automated tests.

For private TLS setup, cutover, and rollback, follow
[private HTTPS with Tailscale Serve](operations/private-https.md).

Configure `RIP_DVD_WEB_TRUSTED_ORIGIN`, `RIP_DVD_VAPID_PUBLIC_KEY`,
`RIP_DVD_VAPID_PRIVATE_KEY`, and `RIP_DVD_VAPID_SUBJECT` in the private deployment
environment. Generate the VAPID pair once with
`pnpm --filter @rip-dvd/application exec web-push generate-vapid-keys --json`,
then retain it across deployments and restarts. Use a `mailto:`
contact or HTTPS contact URL as the subject. Keep the private key in private
server configuration. Only the public subscription key is returned to browsers.
Normal inspection never returns subscription endpoints or encryption keys.

The separately managed `notification-worker` service reads the shared SQLite
queue without needing a web request or an Archive Worker. Status reports a
missing or invalid configuration, an insecure origin, or an unavailable
dispatcher. An unavailable dispatcher leaves tests queued for its next pass.
A successful send means that the push service accepted the message. It does
not prove device receipt or display. Disabling a browser prevents later dispatch;
an already accepted provider message cannot be recalled.

All active subscriptions are eligible for future installation events regardless
of which browser or CLI started work. Each event snapshots its recipients.
Registering or re-enabling never replays an earlier event. Browser reconciliation
refreshes subscription data without activating a server-side opt-out. A local
opt-out is retained before removal is attempted and retried on opening.

## JSON CLI

`rip-dvd help notifications` lists options. Commands call the shared application
operations directly, with no HTTP dependency.

```sh
rip-dvd notifications status
rip-dvd notifications subscriptions --limit 25
rip-dvd notifications register --key synthetic-registration --file subscription.json
rip-dvd notifications test --key synthetic-test
rip-dvd notifications deliveries --event-id <event-id> --limit 25
rip-dvd notifications remove --key synthetic-removal --id <subscription-id>
```

Registration input contains `subscription`, the browser PushSubscription JSON,
and `enable`. Set `enable: true` for explicit opt-in or `false` for reconciliation.
Supported push destinations are the HTTPS Apple, Google FCM and Mozilla push
service hosts. Arbitrary HTTPS URLs, credentials, custom ports and local-network
destinations are rejected. Mutation keys replay the same input and reject reuse
for a different operation or input. Subscription removal retains the redacted
inactive record so reconciliation cannot silently enable it again.

## Outcome producers

Archive Job publication and failure record an event in the same SQLite
transaction as the outcome. Ordinary failures, classified read failures and
expired worker claims are covered. Cancellation, cooperative abort, progress
and transient reads do not independently alert. All eligible subscriptions
receive these outcomes, including requests submitted through the JSON CLI.

Each Archive Job attempt has a stable saved or failed event identity. Repeated
publication or failure processing cannot create a second logical event, and
retrying a request creates a new attempt with its own outcome. Push transport
runs independently and cannot revise the Archive Job or saved archive.

Saved alerts with remaining source say so without claiming complete recovery,
structural validity, watchability or encode eligibility. Existing DVD evidence
admission gates remain closed; notifications do not admit new evidence formats.
Confirmed Recovery Stop also queues an event in the transaction that records
`stopped`. Stop intent and `stopping` do not alert. The recovery lifecycle first
settles source commands, writer ownership and checkpoint reconciliation. The
formatter uses that checkpoint's remaining source and the disc label or fallback.
An operator stop with Unrecovered Source is never described as full recovery.
The notification links to the saved archive's current Recovery status, checkpoint,
Unrecovered Source count and action availability.

Each confirmed stop operation has its own event identity. Same-key replay,
repeated Stop, worker restart and reconciliation do not add a second logical
notification. A distinct stop after resumed work can alert again. Delivery
failures leave durable Stop intent, archive evidence, and the completed initial
Archive Job and fulfilled Archive Request unchanged.

Later Archive Recovery completion and committed faults queue their own events
in the owning outcome transaction. Completion requires a committed checkpoint
with no Unrecovered Source. A clean initial save that creates completed Recovery
queues only the Archive Job saved event. Recovery faults include a storage-fault
pause, a failed continuation verification, a failed checkpoint reconciliation,
and an unreconcilable Stop. An attention alert describes the need to inspect
Recovery without claiming a new terminal status. These alerts never change the completed Archive Job or fulfilled
Archive Request.

Recovery event identities distinguish the owning transition and outcome.
Repeated processing reuses that identity. Separate reconciliation attempts and
Stop operations have distinct identities, while explicit Resume creates a new
Recovery attempt that can report a later outcome. Productive passes,
tolerable medium reads, no-progress pauses, generic polling faults, and process
interruption alone do not queue outcome alerts. Transport uses the same
recipient snapshot and dispatcher as Archive Job alerts. Clicking a recovery
notification opens the saved archive's current Recovery status, pause or fault
reason, and remaining-source count. These facts do not authorize encoding or
establish watchability.

The shared contract, formatter and transactional recorder are reused by producers.
`recordNotificationOutcome(writer, outcome)` accepts authoritative facts and a
stable source-event identity, formats a complete version 1 payload and records
it using a writer bound to the producer's existing SQLite outcome transaction.
`createNotificationEventWriter(transaction, now)` does not commit. Pass the
same Drizzle transaction that persists the outcome. A rollback removes the event
and its recipient snapshot together. Never send push or perform network I/O
inside this transaction. The same identity with different facts is a conflict.

Supported facts are archive saved with remaining-source evidence, Archive Job
failure, later recovery completion, committed recovery attention, and confirmed
Recovery Stop with remaining-source evidence. Producers own the qualifying
transitions and their identities. They do not choose recipients, format text or
send push. Archive Integrity is read-completeness evidence, not watchability or
encode authorization. The test command uses the same formatter, queue,
recipient policy, dispatcher, transport and display worker as outcome events.

Each dispatch pass claims at most 20 deliveries, with a 30-second ownership
lease and a 10-second send deadline. Expired leases can be reclaimed after a
restart. Tokens fence stale owners, and each claim consumes one of eight allowed
attempts, including attempts interrupted by a crash. Shutdown stops claiming
and signals the sender. An uncertain in-flight delivery remains leased until
expiry so another worker cannot immediately claim it.

Network errors, timeouts, HTTP 408, throttling and provider 5xx failures retry
after exponential delays starting at five seconds and capped at one hour.
`Retry-After` seconds and HTTP dates may delay the next attempt further. A delay
beyond the 24-hour message lifetime expires the delivery. The remaining lifetime
also sets the push service TTL. HTTP 404 and 410 deactivate the expired
subscription; other permanent rejections fail that delivery without disabling a
valid browser. Disabling cancels queued and retrying work, including claims that
have not finished. A new eligible generation never inherits an earlier delivery.

The Notifications section shows recent queued, retrying, accepted, expired and failed
deliveries. `rip-dvd notifications deliveries` returns the same redacted failure
codes, attempt counts, next attempt times and expiry. Provider response bodies,
endpoints and keys never appear in those diagnostics. Acceptance means only that
the push service accepted the request. Lost responses can cause a retry even
when a provider already accepted the previous send. Stable payloads and
event-specific display tags reduce duplicates but cannot guarantee exactly-once
network delivery or device display.

Dispatch maintenance expires obsolete messages and deletes up to 100 terminal
delivery records and 100 empty events per pass, seven days after completion.
Small identity receipts retain the source identity, payload digest, original
event identity and recipient count after payload cleanup. They prevent repeated
source processing from replaying old events or selecting new recipients.
Inactive subscription records retain opt-out and generation history. Cleanup
does not delete these receipts or opt-outs and never changes source outcomes.

## Worker updates and payload compatibility

The single root-scoped registration always uses `/sw.js`, served as JavaScript
with `Cache-Control: no-cache, max-age=0, must-revalidate`. Registration sets
`updateViaCache: "none"`. Keep this URL, scope and VAPID keys stable across
ordinary deployments. Deploy changed worker bytes through the normal web image
update, then open the app or return an open app to the foreground. Browser code
checks on opening, foreground return and page restoration, at most once per five
minutes in each open page, including failed checks. Repeated subscription status
checks reuse the same registration. No permission prompt is needed to update.

A successfully installed worker calls `skipWaiting`, then claims existing
clients on activation. Open pages continue without an automatic navigation or
reload. Updates preserve the registration and PushSubscription. Do not
unregister, clear browser data or disable/re-enable notifications as an update
procedure. A malformed script or rejected installation leaves the previous
active worker in place, and update-check failures do not block notification
controls. After correcting a failed deployment, a later check can retry.
The [service worker lifecycle specification](https://www.w3.org/TR/service-workers/)
defines activation and replacement behavior.

The worker only displays complete supplied notifications, handles safe clicks
and activates updates. It has no application cache, fetch interception, imported
application code or detail-fetch dependency. Keep update orchestration in the
browser utility and policy, formatting and dispatch in application modules.

Payload version 1 contains `version: 1`, `title`, `label`, `body`, `tag` and a
same-origin `destination`. Keep that contract readable by both the previous and
new worker during deployments and while accepted pushes remain in flight. New
optional fields must not change existing meanings. An incompatible payload
version requires a separate compatibility plan before a producer starts using
it. Missing labels use a generic fallback; malformed or unsupported payloads
show a generic notification. The current worker accepts `/settings#notifications`
and uses it for missing or unsafe destinations. It continues accepting legacy
`/notifications` links. A previous worker receiving a new Settings destination
uses its legacy fallback, which redirects to the same section.
Clicks validate destinations again, reuse a same-origin app window when possible,
and otherwise open one. Already queued and displayed payloads retain their
original destinations, and replaying a test request committed before the update
returns its original result without queuing another delivery.

Browsers control network checks and worker execution. Offline, suspended or
sleeping clients may keep an earlier worker until the browser next runs a
successful check. A deployment cannot guarantee immediate activation on every
device. Physical iPhone delivery testing remains an operator follow-up.

Browser tests use a separate localhost secure context with full Chromium.
Install both Playwright Chromium runtimes with
`pnpm --filter @rip-dvd/web exec playwright install chromium` before running
`pnpm test:browser`. The existing reserved HTTP-host projects still exercise
insecure-origin behavior. The secure notification project selects Chromium's
built-in notification backend with `--disable-features=SystemNotifications` so
native notification-center permissions do not hide browser notifications from
automation. This preserves browser permission and secure-context checks, actual
`showNotification`/`getNotifications`, and service worker lifecycle behavior.

Upgrade browser tests keep an application page open while a test-only proxy
changes the served worker bytes. A frozen version 1 fixture verifies compatibility
with the previous worker. The browser performs installation and activation;
subscription/provider behavior uses the same controlled boundary as test push.
The tests inspect registration identity, subscription data, page lifetime, actual
notification display and click navigation for canonical, legacy and unsafe
destinations, including rejected updates and retained opt-out choices. Worker
checks and activation are browser-only behavior. The shared notification
operations and JSON CLI commands continue to administer subscriptions and
deliveries independently of the browser worker lifecycle.
