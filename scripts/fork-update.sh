#!/bin/bash
# Keeps this fork on top of upstream T3 Code and reinstalls the app.
#
#   scripts/fork-update.sh
#
# The LaunchAgent com.romilbijarnia.t3code-fork-update runs it every morning
# from the clone below. It works only in that clone, so a checkout someone is
# editing is never touched:
#
#   1. fetch the fork and upstream; stop if the installed app is current
#   2. merge upstream/main; Claude Code resolves conflicts if there are any
#   3. typecheck, lint and test; Claude Code fixes what the merge broke
#   4. push romil/apps, then build, sign and install with fork-install.sh
#      (which waits for T3 Code to quit before swapping the app)
#
# Anything it cannot finish leaves the fork's branch untouched on GitHub and
# says why in a notification and in ~/Library/Logs/t3code-fork-update.log.
set -euo pipefail

FORK_URL="https://github.com/romil-bijarnia/t3code.git"
UPSTREAM_URL="https://github.com/pingdotgg/t3code.git"
BRANCH="romil/apps"
CLONE="$HOME/.local/share/t3code-fork/repo"
CONFIG="$HOME/.config/t3code-fork"
INSTALLED_COMMIT_FILE="$CONFIG/installed-commit"
LOCK="$HOME/.local/share/t3code-fork/update.lock"
LOGS="$HOME/.local/share/t3code-fork/logs"

log() { printf '[fork-update %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"T3 Code\"" >/dev/null 2>&1 || true
}

fail() {
  log "stopped: $1"
  notify "Update stopped: $1"
  exit 1
}

# Claude Code works headless in the clone. It edits files only; this script
# makes every commit, so nothing it writes carries attribution lines.
ask_claude() {
  local task="$1" transcript="$2"
  log "asking Claude Code to $task (transcript: $transcript)"
  claude -p "$3" --permission-mode bypassPermissions >"$transcript" 2>&1 || true
}

run_checks() {
  local out="$1"
  {
    pnpm install && pnpm typecheck && pnpm lint &&
      vp run -r --filter '!@t3tools/mobile' test
  } >"$out" 2>&1
}

main() {
  mkdir -p "$(dirname "$LOCK")" "$LOGS"
  if [[ -f "$LOCK" ]] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
    log "another update is running; skipping"
    exit 0
  fi
  echo $$ >"$LOCK"
  trap 'rm -f "$LOCK"' EXIT
  renice -n 10 $$ >/dev/null

  if [[ ! -d "$CLONE/.git" ]]; then
    log "cloning the fork into $CLONE"
    git clone --quiet --branch "$BRANCH" "$FORK_URL" "$CLONE"
    git -C "$CLONE" remote add upstream "$UPSTREAM_URL"
  fi
  cd "$CLONE"
  export PATH="$CLONE/node_modules/.bin:$PATH"

  git fetch --quiet origin "$BRANCH"
  git fetch --quiet upstream main
  git checkout --quiet "$BRANCH"
  # The clone holds no work of its own: anything here came from a run that
  # stopped, so start again from what GitHub has.
  git merge --abort >/dev/null 2>&1 || true
  git reset --quiet --hard "origin/$BRANCH"
  git clean -fdq

  local installed=""
  [[ -f "$INSTALLED_COMMIT_FILE" ]] && installed="$(cat "$INSTALLED_COMMIT_FILE")"
  local incoming
  incoming="$(git rev-list --count HEAD..upstream/main)"
  if [[ "$incoming" -eq 0 && "$installed" == "$(git rev-parse HEAD)" ]]; then
    log "up to date ($(git rev-parse --short HEAD))"
    exit 0
  fi

  local stamp upstream_head
  stamp="$(date +%Y%m%d-%H%M)"
  upstream_head="$(git rev-parse --short upstream/main)"

  if [[ "$incoming" -gt 0 ]]; then
    log "merging $incoming upstream commits (up to $upstream_head)"
    if ! git merge --quiet --no-edit upstream/main >"$LOGS/$stamp-merge.log" 2>&1; then
      local conflicted
      conflicted="$(git diff --name-only --diff-filter=U)"
      [[ -n "$conflicted" ]] || fail "git merge failed; see $LOGS/$stamp-merge.log"
      ask_claude "resolve merge conflicts" "$LOGS/$stamp-resolve.txt" \
        "You are updating Romil's T3 Code fork (branch $BRANCH) with upstream T3 Code. \`git merge upstream/main\` stopped with conflicts in:
$conflicted

Resolve every conflict so upstream's change and the fork's feature both survive. \`git log --oneline upstream/main..HEAD --no-merges\` lists the fork's own commits; read the ones a conflict touches. Remove every conflict marker, keep lockfiles valid (rerun \`pnpm install\` if pnpm-lock.yaml conflicted), and \`git add\` the resolved files. Do not commit, push, or edit anything unrelated."
      local unresolved=""
      unresolved="$(git diff --name-only --diff-filter=U)"
      while IFS= read -r file; do
        [[ -f "$file" ]] && grep -qE '^(<<<<<<<|>>>>>>>)( |$)' "$file" && unresolved+=" $file"
      done <<<"$conflicted"
      [[ -z "$unresolved" ]] ||
        fail "merge conflicts with upstream $upstream_head need a hand ($LOGS/$stamp-resolve.txt)"
      git add -A
      git commit --quiet --no-edit
    fi
  fi

  log "checking"
  if ! run_checks "$LOGS/$stamp-checks.log"; then
    ask_claude "fix failing checks" "$LOGS/$stamp-fix.txt" \
      "Romil's T3 Code fork (branch $BRANCH) was just merged with upstream T3 Code, and the checks now fail. The output is in $LOGS/$stamp-checks.log (pnpm install, typecheck, lint, then tests without the mobile app). Fix the code so they pass, keeping upstream's intent and the fork's features (\`git log --oneline upstream/main..HEAD --no-merges\` lists the fork's commits). Rerun what failed to confirm. Do not commit, push, or skip or delete tests."
    git add -A
    if ! git diff --cached --quiet; then
      git commit --quiet -m "fix: keep the fork building on upstream $upstream_head"
    fi
    run_checks "$LOGS/$stamp-checks-2.log" ||
      fail "checks still fail after merging upstream $upstream_head ($LOGS/$stamp-checks-2.log)"
  fi

  log "pushing $BRANCH"
  git push --quiet origin "$BRANCH"
  gh repo sync romil-bijarnia/t3code --branch main >/dev/null 2>&1 || log "could not sync the fork's main (not needed for the app)"

  log "building"
  bash "$CLONE/scripts/fork-install.sh" >"$LOGS/$stamp-install.log" 2>&1 ||
    fail "build failed ($LOGS/$stamp-install.log)"
  log "$(tail -1 "$LOGS/$stamp-install.log")"
  if [[ "$incoming" -gt 0 ]]; then
    notify "Updated with $incoming upstream changes."
  fi
}

# Everything runs from inside main, which bash reads in full before it starts,
# so a merge that rewrites this file mid-run cannot change what is running.
main "$@"
exit
