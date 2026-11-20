#!/bin/bash
# تشغيل كل الاختبارات: يعيد بناء قاعدة clinic_test من schema.sql ثم يشغل الفحوصات.
# الاستخدام: database/tests/run.sh   (السيرفر لازم يكون شغال على المنفذ 5544، شوف README)
set -u
PGBIN="${PGBIN:-$HOME/Applications/Postgres.app/Contents/Versions/16/bin}"
PGPORT="${PGPORT:-5544}"; PGHOST="${PGHOST:-127.0.0.1}"; PGUSER="${PGUSER:-clinic}"; DB="${DB:-clinic_test}"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
export PGPORT PGHOST PGUSER
psql_() { "$PGBIN/psql" -d "$DB" -v ON_ERROR_STOP=1 -q -t -A -o /dev/null "$@"; }

"$PGBIN/dropdb" --if-exists "$DB" && "$PGBIN/createdb" "$DB" || exit 2
psql_ -f "${SCHEMA:-$ROOT/schema.sql}" >/dev/null || { echo "schema.sql failed"; exit 2; }
psql_ -f "$HERE/helpers.sql" || exit 2
psql_ -f "$HERE/fixture.sql" || exit 2
psql_ -f "$HERE/constraints.sql" || exit 2
DB="$DB" PGBIN="$PGBIN" bash "$HERE/race.sh" || exit 2
psql_ -f "$HERE/final.sql" || exit 2

echo
"$PGBIN/psql" -d "$DB" -At -c "select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed, ' || count(*) || ' total' from t.results"
FAILED=$("$PGBIN/psql" -d "$DB" -At -c "select count(*) from t.results where not ok")
if [ "$FAILED" != "0" ]; then
  echo "--- FAILED:"
  "$PGBIN/psql" -d "$DB" -At -F ' | ' -c "select name, detail from t.results where not ok order by id"
  exit 1
fi
