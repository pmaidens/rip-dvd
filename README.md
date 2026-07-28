# rip-dvd

`rip-dvd` is a small command-line assistant for archiving DVDs and encoding DVD
titles into a Jellyfin-style movie library. The legacy workflow saves a
full-disc ISO, records encode jobs in a JSON sidecar, and processes them with
`rip-dvd encode` until the library is migrated to the SQLite catalog and
workers.

The project is intentionally plain Python with no third-party Python package dependencies. The heavy work is done by system tools such as HandBrake and ffmpeg.

The existing CLI remains available while a Dockerized TypeScript replacement is developed alongside it. The initial workspace contains a Next.js control plane and separate archive and encode worker runtimes.

## Requirements

- Python 3.9 or newer
- `HandBrakeCLI`
- `lsdvd`
- `blkid`
- `ffmpeg`
- `ffprobe`
- `dd`
- A DVD device, defaulting to `/dev/sr0`
- A writable movie library, defaulting to `/srv/media/Movies`
- A writable original-backup library, defaulting to `/srv/media/DVD Originals`

On Raspberry Pi OS or Debian-like systems, the system dependencies are typically installed with:

```bash
sudo apt update
sudo apt install git handbrake-cli lsdvd util-linux ffmpeg
```

`git` is only needed to clone or update the checkout. `blkid` and `dd` are provided by `util-linux` / `coreutils` on typical Debian-like systems. If you use Jellyfin's bundled ffmpeg, the tool will prefer `/usr/lib/jellyfin-ffmpeg/ffmpeg` and `/usr/lib/jellyfin-ffmpeg/ffprobe` when those files exist.

## Quick Start

Clone the repository into a stable install directory on the Raspberry Pi:

```bash
git clone https://github.com/pmaidens/rip-dvd.git ~/.local/share/rip-dvd
```

Install the `rip-dvd` command for your user:

```bash
~/.local/share/rip-dvd/install.sh
```

If this is a shared system and you want the command in `/usr/local/bin`, install the wrapper system-wide:

```bash
sudo ~/.local/share/rip-dvd/install.sh --system
```

Start the interactive assistant:

```bash
rip-dvd
```

The default paths are:

- DVD device: `/dev/sr0`
- Movie library: `/srv/media/Movies`
- Original DVD backups: `/srv/media/DVD Originals`
- HandBrake preset: `Fast 480p30`

Override them when needed:

```bash
rip-dvd scan --device /dev/dvd
rip-dvd rip --library /media/movies --preset "Fast 576p25"
rip-dvd rip --originals-library /media/dvd-originals
```

## Commands

### Interactive Mode

```bash
rip-dvd
```

Scans the disc, shows likely main features and extras, then prompts for what to rip.

The selected work is archived and queued. Encoding does not start automatically.

### Scan Only

```bash
rip-dvd scan
```

Lists DVD titles, durations, chapter counts, audio streams, subtitle counts, and a rough classification. This does not rip anything.

### Rip the Main Feature

```bash
rip-dvd rip
```

Scans the disc, saves a full-disc ISO under the originals library, and queues HandBrake's own main-feature selection for the final movie file. This avoids treating an unusually long decoy, multi-angle title, or episodic title as the movie solely because of its duration.

Provide a manual title and year when disc metadata is missing or unhelpful:

```bash
rip-dvd rip --name "The Matrix" --year 1999
```

Preview the planned command without ripping:

```bash
rip-dvd rip --name "The Matrix" --year 1999 --dry-run
```

### Rip a Specific DVD Title

```bash
rip-dvd title 3 --name "Movie Title" --year 2001
```

Use this after `scan` when you want to override HandBrake's main-feature selection. The full disc is still archived; title `3` is recorded as the title to encode later.

### Rip the Main Feature Plus Extras

```bash
rip-dvd extras --extras 2,3,4 --name "Movie Title" --year 2001
```

This archives the full disc once, then queues the main feature plus selected bonus titles. Extras encode into an `extras/` folder inside the movie directory.

You can also pass extras positionally:

```bash
rip-dvd extras 2 3 4 --name "Movie Title"
```

### Encode Pending Jobs

```bash
rip-dvd queue
```

