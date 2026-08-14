#!/bin/sh
set -eu

LD_LIBRARY_PATH=/usr/local/lib exec /usr/bin/HandBrakeCLI "$@"
