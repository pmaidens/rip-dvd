#!/bin/sh

set -eu

nice_level="${RIP_DVD_WORKER_NICE_LEVEL:-}"
ionice_class="${RIP_DVD_WORKER_IONICE_CLASS:-}"
ionice_level="${RIP_DVD_WORKER_IONICE_LEVEL:-}"

case "$nice_level" in
  0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19) ;;
  *)
    printf 'RIP_DVD_WORKER_NICE_LEVEL must be an integer from 0 to 19\n' >&2
    exit 1
    ;;
esac
case "$ionice_level" in
  0|1|2|3|4|5|6|7) ;;
  *)
    printf 'RIP_DVD_WORKER_IONICE_LEVEL must be an integer from 0 to 7\n' >&2
    exit 1
    ;;
esac

case "$ionice_class" in
  2)
    if ! ionice -c 2 -n "$ionice_level" -p "$$"; then
      printf 'Warning: host does not support the requested worker I/O priority; continuing with CPU nice priority only.\n' >&2
    fi
    ;;
  3)
    if ! ionice -c 3 -p "$$"; then
      printf 'Warning: host does not support the requested worker I/O priority; continuing with CPU nice priority only.\n' >&2
    fi
    ;;
  *)
    printf 'RIP_DVD_WORKER_IONICE_CLASS must be 2 (best effort) or 3 (idle)\n' >&2
    exit 1
    ;;
esac

if [ "$#" -eq 0 ]; then
  printf 'Worker command is required\n' >&2
  exit 1
fi

exec nice -n "$nice_level" "$@"
