#!/bin/bash
# Sync this fork with upstream Craft Agents and rebuild `mod`.
#
#   scripts/fork/sync.sh           update main, rebase every feature branch onto it, rebuild mod
#   scripts/fork/sync.sh --push    the same, then push main, the feature branches and mod to origin
#
# Remotes: `upstream` = https://github.com/craft-ai-agents/craft-agents-oss.git, `origin` = your fork.
# Branch model (see FEATURES.md): main mirrors upstream, each feature lives on its own branch
# based on main, and mod = main + every feature branch merged in the order of FEATURES below.
#
# The script rewrites the feature branches and mod (rebase, reset), so keep your own work on
# other branches. It stops at the first conflict and leaves Git in the middle of the rebase or
# merge: resolve it, finish with `git rebase --continue` / `git merge --continue`, and run the
# script again. Resolutions are recorded (git rerere), so the next rebuild of mod reuses them.

set -euo pipefail

# Merge order of mod. Keep in sync with FEATURES.md.
FEATURES=(
    "feature/custom-skills-sources"
    "feature/lan-remote-server"
    "fix/self-build"
    "feature/fork-branding"
    "fix/gemini-vertex-tool-schemas"
    "feature/custom-tweaks"
    "feature/agents-md-discovery"
    "fork/meta"
)

die() {
    echo "" >&2
    echo "✗ $*" >&2
    exit 1
}

# Lock files conflict whenever two branches change dependencies. Take one side; `bun install`
# afterwards brings bun.lock back in line with package.json.
resolve_lock_files() {
    local side="$1" f
    for f in bun.lock bun.lockb; do
        if grep -qx "$f" <<< "$(git diff --name-only --diff-filter=U)"; then
            git checkout "--$side" -- "$f" && git add -- "$f"
            echo "  ↳ took $side side of $f"
        fi
    done
}

# feature/custom-skills-sources and feature/custom-tweaks both add a field right after
# defaults.workingDirectory in WorkspaceConfig. The right result keeps all of them. Only handled
# when the conflict has the expected shape; anything else is left for you to resolve.
resolve_workspace_types() {
    local branch="$1" file="packages/shared/src/workspaces/types.ts" ours theirs tmp
    [ "$branch" = "feature/custom-tweaks" ] || return 0
    grep -qx "$file" <<< "$(git diff --name-only --diff-filter=U)" || return 0
    ours="$(git show ":2:$file")"
    theirs="$(git show ":3:$file")"
    grep -q "skillsDirectory?: string;" <<< "$ours" || return 0
    grep -q "sourcesDirectory?: string;" <<< "$ours" || return 0
    grep -q "lastSessionWorkingDirectory?: string;" <<< "$theirs" || return 0

    git checkout --ours -- "$file"
    if ! grep -q "lastSessionWorkingDirectory?: string;" "$file"; then
        tmp="$(mktemp)"
        awk '
            { print }
            /^[[:space:]]*workingDirectory\?: string;/ {
                print "    /** Folder last picked in a session, remembered so the next new session starts there."
                print "     *  Cleared on reset, which sends new sessions back to {@link workingDirectory}. */"
                print "    lastSessionWorkingDirectory?: string;"
            }
        ' "$file" > "$tmp"
        cat "$tmp" > "$file"
        rm -f "$tmp"
    fi

    if [ "$(grep -c "skillsDirectory?: string;" "$file")" -eq 1 ] \
        && [ "$(grep -c "sourcesDirectory?: string;" "$file")" -eq 1 ] \
        && [ "$(grep -c "lastSessionWorkingDirectory?: string;" "$file")" -eq 1 ]; then
        git add -- "$file"
        echo "  ↳ merged the WorkspaceConfig fields of both branches"
    else
        git checkout --conflict=merge -- "$file"
    fi
}

