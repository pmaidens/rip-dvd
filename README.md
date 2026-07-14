# rip-dvd

`rip-dvd` is a small command-line assistant for ripping DVD titles into a Jellyfin-style movie library. It wraps `HandBrakeCLI`, uses `lsdvd` to inspect DVD titles, can optionally look up movie metadata from TMDb, and includes a `join` command for combining ripped part files without re-encoding.

The project is intentionally plain Python with no third-party Python package dependencies. The heavy work is done by system tools such as HandBrake and ffmpeg.

## Requirements

- Python 3.9 or newer
- `HandBrakeCLI`
- `lsdvd`
- `blkid`
- `ffmpeg`
- `ffprobe`
- A DVD device, defaulting to `/dev/sr0`
- A writable movie library, defaulting to `/srv/media/Movies`

On Raspberry Pi OS or Debian-like systems, the system dependencies are typically installed with:

```bash
sudo apt update
sudo apt install git handbrake-cli lsdvd util-linux ffmpeg
```

`git` is only needed to clone or update the checkout. `blkid` is provided by `util-linux`. If you use Jellyfin's bundled ffmpeg, the tool will prefer `/usr/lib/jellyfin-ffmpeg/ffmpeg` and `/usr/lib/jellyfin-ffmpeg/ffprobe` when those files exist.

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
- HandBrake preset: `Fast 480p30`

Override them when needed:

```bash
rip-dvd scan --device /dev/dvd
rip-dvd rip --library /media/movies --preset "Fast 576p25"
```

## Commands

### Interactive Mode

```bash
rip-dvd
```

Scans the disc, shows likely main features and extras, then prompts for what to rip.

### Scan Only

```bash
rip-dvd scan
```

Lists DVD titles, durations, chapter counts, audio streams, subtitle counts, and a rough classification. This does not rip anything.

### Rip the Main Feature

```bash
rip-dvd rip
```

Uses HandBrake's `--main-feature` mode and writes the output under the movie library.

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

Use this after `scan` when the main feature is not the title HandBrake would choose automatically.

### Rip the Main Feature Plus Extras

```bash
rip-dvd extras --extras 2,3,4 --name "Movie Title" --year 2001
```

This rips the main feature first, then writes selected bonus titles into an `extras/` folder inside the movie directory.

You can also pass extras positionally:

```bash
rip-dvd extras 2 3 4 --name "Movie Title"
```

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

The tests cover the pure logic: duration parsing, filename cleanup, `lsdvd` parsing, title selection helpers, rip plan construction, and HandBrake progress parsing. They do not require a DVD drive.

## Project Layout

- `rip-dvd`: executable command wrapper
- `rip_dvd/core.py`: typed data structures and pure parsing/planning logic
- `rip_dvd/external.py`: subprocess, DVD scanning, ffmpeg lookup, and TMDb boundaries
- `rip_dvd/cli.py`: command-line workflow and user interaction
- `rip_dvd/output.py`: logging and prompts
- `tests/test_core.py`: unit tests for the pure logic
