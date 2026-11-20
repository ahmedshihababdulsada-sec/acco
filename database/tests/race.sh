#!/bin/bash
# اختبارات التزامن: عمليات حقيقية متوازية (جلسات psql منفصلة) على نفس الصفوف.
set -u
PGBIN="${PGBIN:-$HOME/Applications/Postgres.app/Contents/Versions/16/bin}"
DB="${DB:-clinic_test}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
Q() { "$PGBIN/psql" -X -d "$DB" -At -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -c "$1"; }

# par N 'SQL فيه {i}' → ملفات النتائج بـ $TMP/<tag>.<i>.out و .rc
par() {
  local tag="$1" n="$2" sql="$3" i
  for i in $(seq 1 "$n"); do
    ( Q "${sql//\{i\}/$i}" >"$TMP/$tag.$i.out" 2>"$TMP/$tag.$i.err"; echo $? >"$TMP/$tag.$i.rc" ) &
  done
  wait
}
okcount()   { local c=0 f; for f in "$TMP/$1".*.rc; do [ "$(cat "$f")" = "0" ] && c=$((c+1)); done; echo $c; }
errcount()  { local c=0 f; for f in "$TMP/$1".*.rc; do [ "$(cat "$f")" != "0" ] && grep -q "ERROR:  $2" "${f%.rc}.err" && c=$((c+1)); done; echo $c; }
outcount()  { local c=0 f; for f in "$TMP/$1".*.out; do [ "$(tr -d '[:space:]' <"$f")" = "$2" ] && c=$((c+1)); done; echo $c; }
rec() { Q "select t.check('$1', ($2), '${3:-}')" >/dev/null; }

# ---------------------------------------------------------------- سباق 1: آخر الأماكن باليوم
Q "insert into customers (branch_id,public_code,phone,full_name,source)
   select t.i('branch'),'R1-'||g,'+96478200'||lpad(g::text,5,'0'),'سباق '||g,'cashier' from generate_series(1,12) g" >/dev/null
Q "insert into t.ids select 'r1c'||substr(public_code,4), id from customers where public_code like 'R1-%'" >/dev/null
par book 12 "select t.book(t.i('branch'), t.i('r1c{i}'), '2037-07-07', 5)"
S=$(okcount book); FULL=$(outcount book "") ; ERR=$(errcount book '.....')
# المخرج الفارغ (null) = اليوم ممتلئ
rec "سباق حجز: 12 طلب على 5 مقاعد، 5 نجحوا بالضبط" "(select count(*) from visits where visit_date='2037-07-07') = 5"
rec "سباق حجز: التسلسل 1..5 بدون تكرار ولا فجوات" "(select array_agg(seq_no order by seq_no) from visits where visit_date='2037-07-07') = array[1,2,3,4,5]"
rec "سباق حجز: المقاعد المستخدمة 5 وآخر تسلسل 5" "(select used_slots=5 and last_seq=5 from booking_days where day='2037-07-07')"
rec "سباق حجز: الباقين (7) انرفضوا بنظافة (null) بدون أخطاء" "$(printf '%s' "$S") = 12 and $FULL = 7" "ok=$S full=$FULL err=$ERR"

# ---------------------------------------------------------------- سباق 1ب: نفس الزبون من 8 أجهزة
par bookdup 8 "select t.book(t.i('branch'), t.i('r1c1'), '2037-08-08', 5)"
rec "سباق حجز مكرر: زيارة وحدة بس لنفس الزبون واليوم" "(select count(*) from visits where visit_date='2037-08-08' and customer_id=t.i('r1c1')) = 1"
rec "سباق حجز مكرر: الخاسرين رجعوا 23505 وما انحسب مقعد زيادة" "$(errcount bookdup 23505) = 7 and (select used_slots=1 and last_seq=1 from booking_days where day='2037-08-08')" "dup_errors=$(errcount bookdup 23505)"

# ---------------------------------------------------------------- سباق 2: دفعتين لنفس الجلسة (بالقفل)
Q "select t.setup_customer(1101, 1)" >/dev/null
Q "insert into t.ids select 'r2s', id from treatment_sessions where customer_id=(select id from customers where public_code='T1101')" >/dev/null
par paylock 8 "select t.pay_session(t.i('r2s'), 50000)"
rec "سباق دفع (بقفل الجلسة): وصل واحد بس" "(select count(*) from payment_items where session_id=t.i('r2s')) = 1"
rec "سباق دفع (بقفل الجلسة): واحد paid والباقي already_paid بدون أخطاء" "$(outcount paylock paid) = 1 and $(outcount paylock already_paid) = 7 and $(okcount paylock) = 8" "paid=$(outcount paylock paid) already=$(outcount paylock already_paid)"

# ---------------------------------------------------------------- سباق 2ب: نفس الشي بدون قفل: الفهرس الفريد هو الحارس
Q "select t.setup_customer(1102, 1)" >/dev/null
Q "insert into t.ids select 'r2bs', id from treatment_sessions where customer_id=(select id from customers where public_code='T1102')" >/dev/null
par paynolock 8 "select t.pay_session_nolock(t.i('r2bs'), 50000)"
rec "سباق دفع (بدون قفل): الفهرس يمنع التكرار، وصل واحد" "(select count(*) from payment_items where session_id=t.i('r2bs')) = 1 and (select count(*) from payments where customer_id=(select id from customers where public_code='T1102')) = 1"
rec "سباق دفع (بدون قفل): الخاسرين 23505 وما بقى وصل يتيم" "$(errcount paynolock 23505) = 7" "unique_errors=$(errcount paynolock 23505)"

