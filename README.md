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

Historical schema-2/3 cutover markers do not contain immutable archive and
queue-state snapshots. Their ordinary retry path therefore fails closed. After
verifying that the bounded surviving sidecars, output files, and ISO objects
still describe the intended cutover state, an operator can explicitly recover
them with `--recover-historical-cutover`; without that flag the importer never
reinterprets their mutable filesystem state.

The command also accepts `RIP_DVD_DATABASE_PATH` and
`RIP_DVD_ORIGINALS_LIBRARY_PATH`, and `--json` emits a machine-readable report.
It recursively reads `.rip-dvd.json` files, imports valid Original Disc
Archives, Disc Selections, Media Items, Encoding Profiles, and Encode Jobs, and
reports invalid jobs and duplicate records without making their imported jobs
eligible. Partially invalid sidecars leave a repair marker whose next run reads
the live sidecar again, so repaired jobs omitted from the first snapshot can be
captured. If any sidecar is wholly corrupt, oversized, missing its archive, or
otherwise cannot be represented in the cutover snapshot, the command leaves
the entire legacy queue active; after that sidecar is repaired, re-running the
command imports the complete bounded inventory. Encode Job completion is
inferred from the final output file only when the job is first imported.
Re-running the command is safe and preserves every existing SQLite Encode Job
status, output, priority, progress, and error.

Before publishing records from any parseable sidecar, the command atomically
clears catalog review and sets a persistent cutover fence for every related
existing archive, then writes and
synchronizes a `.rip-dvd-sqlite-catalog` cutover marker at the originals-library
root. This makes affected SQLite jobs ineligible before the marker becomes
durable. If marker publication fails, no imported SQLite records are committed
and the staged archives remain pending review. If the process stops after
publication, rerunning the command resumes the idempotent import while the
legacy queue remains inactive. A parser, persistence, transaction, or
captured-source conflict durably changes the marker to `repair`. The repair
marker still disables legacy commands, but a later complete, parseable live
inventory can replace its failed snapshot after the sidecar or archive is
repaired. Every previously captured sidecar must still be present before repair
can retire the marker. Every retry re-fences those captured archives before an
incomplete live inventory can return. The SQLite fence blocks review completion and Encode Job
enqueue, requeue, and claim until the entire captured batch succeeds. Existing
Media Item fields and Disc Selection labels remain SQLite-authoritative even
during initial cutover. Imported catalog
review boundaries are published only after the complete captured batch
validates and only when the archive has not changed since review was staged, so
neither an earlier job nor a concurrent human selection can cross the review
boundary. The marker also records the immutable legacy-job configuration
captured at cutover, so a later retry reports sidecar conflicts without
confusing them with an authoritative SQLite requeue. A legacy schema-1 marker
that lacks that snapshot is preserved, rather than upgraded, whenever SQLite
cannot corroborate every job; the report then requires explicit operator
recovery instead of guessing whether the sidecar changed after cutover. The
importer and legacy archive/encode commands share kernel-held library-scoped
locks: durable cutover
intent prevents new legacy batches from starting, then waits without a
batch-duration timeout for in-flight work to drain. Locks are released by the
operating system after a process crash and do not rely on PIDs or mutable owner
paths. The command never writes the sidecars themselves. The marker makes SQLite
the enforceable queue authority: legacy `interactive`, `rip`, `title`, `extras`,
`queue`, and `encode` commands refuse that library, so use the SQLite catalog
and workers instead.

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

### TypeScript roadmap and implementation frontier

