#!/bin/sh
set -eu
CTX_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CTX_UPGRADE=0
if [ "${1:-}" = '--upgrade' ]; then CTX_UPGRADE=1; shift; fi
CTX_PREFIX=${1:-"$HOME/.local"}
CTX_VERSION=$("$CTX_ROOT/runtime/bin/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$CTX_ROOT/release-manifest.json")
CTX_DEST="$CTX_PREFIX/share/ctx/$CTX_VERSION"
CTX_BACKUP_SUFFIX="backup-$(date +%Y%m%d%H%M%S)-$$"
if [ -e "$CTX_DEST" ] || [ -e "$CTX_PREFIX/bin/ctx" ] || [ -L "$CTX_PREFIX/bin/ctx" ]; then
  if [ "$CTX_UPGRADE" != 1 ]; then
    echo 'A CTX installation exists. Use ./install.sh --upgrade [prefix] to replace it while retaining a backup.' >&2
    exit 1
  fi
  # Refuse to overwrite another program accidentally.
  if [ ! -f "$CTX_DEST/release-manifest.json" ] || ! grep -q '"product": "ctx"' "$CTX_DEST/release-manifest.json"; then
    echo 'Existing destination is not a recognized CTX release; choose another prefix.' >&2
    exit 1
  fi
  if [ -e "$CTX_PREFIX/bin/ctx" ] && ! grep -q 'share/ctx/' "$CTX_PREFIX/bin/ctx"; then
    echo 'Existing ctx command is not a recognized CTX launcher; choose another prefix.' >&2
    exit 1
  fi
fi
mkdir -p "$CTX_PREFIX/share/ctx" "$CTX_PREFIX/bin"
CTX_STAGE="$CTX_PREFIX/share/ctx/.install-$$"
mkdir "$CTX_STAGE"
cp -R "$CTX_ROOT/." "$CTX_STAGE/"
if [ -e "$CTX_DEST" ]; then mv "$CTX_DEST" "$CTX_DEST.$CTX_BACKUP_SUFFIX"; fi
mv "$CTX_STAGE" "$CTX_DEST"
if [ -e "$CTX_PREFIX/bin/ctx" ] || [ -L "$CTX_PREFIX/bin/ctx" ]; then mv "$CTX_PREFIX/bin/ctx" "$CTX_PREFIX/bin/ctx.$CTX_BACKUP_SUFFIX"; fi
# A relative wrapper preserves prefixes containing spaces and the caller's cwd.
cat > "$CTX_PREFIX/bin/.ctx-$$" <<CTX_LAUNCH
#!/bin/sh
set -eu
CTX_PREFIX=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
exec "\$CTX_PREFIX/share/ctx/$CTX_VERSION/ctx" "\$@"
CTX_LAUNCH
chmod 755 "$CTX_PREFIX/bin/.ctx-$$"
mv "$CTX_PREFIX/bin/.ctx-$$" "$CTX_PREFIX/bin/ctx"
printf 'Installed: %s/bin/ctx\nAdd %s/bin to PATH if necessary. Existing installations were retained with a backup suffix.\n' "$CTX_PREFIX" "$CTX_PREFIX"
