# Private HTTPS with Tailscale Serve

Use Tailscale Serve on the Docker host to terminate trusted HTTPS and proxy
requests to the existing HTTP web service on host loopback. The iPhone and
other operator devices must have Tailscale access. The examples below use
synthetic names; substitute the host's full MagicDNS name and configured port.

```text
Operator device -> https://dvd-host.example-tailnet.ts.net:443
                -> host Tailscale Serve
                -> http://127.0.0.1:3000 -> Compose web:3000
```

The dashboard is unauthenticated except for optional Browser Viewing Rendition
access, which requires its configured HTTP Basic credentials. TLS encrypts traffic and establishes
browser trust; tailnet grants control who can reach it. Every client granted
access can operate the application. Restrict HTTPS access to intended
operators, keep Funnel disabled for this listener, and keep the backend off
untrusted networks. No public router forwarding or owned domain is required.
See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

## Prepare without interrupting work

Documentation and script changes do not activate TLS. Keep the currently
working origin and external verification URL until an approved cutover.
Changing `RIP_DVD_WEB_TRUSTED_ORIGIN` alone does not make port 3000 speak TLS.
`https://<host>:3000` fails when that port is still plain HTTP.

Before changing the host, inspect its Tailscale version, full DNS name,
MagicDNS and HTTPS settings, existing Serve and Funnel mappings, listener
conflicts, grants, and backend bind. Save the existing mappings and access
configuration privately. Read-only examples:

```sh
tailscale version
tailscale serve status
tailscale serve status --json
tailscale funnel status
docker compose config --environment |
  sed -n '/^RIP_DVD_WEB_BIND_ADDRESS=/p; /^RIP_DVD_WEB_PORT=/p; /^RIP_DVD_WEB_TRUSTED_ORIGIN=/p'
```

Check installed CLI help. Newer Tailscale Services configurations may also
need `tailscale serve get-config --all`. Preserve unrelated mappings; a
blanket `serve reset` would remove them. Serve must run on the same host as
the published loopback port.

Enable MagicDNS and HTTPS certificates if needed. Certificate Transparency
publishes the full certificate hostname. Choose a nonsensitive name before
issuance, then preserve that name and the tailnet DNS suffix. Serve manages
certificate acquisition and renewal. Exported `tailscale cert` files require
separate renewal and installation handling. See
[Tailscale HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates).

## Cut over in a maintenance window

The following steps change the deployment. Wait for Disc Inspection, Archive
Jobs, Archive Recovery, Encode Jobs, and other active work to settle. The
deployment readiness endpoint reports active work. Recheck immediately before
recreating services. Keep SSH and the server-local operator CLI available.

1. Verify a database backup and save the previous local environment, proxy
   mapping, and external verification URL. Preserve all existing Compose
   overrides, library mounts, and hardware settings.
2. Create the private root-path HTTPS mapping, after confirming it does not
   replace another service:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

   The background mapping resumes after daemon or host restart. Verify Serve
   status and that Funnel is off. The full HTTPS hostname uses default port
   443; omit `:3000` from browser URLs. See the
   [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve).
3. Set these access values in the host-local `.env`, using the actual name:

   ```dotenv
   RIP_DVD_WEB_BIND_ADDRESS=127.0.0.1
   RIP_DVD_WEB_PORT=3000
   RIP_DVD_WEB_TRUSTED_ORIGIN=https://dvd-host.example-tailnet.ts.net
   ```

4. Apply the changed environment through the reviewed deployment procedure.
   Container recreation loads the new environment; a simple restart does not.
   `scripts/compose-start.sh` stops all application runtimes and runs migrations
   before starting them, even though HTTPS requires no database migration.
   Run it only within the idle maintenance window. No application rebuild is
   required solely for these environment values.
5. Change any operator-side launcher's external dashboard URL to the canonical
   HTTPS URL. Keep the controller's `healthUrl` and `readinessUrl` on loopback
   HTTP. Confirm both internal health and external TLS before completing the
   cutover.

Serve's HTTP upstream must preserve the external `Host`. Mutations require
that Host and the browser's Origin to match the configured trusted origin.
The application does not substitute `X-Forwarded-Host` for Host. An internal
HTTP request URL is expected behind TLS termination. Preserve Origin and
Fetch Metadata headers as well as the existing CSP and security headers.

## Verify the operator path

From an operator device connected to Tailscale, check the certificate and HTTP
response without bypassing trust checks or following a redirect to another
origin:

```sh
curl --disable --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  https://dvd-host.example-tailnet.ts.net/api/health
curl --disable --fail --silent --show-error --no-buffer --max-time 8 \
  https://dvd-host.example-tailnet.ts.net/api/dashboard/events
```

The SSE command should print successive dashboard events without batching.
Its time limit normally exits with curl code 28 because the stream remains
open. Check foreground reconnection after an application or proxy restart in
the maintenance window. Confirm direct port 3000 is unreachable from both
LAN and tailnet, including IPv6, while local health checks still work.

Verify a reversible operator action through HTTPS and cross-origin rejection
in a disposable environment. Also test preserved security headers. These
checks catch a proxy that loads pages but breaks mutations or live updates.

On the actual iPhone, open the final URL without certificate warnings and
confirm a secure context with Safari inspection when available. Check normal
operation after sleep and Wi-Fi/cellular transitions. Install the notification Home Screen app from this final origin. Use its
explicit Enable notifications and test controls, then check locked-phone
receipt and the click destination. HTTPS alone does not configure VAPID keys
or prove device delivery. Follow [browser notifications](../notifications.md)
for notification configuration, worker updates, and delivery diagnostics.

## Routine updates and upkeep

Treat Serve as host configuration, outside the application update lifecycle.
Routine builds and container recreation preserve its mapping. Deployment
scripts should verify the existing entry point rather than reset mappings,
enable Funnel, reissue certificates, or restart tailscaled automatically.

Internal HTTP health checks and operator-side HTTPS checks answer different
questions. If the latter fails, inspect DNS, the client VPN route, grants,
certificate trust/expiry, Serve status, and backend reachability. An external
HTTPS failure alone is not a reason to stop workers or rerun migrations.
For a controller failure, inspect its reported containment evidence and actual
Compose state before deciding on recovery. Standalone `verify` is read-only.

Keep tailscaled enabled at boot, protect its persistent state and keys, and
monitor external HTTPS availability and certificate expiry separately from
Docker health. Check node-key expiry and grants after account changes.
Rehearse restart persistence during maintenance rather than forcing repeated
production issuance. Retain the full hostname across host replacement.

Before push enrollment, fix the production scheme, full hostname, and port,
plus the manifest identity and service-worker scope. Certificate renewal
and backend port changes can preserve that browser origin. A different
scheme, hostname, or external port requires a new browser registration and
permission/subscription enrollment; redirects cannot transfer that state.
Preserve `/sw.js` and its root scope, VAPID keys, and subscription data during
transport rollout and ordinary upgrades.

## Rollback

Restore the saved local environment and private access configuration during
an idle window, then recreate the web container through the reviewed process.
Restore the operator-side external verification URL at the same time. Disable
only the mapping added for this application using the installed CLI's
matching `off` command, or restore the previous mapping. Preserve unrelated
Serve services, daemon state, database/media volumes, and the HTTPS name.

Keep the previous HTTP path restricted to its trusted network. HTTP can
restore operator access but cannot support remote Web Push. Defer long-lived
HSTS or preload during the first cutover so transport recovery remains simple.