Shows archived discs and whether each queued title is pending or already encoded.

```bash
rip-dvd encode
```

Before a library is migrated to SQLite, this finds pending jobs from
`.rip-dvd.json` sidecars and encodes any job whose final output does not exist.
Encoding is written as Matroska to a hidden work file without a media extension,
then atomically published at the final `.mkv` path only after HandBrake succeeds.
Interrupted encodes therefore remain pending and are retried, and Jellyfin does
not see an in-progress `.mkv` filename. The original ISO is never deleted.

By default, `encode` lowers CPU and I/O priority when `nice` and `ionice` are available:

```bash
rip-dvd encode --watch --interval 600
```

Use `--watch` to keep checking for newly archived discs, `--limit 1` to process one job and exit, or `--normal-priority` to run without lowering priority.

### Original Backups and Queue State

Each archived disc is stored as a full-disc ISO:

```text
/srv/media/DVD Originals/Movie Title (2001)/Movie Title (2001).iso
```

The adjacent sidecar records the queued encode jobs:

```text
/srv/media/DVD Originals/Movie Title (2001)/Movie Title (2001).rip-dvd.json
```

Before SQLite migration, the sidecar is the durable queue. It is written
atomically and records a fingerprint derived from the disc label and complete
DVD title map. If an ISO already exists at the intended path, `rip-dvd` reuses
it only when that fingerprint and the recorded source path match the inserted
disc; otherwise it stops without changing the backup or queue.

A job is pending when its source ISO exists and its final output `.mkv` does not. A job is complete when the final output exists. Failed or interrupted partial files are moved aside with a `.failed` suffix before retrying. The ISO remains as the long-term original backup either way.

### Import legacy sidecars into SQLite

After configuring the TypeScript application, import an existing originals
library once with:

```bash
pnpm import:legacy-sidecars -- \
  --database /srv/rip-dvd/rip-dvd.sqlite \
  --originals-library "/srv/media/DVD Originals"
```

The command also accepts `RIP_DVD_DATABASE_PATH` and
`RIP_DVD_ORIGINALS_LIBRARY_PATH`, and `--json` emits a machine-readable report.
It recursively reads `.rip-dvd.json` files, imports valid Original Disc
Archives, Disc Selections, Media Items, Encoding Profiles, and Encode Jobs, and
continues past corrupt sidecars, invalid jobs, missing archives, and duplicate
records. Encode Job completion is inferred from the final output file only when
the job is first imported. Re-running the command is safe and preserves every
existing SQLite Encode Job status, output, priority, progress, and error.

Before publishing records from any parseable sidecar, the command atomically
writes and synchronizes a `.rip-dvd-sqlite-catalog` cutover marker at the
originals-library root. If marker publication fails, no imported SQLite records
are committed. If the process stops after publication, rerunning the command
resumes the idempotent import while the legacy queue remains inactive. The
marker also records the immutable legacy-job configuration captured at cutover,
so a later retry reports sidecar conflicts without confusing them with an
authoritative SQLite requeue. The importer and legacy archive/encode commands
share a library-scoped lease: cutover waits for an in-flight legacy batch to
finish, and a new legacy batch waits for cutover and then refuses the marked
library. The command never writes the sidecars themselves. The marker makes
SQLite the enforceable queue authority: legacy `interactive`, `rip`, `title`,
`extras`, `queue`, and `encode` commands refuse that library, so use the SQLite
catalog and workers instead.

### Join Part Files

```bash
rip-dvd join part1.mkv part2.mkv --output "Movie.mkv"
```

The join command uses ffmpeg concat mode with stream copy, so it does not re-encode the files. It leaves the original parts in place unless you pass:

```bash
rip-dvd join part1.mkv part2.mkv --output "Movie.mkv" --delete-parts
```

## Optional TMDb Lookup

Set `TMDB_API_KEY` to let the tool look up a movie title and year from the disc label:

```bash
export TMDB_API_KEY="your-api-key"
rip-dvd rip
```

Manual `--name` and `--year` arguments always take priority.

## Installing as a Command

Because `rip-dvd` imports the local `rip_dvd/` package, do not copy only the `rip-dvd` wrapper into `/usr/local/bin`.

Use the installer from the checked-out repository:

