#!/usr/bin/env bash
# Fail if an ELF binary requires a glibc symbol version newer than a ceiling.
#
#   check-glibc-ceiling.sh <binary> <max-version>     e.g. ... adsb-pulsar-client 2.36
#
# Uses readelf, which reads ELF for any architecture, so an x86_64 runner can
# check an armv7 or aarch64 binary. A binary built against a newer glibc than
# the target OS ships fails at load time with "GLIBC_2.xx not found" -- this
# catches that in CI instead of on the Pi.
set -euo pipefail

bin=${1:?usage: $0 <binary> <max-glibc-version>}
ceiling=${2:?usage: $0 <binary> <max-glibc-version>}

required=$(readelf --version-info --wide "$bin" \
  | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -uV | tail -n1)

if [[ -z "$required" ]]; then
  echo "error: no GLIBC symbol versions found in $bin (static, or not glibc?)" >&2
  exit 1
fi

highest=$(printf '%s\n%s\n' "$required" "$ceiling" | sort -V | tail -n1)
echo "$bin requires glibc >= $required (ceiling $ceiling)"
if [[ "$highest" != "$ceiling" ]]; then
  echo "error: requires glibc $required, newer than the target's $ceiling" >&2
  exit 1
fi
