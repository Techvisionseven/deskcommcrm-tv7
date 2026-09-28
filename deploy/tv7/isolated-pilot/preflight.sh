#!/usr/bin/env bash
# Leitura apenas; nunca source do .env, nunca sudo automático.
set -euo pipefail
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$DIR/preflight.py" "$@"
