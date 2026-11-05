#!/usr/bin/env bash
# deploy-node.sh — run the capture pipeline ON another machine.
#
# Why: rendering on a remote node over a CDP tunnel costs 10-200x more than the
# drawing itself (the screenshot travels over SSH). The fast way to use a
# stronger machine is to copy the repository there and run the same tool
# locally on that node.
#
#   tools/deploy-node.sh user@host [--recipe recipes/x.json] [--out out/x]
#
# What it does:
#   1. copies the repository (source + node_modules/puppeteer-core, no npm
#      install needed on the node) over ssh,
#   2. runs `node tools/capture.mjs` there with the node's own Chrome,
#   3. copies the frames back.
#
# Requirements on the node: ssh access, Google Chrome, node (nvm is fine).
# ffmpeg is optional — without it the node writes frames only and the mp4 is
# assembled on this machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: tools/deploy-node.sh user@host [--recipe r.json] [--out dir]" >&2; exit 2; }
shift || true

RECIPE="recipes/ct-anatomy-vertical.json"
OUT=""
IDENTITY="${GLB_SSH_IDENTITY:-$HOME/.ssh/id_ed25519_vps_to_mac}"
while [ $# -gt 0 ]; do
  case "$1" in
    --recipe) RECIPE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Without IdentitiesOnly=yes ssh offers every key of the agent and the mac
# machines drop us with "Too many authentication failures".
SSH_OPTS=(-o IdentitiesOnly=yes -o BatchMode=yes)
[ -f "$IDENTITY" ] && SSH_OPTS+=(-i "$IDENTITY")
SSH=(ssh "${SSH_OPTS[@]}")
SCP=(scp "${SSH_OPTS[@]}")

REMOTE_HOME="$("${SSH[@]}" "$TARGET" 'echo $HOME')"
REMOTE_DIR="$REMOTE_HOME/glb-pipeline"
REMOTE_OUT="$REMOTE_DIR/out/$(basename "${OUT:-node-render}")"

echo "deploy: copying the pipeline to $TARGET:$REMOTE_DIR"
tar --exclude=./out --exclude=./.git -czf - -C "$ROOT" . \
  | "${SSH[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR' && tar -xzf - -C '$REMOTE_DIR'"

echo "deploy: rendering on the node"
 "${SSH[@]}" "$TARGET" "cd '$REMOTE_DIR' && (export PATH=\$HOME/.nvm/versions/node/v24.19.0/bin:\$PATH; node tools/capture.mjs --recipe '$RECIPE' --out '$REMOTE_OUT' --workers 4)"

LOCAL_OUT="$ROOT/${OUT:-out/node-render}"
mkdir -p "$LOCAL_OUT"
echo "deploy: copying frames back"
 "${SCP[@]}" -r "$TARGET:$REMOTE_OUT/." "$LOCAL_OUT/"
echo "deploy: done -> $LOCAL_OUT"