# ---------------------------------------------------------------- سباق 3: صرف النقاط من أجهزة متعددة
Q "select t.setup_customer(1103, 7)" >/dev/null
Q "insert into t.ids select 'r3s'||seq_no, id from treatment_sessions where customer_id=(select id from customers where public_code='T1103')" >/dev/null
Q "insert into t.ids select 'r3c', id from customers where public_code='T1103'" >/dev/null
Q "do \$\$ declare k int; p bigint; begin
     for k in 1..7 loop p := t.make_payment(t.i('r3c'), t.i('r3s'||k), 10000); insert into t.ids values ('r3p'||k, p); end loop;
     insert into points_ledger (customer_id, entry_type, points, payment_id) values (t.i('r3c'), 'earn', 100, t.i('r3p1'));
   end \$\$" >/dev/null
par redeem 6 "insert into points_ledger (customer_id, entry_type, points, payment_id) values (t.i('r3c'), 'redeem', -30, t.i('r3p'||({i}+1)))"
rec "سباق نقاط: رصيد 100 وصرف 30 من 6 أجهزة، 3 ينجحون" "$(okcount redeem) = 3 and $(errcount redeem 23514) = 3 and (select points_balance from customers where id=t.i('r3c')) = 10" "ok=$(okcount redeem) insufficient=$(errcount redeem 23514)"

# ---------------------------------------------------------------- سباق 4: الصرف من الخزنة فوق الرصيد
BEFORE=$(Q "select balance from safes")
par safe 6 "select t.spend(30000)"
rec "سباق خزنة: رصيد $BEFORE وصرف 30,000 من 6 مصاريف، ما يصير سالب" "(select balance from safes) >= 0 and $(okcount safe) = $((BEFORE/30000)) and $(errcount safe 23514) = $((6-BEFORE/30000))" "ok=$(okcount safe) rejected=$(errcount safe 23514)"
rec "سباق خزنة: المصروف الفاشل تراجع كله (ماكو مصروف بدون حركة)" "(select count(*) from expenses e where pay_source='safe' and not exists (select 1 from safe_movements m where m.expense_id=e.id)) = 0"

# ---------------------------------------------------------------- سباق 5: صرف المادة من دفعة تكفي لاثنين بس
QTY=$(Q "select qty_on_hand from material_batches where id=t.i('batch1')")
par stock 6 "select t.consume(t.i('r3s'||{i}), t.i('batch1'), 3)"
rec "سباق مخزون: دفعة $QTY cc وصرف 3 cc من 6 جلسات، ما تنزل تحت الصفر" "(select qty_on_hand from material_batches where id=t.i('batch1')) = $QTY - 3 * $(okcount stock) and (select qty_on_hand from material_batches where id=t.i('batch1')) >= 0 and $(okcount stock) = 2" "ok=$(okcount stock) rejected=$(errcount stock 23514)"

# ---------------------------------------------------------------- سباق 6: نفس مفتاح منع التكرار
par idem 8 "insert into idempotency_keys (actor_type,actor_id,key,endpoint,request_hash) values ('user',99,'same-key','/payments','h1')"
rec "سباق منع التكرار: نفس المفتاح من 8 محاولات، وحدة تنجح" "$(okcount idem) = 1 and $(errcount idem 23505) = 7 and (select count(*) from idempotency_keys where key='same-key') = 1" "ok=$(okcount idem) dup=$(errcount idem 23505)"

# ---------------------------------------------------------------- سباق 7: عرضين متداخلين بنفس اللحظة
par offer 6 "insert into offers (branch_id,service_id,title,percent,start_date,end_date,created_by) values (t.i('branch'),t.i('svc_consult'),'عرض {i}',10+{i},'2038-01-01','2038-01-10',t.i('manager1'))"
# مهم: عند التزامن الحقيقي قيد الـ exclusion يرفض الخاسرين إما 23P01 (تداخل) أو 40P01 (deadlock). كلاهما رفض صحيح
# والنتيجة وحدة، بس كود الخادم لازم يعيد المحاولة عند 40P01 (وبعدها يشوف 23P01).
rec "سباق عروض: 6 عروض متداخلة بنفس اللحظة، واحد بس ينحفظ والباقي مرفوض (23P01 أو 40P01)" "$(okcount offer) = 1 and $(errcount offer 23P01) + $(errcount offer 40P01) = 5 and (select count(*) from offers where start_date='2038-01-01') = 1" "ok=$(okcount offer) overlap=$(errcount offer 23P01) deadlock=$(errcount offer 40P01)"

# ---------------------------------------------------------------- سباق 8: فتح شفت مرتين
Q "insert into users (username,password_hash,full_name,role,branch_id) values ('cashier2','x','كاشير ٢','cashier',t.i('branch'))" >/dev/null
Q "insert into t.ids select 'cashier2', id from users where username='cashier2'" >/dev/null
par shift 6 "insert into shifts (branch_id,cashier_id,opening_float) values (t.i('branch'),t.i('cashier2'),0)"
rec "سباق شفت: فتح شفت لنفس الكاشير 6 مرات، واحد بس" "$(okcount shift) = 1 and $(errcount shift 23505) = 5" "ok=$(okcount shift) dup=$(errcount shift 23505)"
Q "update shifts set status='closed', closed_at=now() where cashier_id=t.i('cashier2')" >/dev/null
