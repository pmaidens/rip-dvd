# Browser notifications

Open Notifications for current-browser status, opt-in, opt-out and a test.
On iPhone, open the app in Safari, use Share > Add to Home Screen, then open
that app and enable notifications. Permission is requested only after the
Enable notifications button is tapped. Denied permission must be changed in
browser or system settings. Supporting browsers use the standard Push API.
A trusted HTTPS application origin is required. Localhost is also a browser
secure context for development and automated tests.

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
Later Archive Recovery transitions are integrated separately.

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

Claims have finite ownership and interrupted claims can be reclaimed. Stable
event/subscription identities and display tags reduce repeated logical work and
visible duplicates; push remains best effort. Comprehensive retry, expiry and
concurrent-dispatch policies belong to the follow-up delivery ticket. Automatic
worker update activation belongs to the separate update ticket. The root-scoped
`/sw.js` worker currently only displays supplied payloads and handles safe clicks.
It has no application cache, fetch interception or detail-fetch dependency.

Browser tests use a separate localhost secure context with full Chromium.
Install both Playwright Chromium runtimes with
`pnpm --filter @rip-dvd/web exec playwright install chromium` before running
`pnpm test:browser`. The existing reserved HTTP-host projects still exercise
insecure-origin behavior.