```bash
./install.sh
```

The default install creates `~/.local/bin/rip-dvd`. The wrapper points back to this checkout, so keep the repository directory in place. To install system-wide instead, run:

```bash
sudo ./install.sh --system
```

## Updating

`rip-dvd` does not update itself. Update the checkout directly with Git, then keep using the same installed wrapper:

```bash
cd ~/.local/share/rip-dvd
git pull --ff-only
```

## Testing

Run the unit tests with:

```bash
python3 -B -m unittest discover -s tests
```

The tests cover pure planning logic and CLI workflow boundaries, including archive identity checks, atomic sidecar updates, queue discovery, interrupted encodes, final-file publication, and progress streaming. They do not require a DVD drive.

### TypeScript runtime

Install the workspace dependencies and validate the TypeScript skeleton with:

```bash
pnpm install
pnpm check
pnpm build
```

The TypeScript runtimes use Node.js 22.23.1 and pnpm 11.15.1, matching the
Docker images and workspace metadata. `pnpm check:toolchain` fails unless the
running tools and both Docker stages match those exact project pins; the
supported Node range therefore starts at 22.23.1. When that exact toolchain is
not installed on the host, run the same frozen-install check, database migration
check, tests, and build with `docker compose --profile validation build validation`.

The shared `@rip-dvd/config` package validates the runtime environment for the
web app and both workers. Copy `.env.example` to `.env` when overriding the
Docker Compose defaults. Compose fixes the database and library paths to
`/data/rip-dvd.sqlite`, `/media/movies`, and `/media/originals` so they always
remain inside the declared persistent mounts. Direct, non-Compose launches can
still set those three `RIP_DVD_*_PATH` variables through the shared loader.

Build and start all three runtimes with:

```bash
docker compose up --build
```

Then open <http://localhost:3000>. Compose stores application data, encoded
media, and original backups in the project-scoped `rip-dvd-data`,
`rip-dvd-media`, and `rip-dvd-originals` named volumes by default. Their mount
points are owned by the non-root runtime user (UID/GID 1000), so the archive
and encode workers can write their outputs without running as root.

The web root is an operations dashboard for Optical Drives, Detected Discs,
Archive Jobs, Encode Jobs, and Original Disc Archives needing catalog review.
It reads the shared SQLite source of truth through the data-access facade and
the non-cacheable `/api/dashboard` HTTP route. After that normal HTTP load, the
browser connects to `/api/dashboard/events` for Server-Sent Events. The Next.js
route periodically reads one coherent dashboard snapshot from SQLite, so
Archive Job and Encode Job progress updates reach the existing drive, disc,
queue, and catalog-review sections without workers owning browser connections.
Slow clients retain at most one queued event and receive the latest state after
catching up. EventSource reconnects automatically after interruptions and each
new connection starts with the current database state. If SSE is unavailable,
the HTTP-loaded dashboard and manual Refresh control continue to work. A fresh
database intentionally shows an empty state in each section until workers or
another facade caller record operations; the web app does not infer catalog
state from library files or process streams.

To use host libraries instead, set `RIP_DVD_MEDIA_LIBRARY_HOST_PATH` and
`RIP_DVD_ORIGINALS_LIBRARY_HOST_PATH`. On native Linux, create new bind-source
directories with ownership that matches the container user before starting
Compose:

```bash
sudo install -d -o 1000 -g 1000 -m 0775 .local/media .local/originals
```

Existing library directories should keep their intended ownership; grant UID
1000 write access through their owner, group, or ACL rather than changing them
blindly. The web runtime mounts both libraries read-only, while the archive
worker writes originals and the encode worker writes media.

After building the worker images, exercise their configured image commands and
output mounts as the non-root user with fresh named-volume and bind-mount
Compose projects:

```bash
pnpm test:compose-workers
```

The default `all` mode first checks project-scoped named volumes, then creates
fresh temporary host directories, initializes only those directories to
UID/GID 1000, and checks native-Linux-style bind writes. Run
`sh scripts/smoke-compose-workers.sh named` or replace `named` with `bind` to
exercise one mode directly. Each mode adds collision-resistant entropy to its
project name, including when `COMPOSE_PROJECT_NAME` supplies a readable base,
and refuses to run when Docker already contains resources for the resolved
name. The preflight checks both Compose labels and exact derived resource names
before creating anything.
The smoke command removes only its short-lived write-probe containers and
deliberately retains the worker containers, uniquely named volumes, and
temporary bind directories for non-destructive inspection.

