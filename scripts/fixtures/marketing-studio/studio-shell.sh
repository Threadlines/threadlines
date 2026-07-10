#!/bin/sh

studio_bin="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export THREADLINES_STUDIO_BIN="$studio_bin"

if [ "$1" = "-ilc" ]; then
  exec /bin/zsh -ilc 'export PATH="$THREADLINES_STUDIO_BIN:$PATH"; '"$2"
fi

PATH="$studio_bin:$PATH"
export PATH
exec /bin/zsh "$@"
