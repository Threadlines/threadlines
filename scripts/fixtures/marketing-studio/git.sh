#!/bin/zsh

real_git=/usr/bin/git
arguments=("$@")
fetch_index=${arguments[(i)fetch]}

if (( fetch_index <= ${#arguments} )); then
  local_remote="$($real_git config --get threadlines.marketing-local-remote 2>/dev/null)"
  if [[ -n "$local_remote" ]]; then
    for (( index = fetch_index + 1; index <= ${#arguments}; index += 1 )); do
      if [[ "${arguments[index]}" == "origin" ]]; then
        arguments[index]="$local_remote"
        break
      fi
    done
  fi
fi

exec "$real_git" "${arguments[@]}"