The archive worker image includes `lsblk` and `lsdvd`; the encode worker image
includes HandBrake and ffmpeg. The archive worker discovers Linux block devices
reported as optical drives, records attached/missing and last-seen state in
SQLite, and scans DVDs only in enabled drives. The configured
`RIP_DVD_ARCHIVE_DEVICE_PATH` receives the enabled default when its physical
drive is first proven, including when a configured device alias appears after
the canonical drive. Other new drives are recorded disabled so attaching
temporary hardware does not silently change scanning behavior. A matching
nonempty serial is authoritative continuity evidence even when vendor or model
text changes. Without matching serial proof, a stable hardware identity change
at an existing device path resets the replacement to disabled rather than
inheriting the previous drive's authorization. Retargeting a configured alias
to a different canonical device path consumes the configured default. A new or
identity-changed target is disabled, while an existing identity-stable target
keeps its current enabled/disabled authorization. A drive that disappears may
keep authorization only when the same serial proves continuity when it returns;
uncertain same-path hardware fails closed.

Docker cannot see host optical devices unless they are passed through. Add only
the devices the archive worker should inspect in a local Compose override, for
example:

```yaml
services:
  archive-worker:
    devices:
      - /dev/sr0:/dev/sr0:r
    group_add:
      - "${RIP_DVD_OPTICAL_DEVICE_GID:-24}"
```

Set `RIP_DVD_OPTICAL_DEVICE_GID` to the host group that can read the device
(often the `cdrom` group). The read-only device permission is sufficient for
discovery and scanning; this worker does not eject media.

The worker runs discovery on each configured poll interval. An empty drive is a
normal state. Scanner failures are logged per drive without hiding other drives,
and a failed discovery does not mark every known drive missing. Successful DVD
scans store title numbers, durations, chapter counts, bounded per-stream
language/format/channel/source-ID metadata, and a deterministic SHA-256 content
identity over every declared raw-disc byte. Before trusting a cached scan and
again after a new scan, the worker opens the device read-only and nonblocking.
That open actively asks Linux's optical driver to observe media events before
the worker reads the resulting sysfs generation. A generation change fails the
scan closed so one disc's title map cannot be bound to another disc's
fingerprint. If active generation observation is unavailable, that drive's scan
also fails closed and retries on a later poll. The potentially blocking open is
isolated in a bounded helper process. Timeout or shutdown requests cancellation,
kills and detaches the helper, and retains its per-drive single-flight tombstone
until the child process is confirmed closed. Later polls reuse that tombstone;
capacity is recovered and a fresh retry is admitted only after confirmed close.
Raw-disc open/read/hash work uses the same bounded helper-process lifecycle, so
a kernel-blocked device operation cannot keep the archive worker alive.
Reads are shell-free, size-capped, incremental, timed out, and
cancellation-aware.
Repeated polls update the same Detected Disc. A fingerprint
already present in Original Disc Archives is shown as **Already archived**, and
any obsolete queued Archive Job for that fingerprint is removed by the
data-access facade. Discovery never approves or queues new archive work; those
actions remain explicit later workflows.

The dashboard's HTTP snapshot carries review details. One-second SSE activity
events retain up to 100 live Detected Discs and jobs ahead of 20 terminal-history
records, include every present or enabled Optical Drive plus at most 20 disabled
missing-history drives, and carry no title maps. Bounded relationship rows
preserve labels. The browser
merges unchanged summaries into its cache and reloads HTTP details when a disc
is first observed or rescanned.

## SQLite Catalog and Queues

`@rip-dvd/data-access` is the shared persistence boundary for the web app and
workers. It applies versioned Drizzle migrations when it opens the configured
SQLite file, enables foreign keys, WAL journaling, a 5000 ms busy timeout, and
normal WAL synchronization. Compose stores `/data/rip-dvd.sqlite` in the
persistent `rip-dvd-data` volume.

