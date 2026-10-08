#!/bin/sh
# Lokalny test schematu na czystej bazie Postgresa.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
su postgres -c "dropdb --if-exists magazyn_test && createdb magazyn_test"
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d magazyn_test -f $DIR/supabase-stub.sql"
for f in $DIR/../migrations/*.sql; do su postgres -c "psql -q -v ON_ERROR_STOP=1 -d magazyn_test -f $f"; done
for t in ${@:-test_logic test_base test_pos test_contracts}; do su postgres -c "psql -v ON_ERROR_STOP=1 -d magazyn_test -f $DIR/$t.sql"; done