[GitHub issue #5](https://github.com/pmaidens/rip-dvd/issues/5) is the umbrella
PRD for the Dockerized TypeScript application, not an implementation ticket.
Future agents should select the first open child whose listed blockers are
closed, then implement only that child. The intended dependency order is:

1. Runtime and control-plane foundation: [#6](https://github.com/pmaidens/rip-dvd/issues/6)
   → [#7](https://github.com/pmaidens/rip-dvd/issues/7) →
   [#8](https://github.com/pmaidens/rip-dvd/issues/8) →
   [#9](https://github.com/pmaidens/rip-dvd/issues/9).
2. Catalog inputs after the foundation: [#10](https://github.com/pmaidens/rip-dvd/issues/10)
   and [#11](https://github.com/pmaidens/rip-dvd/issues/11), plus drive discovery
   [#12](https://github.com/pmaidens/rip-dvd/issues/12) after #8 and #9.
3. Preservation and review: [#13](https://github.com/pmaidens/rip-dvd/issues/13)
   after #12, then [#14](https://github.com/pmaidens/rip-dvd/issues/14) after
   #10 and #13.
4. Encoding: [#15](https://github.com/pmaidens/rip-dvd/issues/15) after #11 and
   #14, then [#16](https://github.com/pmaidens/rip-dvd/issues/16) after #9 and
   #15.
5. Operational safety: [#17](https://github.com/pmaidens/rip-dvd/issues/17)
   after #14 and #16, and [#18](https://github.com/pmaidens/rip-dvd/issues/18)
   after #13 and #16.
6. End-to-end verification: [#19](https://github.com/pmaidens/rip-dvd/issues/19)
   only after #17 and #18.

Issue #19 is the finishing frontier for the current #5 plan. Treat GitHub issue
state and each ticket's **Blocked by** section as authoritative if this list and
the tracker ever diverge.

### Docker Compose deployment

The real-hardware deployment target is a native Linux Docker Engine with the
Docker Compose plugin. Docker Desktop can build and validate the images, but it
does not expose a Linux host optical drive and may ignore Linux block-I/O
scheduling. Stable identity mapping also uses the repository's supported
Node.js 22.23.1 runtime plus host `lsblk` and `udevadm`. Before starting on the
server:

1. Copy `.env.example` to `.env` and set the exact library, bind, and
   trusted-origin values for that host. The `/dev/sr0` and `/dev/sg1` settings
   are backward-compatible single-drive defaults; stable-serial configuration
   below supersedes them at startup.
2. Copy `optical-drives.example.json` to `.local/optical-drives.json`. Replace
   every placeholder with a physical drive's stable serial and choose one as
   `primarySerialNumber`. Identify the numeric host group that can access its
   optical block and SCSI-generic nodes and set `RIP_DVD_OPTICAL_DEVICE_GID` to
   that GID.
3. Create any bind-mounted Media Library, Original Disc Archive, and backup
   directories. The containers run as UID/GID 1000; grant that identity the
   documented read/write access with ownership, a shared group, or an ACL.
4. Keep the database on the Compose-managed `rip-dvd-data` local volume. SQLite
   is not supported on NFS, SMB, or another network filesystem.

The runtime mount and hardware boundary is deliberately narrow:

| Service | SQLite data | Media Library | Original Disc Archive | Optical device |
| --- | --- | --- | --- | --- |
| web | read/write | read-only verification | read-only verification | none |
| archive worker | read/write | none | read/write | block device read-only; matching SCSI-generic device for CSS authentication |
| encode worker | read/write | read/write | read-only | none |
| migration | read/write | none | none | none |
| backup | read/write for WAL locking | none | none | none |

The web image contains only the Next.js runtime and its traced dependencies. It
does not contain `lsdvd`, HandBrake, ffmpeg, `sqlite3`, or worker hardware
permissions. The archive-worker image adds `lsdvd`, `lsblk`, a statically linked
`libdvdcss` disc reader, `nice`, and `ionice`; the encode-worker image adds
HandBrake, ffmpeg, `nice`, and `ionice`.
The short-lived deployment-tools image owns schema migration and SQLite backup
commands instead of expanding the web image's attack surface.

Use the deployment scripts from the repository root:

```bash
./scripts/update.sh
./scripts/compose-build.sh
./scripts/compose-migrate.sh
./scripts/compose-start.sh
./scripts/compose-backup.sh
./scripts/compose-stop.sh
```

For routine updates on an installed host, run `scripts/update.sh`. It refuses
dirty checkouts, detached HEADs, branches without an upstream, and concurrent
updates. The updater takes an online SQLite backup before using
`git pull --ff-only`, builds the new images while the existing services remain
running, and then uses the normal quiesce, migration, and startup path. It
verifies that the web service is healthy and both workers are running. If
verification fails, it stops all runtime services rather than leaving a partial
deployment running. The checkout and database are not automatically rolled
back; correct the error or follow the documented restore procedure, then rerun
the updater.

The updater runs from a temporary snapshot of itself. This prevents a pull
that changes `scripts/update.sh` from mixing old and new shell instructions in
one update. Run it locally or over SSH from the repository root:

```bash
cd /opt/rip-dvd
./scripts/update.sh
```

`scripts/compose-build.sh` builds the migration, backup, web, archive-worker,
and encode-worker images as separate targets. `scripts/compose-migrate.sh`
stops the web, archive, and encode runtimes before running versioned Drizzle
migrations in a one-shot non-root container; if the bounded stop fails, no DDL
is attempted. `scripts/compose-start.sh` refuses implicit rebuilds, uses that
quiescing migration path, and then starts only the three long-running services.
It also rejects a dashboard bind beyond loopback when
`RIP_DVD_WEB_TRUSTED_ORIGIN` still names a loopback origin, before migration or
runtime startup begins. If startup partially fails, it performs another bounded
stop and returns the original startup failure.
Runtime services remain stopped after a failed migration or startup.
Correct the reported configuration, image, or host
error, verify the services are stopped with `docker compose ps`, and rerun
`scripts/compose-start.sh`. `scripts/compose-stop.sh` stops those services
without removing containers, networks, images, or volumes.

Then open <http://localhost:3000>. Compose keeps SQLite in the project-scoped
`rip-dvd-data` local volume. Media and original archives use project-scoped
`rip-dvd-media` and `rip-dvd-originals` named volumes unless host bind paths are
configured. Container restarts and the provided stop/start scripts preserve all
three volumes. Never run `docker compose down --volumes` for this deployment:
that explicitly deletes the durable SQLite volume and the default library
volumes.

#### SQLite backup and restore expectations

Run `scripts/compose-backup.sh` regularly and before every upgrade. It writes a
timestamped mode-0600 database under `RIP_DVD_BACKUP_HOST_PATH` (`./backups` by
default). The non-root maintenance container has database-volume write access
because a WAL reader may need to create or update SQLite's shared-memory lock
file; its command performs only the SQLite online backup API. The snapshot
includes committed WAL state while the app is running and is published only
after `PRAGMA integrity_check` returns `ok`. Copy those backup files to storage
outside the Docker host and periodically test a restore into a disposable
Compose project.

Stop all three runtime services before restoring. Never restore by copying only
`rip-dvd.sqlite` over a live database: its `-wal` and `-shm` files are part of
the active state. Preserve the current volume first, verify the selected backup
with `PRAGMA integrity_check`, and use SQLite's `.restore` or `.backup` command
from an offline maintenance container to write a fresh database. Treat the old
database, WAL, and shared-memory files as one recovery set. After replacement,
run `scripts/compose-migrate.sh`, verify integrity again, then use
`scripts/compose-start.sh`. Restore is intentionally not automated because it
is destructive; rehearse the host-specific volume recovery procedure before
depending on it.

#### Worker resource priority

The web service retains normal host scheduling. The archive worker defaults to
nice level 10, best-effort I/O priority 7, and `cpu_shares` 512. The encode
worker defaults to nice level 19, idle I/O priority, and `cpu_shares` 128. CPU
shares are relative under contention, not a hard limit. Unsupported `ionice`
requests log a warning and continue with reduced CPU priority.

`compose.linux-priority.yaml` additionally wires `blkio_config.weight` 500 for
archive work and 100 for encode work. Docker fails container startup rather than
ignoring these fields when the cgroup I/O controller is unavailable, so the
portable base does not enable them automatically. After verifying that the
native Linux host's cgroup driver and I/O scheduler expose weight control, set
`RIP_DVD_ENABLE_BLOCK_IO_WEIGHTS=1`; `scripts/compose-start.sh` will include the
override. Leave it disabled on Docker Desktop, rootless Docker, and unsupported
storage drivers. Tune CPU shares and process priorities through `.env`; edit a
reviewed local override if the server needs different block-I/O weights.

The dashboard has no authentication and Compose binds it to `127.0.0.1` by
default. Archive approval requires both the request `Origin` and `Host` to
match `RIP_DVD_WEB_TRUSTED_ORIGIN`, which defaults to
`http://localhost:<RIP_DVD_WEB_PORT>`; the request URL does not establish
authority. To expose the dashboard on a trusted LAN, explicitly set
`RIP_DVD_WEB_BIND_ADDRESS` to the intended interface address and set
`RIP_DVD_WEB_TRUSTED_ORIGIN` to the exact HTTP(S) origin users open, including
its non-default port. This origin check limits cross-site mutation but is not
access control, so do not expose the service to an untrusted network.

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

Original Disc Archives and Encode Jobs have explicit **Verify archive file**
and **Verify output file** actions. A separately paged Filesystem Verification
inventory keeps every known output and archive reachable after it leaves the
bounded operations history or completes catalog review. These actions inspect
only the selected database-recorded path through the read-only library mounts,
then store an accessible, missing, inaccessible, or unexpected-error result
with a verification time in SQLite. The probe runs in a short-lived helper
process with a three-second deadline and a two-helper admission ceiling, so a
stalled mount cannot block the Next.js request event loop or create unbounded
work. Media Library root canonicalization happens inside that bounded explicit
helper; opening the shared data-access facade never touches the Media Library.
The dashboard and SSE snapshots show stored results and normalized, path-free
worker failure reasons without exposing raw diagnostics or paths.
Ordinary dashboard, catalog, and queue reads continue to trust SQLite and never
scan the media or originals libraries implicitly. Verification uses the same
trusted Origin/Host mutation policy as the other dashboard actions and is
exposed at `POST /api/filesystem-verification`; its path-free inventory is read
from `GET /api/filesystem-verification`.

The Catalog page defaults to a paged **Needs review** queue; creating the first
selection does not hide a partially cataloged multi-episode disc. Its bounded
**Reviewed** view keeps completed archives reachable, searches disc labels and
mapped Media Item titles, and filters **Reviewed with selections** from
**Archive only**. Each history result includes the reviewed time, outcome, and a
bounded mapped-item summary. **Review catalog** and **Open review** use the same
workbench, with the archived DVD's complete read-only title map beside editable
Media Items and reviewed Disc Selections.
Media Items support movie, TV show, season, episode, trailer, and bonus-feature
hierarchies. A Disc Selection maps one Media Item to the DVD main feature, one
DVD title, or an inclusive chapter range within a scanned title. Completing
review with selections requires at least one active selection. A disc with no
selections can instead be explicitly completed as **Archive only**, which leaves
the Catalog Review queue without creating encode work. Either completion records
a separate reviewed time; changing or removing a job-free Disc Selection
reopens only that archive before any new encode can be enqueued. Reviewed
history pages use immutable archive identity, so paging remains stable while an
archive moves back to Needs review.
Each archived title exposes Assisted Mapping actions for a movie, bonus
feature, trailer, chapter range, or other content. The editable Mapping
Proposal remains next to that title on desktop and follows it on narrow screens;
it preserves the initiating title while making **Create new Media Item** and
**Use existing Media Item** explicit choices. New-item fields, the chosen
existing identity, source coordinates, and an optional Disc Selection label
remain visible before the Disc Selection is saved atomically. Existing-item
search is a separate non-cacheable, bounded, paged full-catalog read. It shows
ancestor context and may label exact or normalized title suggestions, but never
selects or merges a Media Item automatically. The same bounded search exposes
unused Media Items for maintenance. Before a metadata or hierarchy edit, the
workbench reports how many other archives use that shared item; a successful
edit reports **Metadata saved** and does not reopen any Catalog Review. Mapping
mutations instead report **Mapping changed; review required**. DVD main feature
mapping remains a separate archive-level action.
Bulk episode mapping lets an operator select uncovered DVD titles and provide a
required starting episode number. The initial proposal follows DVD title
number, while every Episode name, Episode number, and optional Disc Selection
label remains editable. The operator explicitly creates or searches for and
reuses the TV Show and Season. Submission creates one Episode and one
whole-title Disc Selection per selected title in a single transaction; a
failure leaves the complete proposal visible and creates none of the batch.
This Assisted Mapping path enforces a TV Show → numbered Season → numbered
Episode shape without adding that restriction to the general Media Item
editor.
New-item titles begin with formatting-only volume-label cleanup: separators
become spaces, whitespace is normalized, and uniformly cased labels receive
conservative title case without removing years, disc identifiers, seasons, or
edition wording.
The facade derives canonical DVD source identities and rejects duplicate source
slices. Supported upgrades reopen caller-era scan-dependent or noncanonical
catalogs and fail their active Encode Jobs until paged validation outside the
SQLite writer lock completes again; unsafe jobs cannot be enqueued, requeued,
or claimed. The review editor
keeps ordinary retry history separate from unsafe legacy recovery:

- **Ordinary retry identity.** A current-valid Disc Selection with any dependent
  Encode Job history, including completed or imported history, cannot be
  repaired or removed. Every job stays attached to that selection; retry or
  re-encode of a terminal row resets the same logical Encode Job.
- **Unsafe legacy quarantine.** Only a caller-era mapping that fails current
  canonical or archived-scan validation takes the recovery path. Repair or
  removal deactivates the old Disc Selection rather than deleting it; repair
  creates a new active selection identity, while removal creates none. The
  quarantined mapping and every dependent Encode Job remain as history, and the
  catalog returns to explicit review.
- **Retained completed provenance.** Completed Encode Jobs on a quarantined
  mapping remain terminal, retain their selection, profile, and output
  provenance, and continue to reserve their output paths.
- **Released failed-job reservations.** Failed Encode Jobs on a quarantined
  mapping, including jobs failed by the upgrade guard, are permanently
  ineligible. Only their output-path reservations are released, allowing a
  corrected mapping to enqueue a new logical job and reuse the path.

Job-free mappings can still be removed normally, and every catalog change
reopens explicit review. Archived scan
evidence is immutable, while rediscovery may still refresh observation metadata
such as the volume label. Legacy sidecar import cannot restore review across an
unsafe or newly added mapping, and bounded legacy title evidence remains usable
for explicit title/chapter review. The same-origin, non-cacheable workflow pages
large Disc Selection sets while limiting its principal Media Item hierarchy to
mappings for the visible archive plus their bounded ancestor context. Unmapped
global items stay out of the workbench hierarchy but remain discoverable through
`GET /api/media-items`. A Media Item can be deleted only when it is a leaf with
no active or historical Disc Selection references. Deletion never cascades into
children, Disc Selections, or Encode Jobs, and unavailable reasons contain only
bounded catalog counts rather than filesystem paths. Removing a mistaken
job-free Assisted Mapping's selections therefore allows its unused leaves to be
deleted explicitly from the bottom up. Media Item mutations cap parent-child
chains at 32 levels without limiting siblings or the total Media Item count, and
reads fail closed instead of presenting a truncated chain. The review workflow
is exposed at `GET`/`POST /api/catalog-reviews/:archiveId`.

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
uncertain same-path hardware fails closed. When a nonempty stable serial moves
from one `/dev/srN` path to another, reconciliation updates the existing Optical
Drive record rather than creating a new logical drive, preserving its ID and
explicit enabled/disabled authorization. A duplicate observed or stored serial
is ambiguous and aborts reconciliation before persistence.

Compose passes `RIP_DVD_ARCHIVE_DEVICE_PATH` through to the archive worker at
the same container path with read-only device permission. It defaults to
`/dev/sr0`; set the variable to another `/dev/...` path when that is the primary
drive. CSS authentication also requires the matching SCSI-generic node. Set
`RIP_DVD_ARCHIVE_CSS_DEVICE_PATH` (default `/dev/sg1`) to the entry listed in
`/sys/class/block/sr0/device/scsi_generic`. Compose grants that node read-only
device permission; Linux permits the CSS REPORT KEY and SEND KEY authentication
commands without opening access to media-write commands. Compose adds only
`RIP_DVD_OPTICAL_DEVICE_GID` (numeric GID 24 by default) to the non-root archive
user, so set it to the host group that can access both device nodes (often the
`cdrom` group).

For durable mapping, configure hardware identities locally and generate the
automatic Compose override:

```bash
mkdir -p .local
cp optical-drives.example.json .local/optical-drives.json
$EDITOR .local/optical-drives.json
node scripts/optical-drive-mapping.mjs
```

The resolver uses `lsblk` and `udevadm` to identify optical block devices and
the block device's own sysfs `scsi_generic` directory to pair `/dev/srN` with
its actual `/dev/sgN`; numeric suffixes are never assumed to correspond. It
excludes QEMU virtual CD-ROMs and all non-optical block devices, then selects
only the configured stable serials. Serial-less hardware cannot be admitted by
this automatic mapping because its identity cannot be proven.

Generation is deterministic and atomic. Every configured serial must match
exactly one physical optical device and every block device must have exactly
one sysfs SCSI-generic sibling. On missing or ambiguous evidence the command
fails before renaming, leaving an existing working `compose.override.yaml`
unchanged. The generated Compose `!override` list replaces stale mappings,
maps only each selected block/generic pair, and grants read-only device access;
it never exposes all of `/dev`. `scripts/compose-start.sh` reruns the resolver
automatically whenever `.local/optical-drives.json` exists, so the normal
`scripts/update.sh` path refreshes mappings after Linux renumbering before
migration or service restart. `compose.hardware.example.yaml` documents the
generated shape for review.

The repository owns this generic resolver, example schema, reconciliation
policy, and startup integration. Real serials, hypervisor passthrough targets,
host aliases, udev rule instances, the generated override, and service
activation are host-local configuration and must not be committed. The archive
worker can discover and use each explicitly mapped drive while the web and
encode containers retain no device access. This worker does not eject media.

The worker checks for completed current Disc Inspections that match pending
Archive Requests at the configured poll interval capped at five seconds. An
empty drive is a normal state. A long-running inspection or archive holds only
its own drive and one configured concurrency slot, so idle capacity continues
polling other drives. Scanner failures are logged per drive without hiding other
drives. Eligible completed inspections are considered in Archive Request
priority order before a configured concurrency slot starts work. Native copy
capacity matches that worker concurrency, while device-inode locks and durable
job fences prevent overlapping work for the same drive or stale attempt. A
failed discovery does not mark every known drive missing.
Successful DVD
scans store title numbers, durations, chapter counts, bounded per-stream
language/format/channel/source-ID metadata, and a deterministic SHA-256 content
identity over every declared raw-disc byte. The scanner authenticates through
`libdvdcss` but deliberately reads without its decrypt flag, so CSS-protected
discs remain byte-identical to the archived ISO. On SCSI-generic VM passthrough,
a small compatibility bridge sends libdvdcss's CSS authentication exchanges
through the block device's mapped SCSI-generic sibling while all sector reads
stay on the read-only block device. Before trusting a cached scan and
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
a kernel-blocked device operation cannot keep the archive worker alive. Hash
progress is streamed as throttled byte counts without contributing repetitive
lines to the bounded diagnostic buffer; process capacity remains occupied until
the child is confirmed closed.
Reads are shell-free, size-capped, incremental, timed out, and
cancellation-aware. The full-disc hash has an eight-hour ceiling so slow physical
drives can complete while a permanently blocked read remains bounded.
One durable Disc Inspection represents the current insertion and owns metadata
findings, full-content hash progress, retries, and terminal inspection outcome.
It is resumed only while drive identity and Linux media-generation evidence
prove the same insertion. The dashboard nests its indeterminate metadata phase,
determinate byte progress, stabilized rate/ETA, retry state, and safe failure
reason under the Optical Drive.
Manual inspection retry is durable intent: the route leaves the inspection
failed until the worker independently observes the drive again. Matching
media-generation evidence reopens the same inspection and resets only its
consecutive failure budget; changed or removed media never consumes that retry.

Requesting preservation atomically marks a scanned disc approved and creates a
pending Archive Request, not an Archive Job. A completed current inspection is
reused without rehashing. Only when it matches a pending request does the worker
atomically create a claimed running Archive Job attempt, then copy through a bounded
hidden partial path, and publishes the fingerprint-named ISO and its Original
Disc Archive record only after the source and completed image are reverified.
Progress and terminal state are written to SQLite and reach the dashboard over
SSE. Failed attempts move their request to `needs_attention`; manual retry
returns the request to `pending` and the next execution creates another Archive
Job attempt. Cooperative cancellation stops the external copy, records the
attempt `aborted`, and records the request `cancelled`. Failed or interrupted
copies are moved to a `.failed` recovery path. Older attempts remain grouped in
Archive Job history. Before
retrying, the worker examines at most 4,096 entries in the canonical originals
directory for exact same-fingerprint attempt-unique partials, fails closed if
discovery or inode ownership is ambiguous, and quarantines every inactive match
before starting a new copy.
The copy launcher acquires that same device-inode lock before asking data access
to renew the current claim and recheck cancellation. The native reader cannot
open the optical device or create its partial until that under-lock
authorization succeeds, so a stale worker cannot restart external work after
recovery finalizes cancellation.

A fingerprint already stored by an Original Disc Archive, or recorded as a
current content-ID alias for its legacy fingerprint, is shown as **Already
archived**. Matching nonterminal Archive Requests are fulfilled by that
provenance and no duplicate execution attempt starts.

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

The facade exposes catalog operations, Disc Inspections, Archive Requests,
attempt-only Archive Jobs, and the Encode Job queue without exposing Drizzle or
a general transaction API to callers. Request creation owns operator intent;
inspection ownership and job execution use separate lease tokens. The atomic
Archive Job start statement rechecks the completed current inspection, pending
request, approval, enabled/present drive state, and absence of an Original Disc
Archive with the same fingerprint before returning preservation work. It
permits only one running Archive Job for a fingerprint across all Optical
Drives and only one running job on each physical drive. Approval freezes the
reviewed Disc Kind and scan data until approval is revoked. A fingerprint has
one Disc Kind across Optical Drives. Archive publication creates provenance,
marks every observation archived, and records terminal job success in one
transaction. Later rediscovery matches archived
fingerprints across Optical Drives, marks the new observation archived, and
rejects a contradictory Disc Kind.
Legacy DVD imports retain their historical fingerprints and record the current
raw-disc content identity as a compatibility alias. An upgraded catalog whose
alias table has not yet been populated fails current-identity approval, claim,
and publication closed for every unaliased legacy DVD, including records whose
stored size is unknown. A size-bearing detection or publication reconciles
legacy archive files in bounded batches, prioritizing matching sizes. A safe
regular archive with an unknown size is measured and backfilled before hashing;
an archive whose identity cannot be proven requires operator remediation.
Publication rechecks the barrier transactionally before it can create new
provenance.
A worker must let the claim commit and only then start the DVD reader, `lsdvd`,
`HandBrakeCLI`, or any other external process. External process execution must
never occur inside a database transaction.

Claims carry unique attempt tokens, and all running mutations use the job ID,
running state, and token as a compare-and-set guard. Progress reports share a
coalescing policy: persist the first value, then write after one second or a
five-point change, while completion always stores 100% and failure stores the
latest pending value. First-run migrations are serialized with a short-lived
lock beside the database so simultaneous service startup cannot apply the same
migration twice.

Archive claims also carry a bounded one-minute lease. The owning worker renews
it with the same attempt-token compare-and-set guard while copying. Each poll
recovers at most 100 ordinary expired claims into visible failed jobs that must
be explicitly retried. Expired cancellations use a separately bounded,
cursor-rotated recovery pass: they remain pending until cross-process device and
partial ownership checks prove external work inactive; the worker holds the
same device-inode exclusion through the fenced transition that records an
aborted job and cancelled request. Recovery acquires `flock` on the exact
inherited descriptor and retains that descriptor through the synchronous
transition, so acquisition-helper exit cannot silently release the exclusion.
Lock acquisition itself has a bounded deadline. If its helper does not close
after cancellation, the worker destroys and unreferences its handles and
returns the poll; any still-live inherited device descriptor remains visible to
the same-UID `/proc` proof, so later recovery continues to fail closed.
A stale worker cannot renew,
report, fail, or publish a recovered attempt. A timed-out or cancelled DVD read returns control
at its deadline, kills and detaches the child, and retains a device/output
tombstone until the operating system reports the child closed. While that
tombstone remains, retries are rejected and the live partial path is neither
renamed nor quarantined. Across direct worker replacement, the worker also
fails closed while a same-service-UID process still holds the configured device
inode, and each new DVD reader holds a nonblocking exclusive lock on that opened
device inode. Device ownership therefore remains independent of the archive
fingerprint and originals-library root. Publication syncs the copied inode and parent
directory; recovery of an already-complete verified ISO likewise syncs the
final file and then its parent before SQLite can record completion.

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
- **Disc Inspection**: one insertion-scoped metadata and content examination.
- **Archive Request**: durable preservation intent with waiting, attention,
  cancellation, and fulfillment state.
- **Archive Job**: one started preservation attempt with running, completed,
  failed, or aborted status.
- **Encode Job**: queued encoding work with queued, running, completed, and
  failed status, plus Cancelled as a distinct terminal outcome.

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

### Queue Encode Jobs

The operations dashboard's Queue Encode Jobs workspace lists only active Disc
Selections from completed catalog reviews and active DVD video Encoding Profile
versions. Choose one of each and an absolute final `.mkv` path inside
`RIP_DVD_MEDIA_LIBRARY_PATH`. Queueing the same Disc Selection and profile
version again returns the existing logical Encode Job. If that job is failed,
completed, or cancelled, the same request leaves its terminal state and
recorded output unchanged, so a delayed submission retry cannot trigger another
encode. The Encode Jobs dashboard exposes Cancel queued encode for work that has
not started and Request cancellation for running HandBrake work. A running
request is stored and displayed as Cancellation requested until the worker has
stopped the process and quarantined its attempt partial. The dashboard receives
both states through its existing live event stream. Cancellation and completion
compare the running attempt token and status so only one outcome can win, and a
stale attempt cannot publish afterward. Cancelled is rendered separately from
Failed. Cancellation retains the job as history and releases an ordinary job's
output reservation. After a worker restart, an expired cancellation remains
nonterminal until Linux process and open-inode inspection confirms the prior
HandBrake output is inactive; cleanup and ownership release then proceed through
the same token-fenced cancellation transition.
A cancelled re-encode keeps the reservation when it protects an existing final.
Cancelled jobs expose deliberate requeue only while their Disc Selection remains
active and its Catalog Review is complete. The dashboard also exposes explicit
Retry encode and Re-encode actions for failed and completed jobs. An explicit
requeue of a completed job, or of a failed replacement that still owns its prior
final, keeps its authoritative output path and path reservation even if the
retry supplies a different path. A failed job without a retained output may
move to the requested path. Repeated submissions also leave queued and running
rows unchanged.

The queue reserves each final output path for one logical job and keeps the
database uniqueness constraint on Disc Selection plus Encoding Profile version.
The dashboard shows the referenced profile version with queued, running,
cancellation-requested, completed, failed, and cancelled state.
`GET /api/encode-jobs` independently
pages up to 100 eligible Disc Selections with `selectionOffset` and 100 active
DVD video Encoding Profile versions with `profileOffset`; its `page` and
`profilePage` metadata keep every option reachable without an unbounded
response.
`POST /api/encode-jobs` queues or returns the logical job. A trusted
`PATCH /api/encode-jobs` command explicitly cancels queued work, requests safe
cancellation of running work, or requeues an eligible terminal job. Mutations
require the same trusted Origin and Host checks as archive approval.

The encode worker atomically claims up to
`RIP_DVD_ENCODE_WORKER_CONCURRENCY` queued jobs, resolves each job's immutable
Original Disc Archive, Disc Selection, and Encoding Profile version, and runs
`HandBrakeCLI` at the lowest configured process and I/O priority. Main-feature,
DVD-title, and chapter-bounded selections map to HandBrake's documented source
options. Each slot claims its next job as soon as its prior encode settles.
Encode claims have a renewable one-minute lease; every poll recovers a bounded
batch of expired claims into visible failed jobs for explicit retry. HandBrake
scanning, preview, and encoding progress—including percent and ETA—is written
to SQLite and appears through the existing dashboard SSE stream.

Each attempt writes to a hidden claim-scoped partial file. A synced regular
output first records its exact path and claim token with an explicit durable
publication-pending marker. An initial output is hard-linked into its absent
final path without overwrite behavior. A re-encode retains the known-good inode
at its claim-scoped recovery path, hard-links the replacement at a hidden
claim-scoped publication path, then atomically renames that link over the
still-visible final.
Before creating those files, every newly created output-directory entry is
synced from its existing parent down through the leaf directory.
The partial hard link remains until the directory and completed job are durable;
only then is that link removed and its cleanup acknowledged. After a process
crash, the next poll compares the retained final and partial inodes and completes
the matching publication instead of stranding a visible final behind a failed
job. Before filesystem mutation, the publisher persists a claim-scoped
mutation token and holds a process-scoped filesystem lock. Lease recovery and
legacy cutover respect that token; a live paused owner remains authoritative,
while a dead owner's released lock lets reconciliation recover the durable
provenance. Immediately before retaining a known-good final and staging its
atomic replacement, the publisher renews its SQLite claim and persists this
fence, so the commit-to-mutation gap cannot publish stale work.
A publisher must also atomically revoke its current SQLite publication authority
before any failure rollback; an expired publisher leaves the final and durable
provenance for reconciliation. Revoked-publication rollback acquires a
recoverable cleanup lease after re-statting the final and immediately before its
atomic rename, so a stale reconciler cannot move a later accepted retry. Its
claim-derived quarantine path is reconstructible from durable provenance, so a
process killed after the rename can restore an external final moved in the
post-stat syscall gap. Legacy
deterministic partials and ordinary failed attempts are moved with one atomic rename to
collision-resistant `.failed` paths. A timed-out child keeps ownership of its
partial until this worker observes that HandBrake closed it. Expired claims
persist their exact output path and claim
token as cleanup work before becoming retryable; both requeue and reclaim stay
blocked until that partial is reconciled or quarantined. A different worker
cannot trust the expired process's in-memory child registry, so it uses the same
atomic quarantine; any still-open writer remains attached to the quarantined
inode while the next claim receives a distinct partial path.

Re-encoding keeps the prior final visible until the replacement is complete,
durably stages it at a collision-free `.failed` recovery hard link, and
atomically exchanges a claim-scoped replacement link with the public final.
The displaced inode is retained and its post-recovery-link content snapshot is
validated before the cutover is accepted. The in-process native exchange is
treated as an unconditional swap, not compare-exchange: both endpoints are
validated afterward, and a raced public inode is repeatedly restored until a
stable compensating swap is observed. Indeterminate results retain durable
publication provenance. Filesystem staging and identity checks run outside
SQLite writer transactions. Short transactions persist and authenticate the
mutation token around those checks. Completion retains that provenance and the
worker partial through a post-commit identity check; a final changed across the
commit boundary restores the nonaccepted job state for reconciliation instead
of unlinking the worker output. The provisional completed row carries a durable
completion-pending marker, so restart cleanup converts a mismatched tentative
success back to a retryable failure before clearing provenance. A stalled media
mount therefore cannot
monopolize SQLite, while a mismatch still leaves durable recovery authority.
Its claim-scoped recovery path lets crash recovery restore the prior final when
publication did not complete, and any failure after replacement
publication quarantines the replacement and restores that prior final. Only a
completed job first grants replacement ownership, and terminal requeue retains
that job's authoritative output path while replacement ownership survives. Its
filesystem identity is retained through a failed attempt and verified on retry,
while remaining stable across the worker's own rename and hard-link restoration;
a changed final revokes replacement authority. Ordinary failed retries moved to
a new path leave any existing final untouched.
If a new final path appears during an encode, it is also left untouched and the
new partial is quarantined.

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