The facade exposes catalog operations and separate Archive Job and Encode Job
queues without exposing Drizzle or a general transaction API to callers.
Archive Jobs are conditionally enqueued or requeued only while a Detected Disc
is approved;
approval revocation or archive publication removes obsolete queued work in the
same short transaction. The atomic claim statement rechecks both current
approval and the absence of an Original Disc Archive with the same fingerprint
before returning preservation work, and permits only one running Archive Job
for a fingerprint across all Optical Drives. Approval freezes the reviewed Disc
Kind and scan data until approval is revoked. A fingerprint has one Disc Kind
across Optical Drives. Archive publication marks every observation of the
fingerprint archived. Later rediscovery matches archived
fingerprints across Optical Drives, marks the new observation archived, and
rejects a contradictory Disc Kind.
A worker must let the claim commit and only then start `dd`, `lsdvd`,
`HandBrakeCLI`, or any other external process. External process execution must
never occur inside a database transaction.

Claims carry unique attempt tokens, and all running mutations use the job ID,
running state, and token as a compare-and-set guard. Progress reports share a
coalescing policy: persist the first value, then write after one second or a
five-point change, while completion always stores 100% and failure stores the
latest pending value. First-run migrations are serialized with a short-lived
lock beside the database so simultaneous service startup cannot apply the same
migration twice.

DVD title and chapter coordinates in Disc Selections must be positive safe
integers. The facade validates that contract and the SQLite migration also
requires integer storage so direct SQL cannot persist fractional coordinates.
Encoding Profile versions follow the same positive-safe-integer facade contract
and integer-storage database constraint.

The canonical catalog terms are:

- **Optical Drive**: configured or discovered disc-reading hardware.
- **Detected Disc**: a fingerprinted disc observed in an Optical Drive.
- **Original Disc Archive**: the preserved source content, initially a DVD ISO.
- **Media Item**: catalog meaning such as a movie, show, episode, trailer, or
  bonus feature; Media Items may form parent-child hierarchies.
- **Disc Selection**: an explicit source slice from an Original Disc Archive
  mapped to a Media Item.
- **Encoding Profile**: immutable versioned encoding settings within a media
  domain.
- **Archive Job** and **Encode Job**: separate mutable queue records with
  queued, running, completed, and failed lifecycles.

### Encoding Profiles

The operations dashboard includes an Encoding Profiles workspace for DVD video.
Each logical profile starts at version 1 with immutable HandBrake preset and MKV
container settings. Creating a new version inserts the next sequential version
without changing older records, so existing Encode Jobs retain the exact
settings identity they referenced.

One version per media-domain/profile-key pair can be active at a time. New
profiles are active, new versions start inactive, activating a version
atomically deactivates its sibling version, and the active version may be
deactivated without selecting a replacement. The web API exposes the same
workflow at `GET`, `POST`, and `PATCH /api/encoding-profiles`; it is fixed to
the `dvd_video` media domain while the shared facade requires explicit domain
scope for version and activation commands.

Visit `/health` for the visible service/database status or `/api/health` for
the machine-readable health response. Validate schema history with
`pnpm db:check`; the normal `pnpm check` command runs the facade integration
tests against isolated SQLite files.

## Project Layout

- `rip-dvd`: executable command wrapper
- `rip_dvd/core.py`: typed data structures and pure parsing/planning logic
- `rip_dvd/external.py`: subprocess, DVD scanning, ffmpeg lookup, and TMDb boundaries
- `rip_dvd/cli.py`: command-line workflow and user interaction
- `rip_dvd/output.py`: logging and prompts
- `tests/test_core.py`: unit tests for the pure logic
- `tests/test_cli.py`: archive and encode queue workflow regression tests
- `apps/web`: Next.js web control plane
- `apps/archive-worker`: archive-worker process entry point
- `apps/encode-worker`: encode-worker process entry point
- `packages/config`: shared runtime environment loader
- `packages/data-access`: Drizzle schema, versioned migrations, and domain-level SQLite facade
- `packages/worker-runtime`: shared worker heartbeat and signal lifecycle
- `docker/runtime.Dockerfile`: shared multi-target definition for three role-specific images
- `compose.yaml`: local three-service deployment
