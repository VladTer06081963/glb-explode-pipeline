#!/usr/bin/env bash
# Deliver a rendered film to the DaVinci Resolve stage.
#
# Verified rules (2026-11-06, Resolve 18.6.6 free / Mac App Store sandbox):
#   1. Resolve imports only from its allowed roots -> the file MUST land in ~/Movies
#      on the target Mac. Importing the same file from elsewhere returns
#      {"imported": 0} with no error.
#   2. A PNG sequence does NOT decode in this build
#      ("... не удалось правильно декодировать"). Deliver a single video file.
#   3. The project frame rate cannot be changed through the API (SetSetting -> False,
#      readback 24.0), so the source must already be in the project's frame rate.
#      24 fps is the default of a fresh Resolve project.
#   4. The render output takes the PROJECT resolution; FormatWidth/FormatHeight in the
#      render settings are ignored. Set the project resolution first
#      (safe_set_project_settings with restore:false) and create a NEW timeline.
#
# Usage:
#   tools/deliver-to-resolve.sh --film out/anatomy/film.mp4 [--host mac] [--fps 24]
#                               [--name ct-anatomy] [--width 1080] [--height 1920]
set -euo pipefail

FILM=""
HOST="mac"
FPS="24"
NAME="ct-anatomy"
WIDTH="1080"
HEIGHT="1920"
IDENTITY="${IDENTITY:-$HOME/.ssh/id_davinci_mac}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --film)   FILM="$2"; shift 2 ;;
    --host)   HOST="$2"; shift 2 ;;
    --fps)    FPS="$2"; shift 2 ;;
    --name)   NAME="$2"; shift 2 ;;
    --width)  WIDTH="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -f "$FILM" ]] || { echo "no such film: $FILM" >&2; exit 1; }
SSH=(ssh -i "$IDENTITY" -o IdentitiesOnly=yes -o BatchMode=yes "$HOST")

echo "==> transcoding to ${FPS} fps"
TMP="$(mktemp -d)/$NAME-${FPS}fps.mp4"
ffmpeg -y -v error -i "$FILM" -vf "fps=${FPS}" -c:v libx264 -crf 18 -pix_fmt yuv420p "$TMP"

echo "==> delivering to ${HOST}:~/Movies/${NAME}-${FPS}fps.mp4"
"${SSH[@]}" "mkdir -p ~/Movies" >/dev/null
"${SSH[@]}" "cat > ~/Movies/${NAME}-${FPS}fps.mp4" < "$TMP" >/dev/null

PROBE=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames \
  -show_entries format=duration -of default=noprint_wrappers=1 "$TMP")
echo "==> probe:"
echo "$PROBE"

cat <<EOF

Next steps in DaVinci Resolve (through the MCP, args as a JSON STRING):

  1. project_manager.safe_set_project_settings
     {"restore": false, "settings": {"timelineResolutionWidth": "$WIDTH",
                                     "timelineResolutionHeight": "$HEIGHT"}}
  2. media_pool.create_timeline          {"name": "$NAME-v2"}
  3. media_pool.safe_import_media       {"file_path": "~/Movies/${NAME}-${FPS}fps.mp4",
                                         "media_pool_folder": "Master"}
     -> take the clip id from the result
  4. media_pool.append_to_timeline       {"clip_ids": ["<clip id>"]}
  5. render.set_format_and_codec         {"format": "mp4", "codec": "H.264"}
     render.set_settings                  {"settings": {"TargetDir": "~/Movies",
                                                   "CustomName": "$NAME-v2",
                                                   "ExportVideo": true,
                                                   "SelectAllFrames": true}}
     render.add_job -> render.start
  6. render.verify_output                <- the only proof the file exists
EOF
