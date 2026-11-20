#!/usr/bin/env bash
# Filters VPS task output before it reaches the (public) GitHub Actions log.
# Usage: <command> | bash scripts/vps/redact.sh "<vps-hostname>"
# Masks: the VPS hostname, IPv4 addresses (except loopback), 0x addresses /
# keys / tx hashes, long hex or token-like strings, credentials in URLs,
# sensitive KEY=value pairs, e-mail addresses and dollar amounts.
HOST="${1:-}"
export REDACT_HOST="$HOST"
exec perl -pe '
  BEGIN { $| = 1; $h = $ENV{REDACT_HOST} // ""; }
  if (length $h) { s/\Q$h\E/<vps>/gi; }
  s#(https?://)[^/\s:@]+:[^/\s@]+@#$1<creds>@#g;
  s/((?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|AUTH|CREDENTIAL|MNEMONIC|SEED)[A-Z0-9_]*\s*[=:]\s*)\S+/$1<redacted>/gi;
  s/0x[0-9a-fA-F]{6,}/0x<redacted>/g;
  s/\b[0-9a-fA-F]{32,}\b/<hex>/g;
  s/\b(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{32,}\b/<token>/g;
  s/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)\d{1,3}(?:\.\d{1,3}){3}\b/<ip>/g;
  s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g;
  s/\$\s?-?\d[\d,]*(?:\.\d+)?/\$<amt>/g;
'
