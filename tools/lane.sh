#!/usr/bin/env bash
# tools/lane.sh — one isolated lane per Claude Code session.
#
#   lane.sh new <name> [base-ref]   worktree at /opt/hmis-lanes/<name>, branch lane/<name>,
#                                   its own test databases, dependencies installed
#   lane.sh drop <name> [--force]   remove the worktree and drop its databases (branch is kept)
#   lane.sh list                    lanes, their branches, and how far each is from origin/main
#   lane.sh status                  sessions and test runners on the box, and free memory
#   lane.sh gc [--drop]             list (or drop) scratch test databases no live lane owns
#
# WHY. Until 2026-09-02 every session worked in /opt/hmis itself: one working tree, one index,
# one pair of jest databases (hmis_test_1/2), all pushed straight to main. A peer's half-typed
# file was in your lint, its truncate was in your test, its staged file was in your commit.
# A lane is a git worktree OUTSIDE the main checkout, on its own branch, with TEST_DATABASE_URL
# pointing at databases only it uses (test/helpers/db.ts derives the per-worker names from it).
# /opt/hmis stays on main and is the integration checkout: nothing is edited there.
set -euo pipefail

MAIN="${HMIS_MAIN_CHECKOUT:-/opt/hmis}"
LANES_DIR="${HMIS_LANES_DIR:-/opt/hmis-lanes}"
pg_admin() { docker exec hmis-db-1 psql -U hmis -d postgres -v ON_ERROR_STOP=1 -qAt -c "set client_min_messages=warning" "$@"; }

die() { echo "lane.sh: $*" >&2; exit 1; }
need_name() { [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || die "name must be [a-z0-9-], 2-31 chars: '${1:-}'"; }
db_base() { echo "hmis_lane_${1//-/_}"; }

cmd_new() {
  need_name "${1:-}"; local name="$1" base="${2:-origin/main}" dir branch db
  dir="$LANES_DIR/$name"; branch="lane/$name"; db="$(db_base "$name")_test"
  [ -e "$dir" ] && die "$dir already exists (lane.sh drop $name first)"
  mkdir -p "$LANES_DIR"
  git -C "$MAIN" fetch -q origin
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$MAIN" worktree add "$dir" "$branch"
  else
    git -C "$MAIN" worktree add -b "$branch" "$dir" "$base"
  fi
  # env: same secrets as the main checkout, but the lane's own test databases. DATABASE_URL (the
  # dev server's database) stays shared on purpose — tests never touch it, and a seeded dev
  # database is expensive to duplicate. Change it by hand if a lane needs a private dev server.
  if [ -f "$MAIN/apps/core/.env" ]; then
    sed -E "s#^(TEST_DATABASE_URL=postgres://[^/]+/).*#\1$db#" "$MAIN/apps/core/.env" > "$dir/apps/core/.env"
    chmod 600 "$dir/apps/core/.env"
  else
    echo "warning: $MAIN/apps/core/.env missing; copy .env.example yourself" >&2
  fi
  (cd "$dir" && pnpm install --frozen-lockfile --prefer-offline --reporter=silent)
  cat <<MSG

lane '$name' is ready
  worktree : $dir
  branch   : $branch (from $base)
  test db  : $db (+ _1, _2 per jest worker, created on first run)

next:  cd $dir && claude
finish: push the branch, open a PR (gh pr create), let CI gate it, then: tools/lane.sh drop $name
MSG
}

cmd_drop() {
  need_name "${1:-}"; local name="$1" force="${2:-}" dir db
  dir="$LANES_DIR/$name"; db="$(db_base "$name")_test"
  if [ -d "$dir" ]; then
    if [ "$force" != "--force" ] && [ -n "$(git -C "$dir" status --porcelain)" ]; then
      die "$dir has uncommitted changes; commit/push them or pass --force"
    fi
    if [ "$force" != "--force" ] && [ -n "$(git -C "$dir" log --oneline "origin/main..HEAD" 2>/dev/null | head -1)" ] \
       && ! git -C "$dir" rev-parse --verify --quiet "origin/lane/$name" >/dev/null; then
      die "branch lane/$name has commits that were never pushed; push them or pass --force"
    fi
    git -C "$MAIN" worktree remove --force "$dir"
  fi
  git -C "$MAIN" worktree prune
  for suffix in "" _1 _2 _3 _4; do
    pg_admin -c "drop database if exists \"${db}${suffix}\" with (force)" >/dev/null || true
  done
  echo "lane '$name' removed (branch lane/$name kept; delete with: git branch -D lane/$name)"
}

cmd_list() {
  git -C "$MAIN" fetch -q origin || true
  git -C "$MAIN" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{print w, $2}' | while read -r dir ref; do
    local b="${ref#refs/heads/}" ahead behind dirty
    ahead="$(git -C "$dir" rev-list --count origin/main.."$b" 2>/dev/null || echo '?')"
    behind="$(git -C "$dir" rev-list --count "$b"..origin/main 2>/dev/null || echo '?')"
    dirty="$(git -C "$dir" status --porcelain | wc -l)"
    printf "%-40s %-28s +%s/-%s vs origin/main, %s dirty files\n" "$dir" "$b" "$ahead" "$behind" "$dirty"
  done
}

cmd_status() {
  echo "claude sessions on a terminal: $(ps -eo comm,tty | awk '$1=="claude" && $2!="?"' | wc -l)"
  echo "test runners:"; pgrep -af "bin/jest|vitest" | grep -v pgrep | cut -c1-120 | sed 's/^/  /' || true
  free -g | awk 'NR==2{printf "memory: %s GB used, %s GB available of %s\n",$3,$7,$2}'
  echo "lanes:"; cmd_list | sed 's/^/  /'
}

cmd_gc() {
  # Every session that ever pointed TEST_DATABASE_URL at a private name left its databases behind
  # (83 of them on 2026-09-02, each a full 162-table copy). Keep: hmis_dev, hmis_test*, and the
  # databases of lanes that still have a worktree. Everything else is a scratch copy nobody owns.
  local keep="hmis_dev|hmis_test|hmis_prod" name
  for name in $(git -C "$MAIN" worktree list --porcelain | awk '/^branch refs\/heads\/lane\//{sub("refs/heads/lane/","",$2); print $2}'); do
    keep="$keep|$(db_base "$name")_test"
  done
  local stale
  stale="$(pg_admin -c "select datname from pg_database where datname like 'hmis\_%' order by 1" \
    | grep -vE "^($keep)(_[0-9]+)?$" || true)"
  [ -n "$stale" ] || { echo "no stale scratch databases"; return; }
  if [ "${1:-}" = "--drop" ]; then
    for name in $stale; do pg_admin -c "drop database if exists \"$name\" with (force)" >/dev/null; done
    echo "dropped $(echo "$stale" | wc -l) stale scratch databases"
  else
    echo "$stale"; echo "($(echo "$stale" | wc -l) stale; run: lane.sh gc --drop)"
  fi
}

case "${1:-}" in
  new) shift; cmd_new "$@";;
  drop) shift; cmd_drop "$@";;
  list) cmd_list;;
  status) cmd_status;;
  gc) shift; cmd_gc "$@";;
  *) sed -n '2,10p' "$0"; exit 1;;
esac