rebase_onto_main() {
    local branch="$1"
    git checkout -q "$branch"
    git rebase main && return 0

    # Keep going while the only conflicts are lock files.
    while [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; do
        resolve_lock_files theirs
        [ -z "$(git diff --name-only --diff-filter=U)" ] \
            || die "Conflict while rebasing $branch onto main. Resolve it, run 'git rebase --continue', then run this script again."
        GIT_EDITOR=true git rebase --continue && return 0
    done
}

# Two feature branches can change the same lines (for example the system prompt); the published
# mod already holds how that was resolved. Replay mod's merge commits so rerere learns those
# resolutions (the idea of Git's contrib/rerere-train.sh); rebuilding mod then reuses them.
learn_resolutions_from() {
    local mod_ref="$1" commit
    git rev-parse --verify --quiet "$mod_ref" >/dev/null || return 0
    for commit in $(git rev-list --first-parent --merges "main..$mod_ref"); do
        git checkout -q --detach "$commit^1"
        if ! git merge --no-edit "$commit^2" >/dev/null 2>&1 \
            && [ -s "$(git rev-parse --git-path MERGE_RR)" ]; then
            git checkout -q "$commit" -- .
            git rerere >/dev/null
            echo "  learned $(git log -1 --format='%s' "$commit")"
        fi
        git reset -q --hard
    done
}

merge_into_mod() {
    local branch="$1"
    git merge --no-edit "$branch" && return 0

    resolve_lock_files theirs
    resolve_workspace_types "$branch"
    [ -z "$(git diff --name-only --diff-filter=U)" ] \
        || die "Conflict while merging $branch into mod. Resolve it, run 'git merge --continue', then run this script again (the resolution is reused)."
    GIT_EDITOR=true git merge --continue
}

# same_build <commit> <ref...>: <commit> has the tree of HEAD, contains every ref, and has no commit of
# its own besides merges. The mod just rebuilt then differs from it only in the merge commits' dates.
same_build() {
    local old="$1" ref
    shift
    [ "$(git rev-parse "$old^{tree}")" = "$(git rev-parse "HEAD^{tree}")" ] || return 1
    for ref in "$@"; do
        git merge-base --is-ancestor "$ref" "$old" || return 1
    done
    [ -z "$(git rev-list --no-merges "$old" --not "$@")" ]
}

main() {
    local push=false branch old_mod
    case "${1:-}" in
        "") ;;
        --push) push=true ;;
        -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac

    cd "$(git rev-parse --show-toplevel)"
    git remote get-url upstream >/dev/null 2>&1 \
        || die "No 'upstream' remote. Add it: git remote add upstream https://github.com/craft-ai-agents/craft-agents-oss.git"
    git remote get-url origin >/dev/null 2>&1 || die "No 'origin' remote."
    if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ] \
        || [ -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then
        die "A rebase or merge is in progress. Finish it (--continue) or abort it first."
    fi
    git diff --quiet && git diff --cached --quiet || die "You have uncommitted changes. Commit or stash them first."

    git config rerere.enabled true
    git config rerere.autoupdate true

    echo "→ Fetching upstream and origin"
    git fetch upstream
    git fetch origin

    echo "→ main ← upstream/main"
    if git show-ref --verify --quiet refs/heads/main; then
        git checkout -q main
        git merge --ff-only upstream/main \
            || die "main has commits that are not in upstream/main. main must stay a plain copy of upstream."
    else
        git checkout -q -b main upstream/main
    fi

    for branch in "${FEATURES[@]}"; do
        echo "→ Rebasing $branch onto main"
        if ! git show-ref --verify --quiet "refs/heads/$branch"; then
            git branch --quiet --track "$branch" "origin/$branch" \
                || die "Branch $branch not found locally or on origin."
        fi
        rebase_onto_main "$branch"
    done

    echo "→ Learning conflict resolutions from origin/mod"
    learn_resolutions_from origin/mod

    echo "→ Rebuilding mod = main + ${#FEATURES[@]} branches"
    old_mod="$(git rev-parse -q --verify refs/heads/mod || git rev-parse -q --verify refs/remotes/origin/mod || true)"
    git checkout -q -B mod main
    for branch in "${FEATURES[@]}"; do
        echo "  merge $branch"
        merge_into_mod "$branch"
    done
    # Nothing changed: keep the previous mod, so its SHA stays and --push has nothing to force-push.
    if [ -n "$old_mod" ] && same_build "$old_mod" main "${FEATURES[@]}"; then
        git reset -q --hard "$old_mod"
        echo "  = same content as before, keeping mod at ${old_mod:0:8}"
    fi

    if [ "$push" = true ]; then
        echo "→ Pushing to origin"
        git push origin main
        git push --force-with-lease origin "${FEATURES[@]}" mod
    fi

    echo ""
    echo "✓ mod is up to date with upstream."
    echo "  Next: bun install (commit bun.lock on the branch that changed it if it moved), then"
    echo "  bun run typecheck:all and bun test."
    [ "$push" = true ] || echo "  Push with: scripts/fork/sync.sh --push"
}

# Everything runs from main() so Bash has read the whole script before checkouts replace it.
main "$@"
exit
