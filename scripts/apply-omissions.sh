#!/bin/bash
#
# Re-drop every path listed in .offshoot-omissions.
#
# THE ONE COMMAND for the conflict a deletion causes. When the template touches
# a file this repo has deleted, the cascade stops with "deleted by us, modified
# by them" and the resolution is always the same: it stays deleted. Run this,
# then commit the merge.
#
#   bash scripts/apply-omissions.sh && git commit
#
# It ALSO runs the dangling-import check before it lets you commit, because the
# omissions are only half of what a cascade into this repo gets wrong. Twice
# now the thing that broke the build merged CLEANLY and reported no conflict at
# all: see scripts/dangling-imports.mjs. This is the moment that check is worth
# a second, so it happens here rather than being remembered.
#
# Idempotent, and safe to run when there is no merge in progress: a path that is
# already absent is left alone and reported as such. It only ever removes paths
# the file names, so it cannot wander.
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIST="$REPO_DIR/.offshoot-omissions"

if [ ! -f "$LIST" ]; then
    echo -e "${RED}✗ No .offshoot-omissions at ${LIST}${NC}"
    exit 1
fi

cd "$REPO_DIR"

removed=0
absent=0

# Comments and blank lines out; everything else is a path.
while IFS= read -r line; do
    path="${line%%#*}"
    # Trim surrounding whitespace without a subshell per line.
    path="$(echo "$path" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$path" ] && continue

    if [ -e "$path" ] || git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
        # `--ignore-unmatch` so a path that is present in the worktree but not in
        # the index (which is exactly the state a conflicted merge leaves) does
        # not abort the run before the rest of the list is handled.
        git rm -q -f --ignore-unmatch "$path"
        rm -f "$path"
        echo -e "${YELLOW}  dropped${NC} $path"
        removed=$((removed + 1))
    else
        absent=$((absent + 1))
    fi
done <"$LIST"

if [ "$removed" -eq 0 ]; then
    echo -e "${GREEN}✓ Nothing to drop: all ${absent} omitted path(s) are already absent.${NC}"
else
    echo -e "${GREEN}✓ Dropped ${removed} path(s); ${absent} were already absent.${NC}"
fi

# THE OTHER HALF, and the one that has actually broken the build. A deletion
# this repo re-applies is the conflict everybody sees; an import left pointing
# at nothing is the hunk nobody does. Non-zero here means the merge is not
# resolved yet, which is why it gates the "now commit" below rather than
# printing after it.
echo
if ! node "$SCRIPT_DIR/check-dangling-imports.mjs"; then
    echo -e "${RED}✗ Resolve those before committing the merge.${NC}"
    exit 1
fi

echo -e "${GREEN}  Now commit the merge.${NC}"
