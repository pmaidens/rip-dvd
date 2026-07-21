# rip-dvd

`rip-dvd` is a small command-line assistant for archiving DVDs and encoding DVD titles into a Jellyfin-style movie library. It first saves a full-disc ISO as the long-term original backup, records encode jobs in a JSON sidecar, and then encodes from that backup later with `rip-dvd encode`.

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

Finds pending jobs from `.rip-dvd.json` sidecars under the originals library and encodes any job whose final output file does not exist yet. Encoding is written as Matroska to a hidden work file without a media extension, then atomically published at the final `.mkv` path only after HandBrake succeeds. Interrupted encodes therefore remain pending and are retried, and Jellyfin does not see an in-progress `.mkv` filename. The original ISO is never deleted.

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

The sidecar is the durable queue. It is written atomically and records a fingerprint derived from the disc label and complete DVD title map. If an ISO already exists at the intended path, `rip-dvd` reuses it only when that fingerprint and the recorded source path match the inserted disc; otherwise it stops without changing the backup or queue.

A job is pending when its source ISO exists and its final output `.mkv` does not. A job is complete when the final output exists. Failed or interrupted partial files are moved aside with a `.failed` suffix before retrying. The ISO remains as the long-term original backup either way.

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
Docker images and workspace metadata. The supported Node range starts at
22.12.0 because that is the minimum Node 22 release supported by Vite 8.

The shared `@rip-dvd/config` package validates the runtime environment for the web app and both workers. Copy `.env.example` to `.env` when overriding the Docker Compose defaults.

Build and start all three runtimes with:

```bash
docker compose up --build
```

Then open <http://localhost:3000>. Compose stores application data, encoded
media, and original backups in the project-scoped `rip-dvd-data`,
`rip-dvd-media`, and `rip-dvd-originals` named volumes by default. Their mount
points are owned by the non-root runtime user (UID/GID 1000), so the archive
and encode workers can write their outputs without running as root.

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

After building the worker images, exercise their real entry points and output
mounts as the non-root user with a fresh Compose project:

```bash
COMPOSE_PROJECT_NAME=rip-dvd-worker-smoke-$(date +%s) pnpm test:compose-workers
```

The smoke command removes its temporary containers but deliberately retains
the uniquely named volumes for non-destructive inspection.

The archive worker image includes DVD discovery tools and the encode worker image includes HandBrake and ffmpeg. Optical-device passthrough is intentionally not enabled by the scaffold; add the appropriate Linux device mapping when the archive workflow is implemented.

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
- `docker/`: separate runtime image definitions
- `compose.yaml`: local three-service deployment
