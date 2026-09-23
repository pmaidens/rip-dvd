#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: ./install.sh [--system] [--bin-dir DIR]

Install the server-local rip-dvd JSON CLI for this Compose deployment.

Options:
  --system       Install to /usr/local/bin instead of ~/.local/bin
  --bin-dir DIR  Install the wrapper into DIR
  -h, --help     Show this help
EOF
}

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target="$repo_dir/rip-dvd"
bin_dir="${HOME:-}/.local/bin"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --system)
            bin_dir="/usr/local/bin"
            ;;
        --bin-dir)
            if [ "$#" -lt 2 ]; then
                echo "install.sh: --bin-dir requires a directory" >&2
                exit 2
            fi
            bin_dir=$2
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "install.sh: unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ ! -x "$target" ]; then
    echo "install.sh: expected executable not found: $target" >&2
    exit 1
fi

if [ -z "$bin_dir" ]; then
    echo "install.sh: could not determine install directory; use --bin-dir DIR" >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "install.sh: docker was not found on PATH" >&2
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "install.sh: the Docker Compose plugin is unavailable" >&2
    exit 1
fi

if ! mkdir -p "$bin_dir" 2>/dev/null; then
    echo "install.sh: could not create $bin_dir" >&2
    if [ "$bin_dir" = "/usr/local/bin" ]; then
        echo "install.sh: try: sudo ./install.sh --system" >&2
    fi
    exit 1
fi

if [ ! -w "$bin_dir" ]; then
    echo "install.sh: $bin_dir is not writable" >&2
    if [ "$bin_dir" = "/usr/local/bin" ]; then
        echo "install.sh: try: sudo ./install.sh --system" >&2
    fi
    exit 1
fi

quote_sh() {
    printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

tmp=$(mktemp "${TMPDIR:-/tmp}/rip-dvd-wrapper.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM

{
    printf '#!/bin/sh\n'
    printf 'exec %s "$@"\n' "$(quote_sh "$target")"
} >"$tmp"
chmod 755 "$tmp"
mv "$tmp" "$bin_dir/rip-dvd"
trap - EXIT HUP INT TERM

echo "Installed rip-dvd wrapper: $bin_dir/rip-dvd"

case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
        echo "Note: $bin_dir is not currently on PATH."
        echo "Add it to your shell PATH or run: $bin_dir/rip-dvd"
        ;;
esac
