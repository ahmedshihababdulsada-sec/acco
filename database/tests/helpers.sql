-- ============================================================================
-- أدوات الاختبار + وصفات العمليات الحساسة (الوصفات هي المرجع لكود NestJS لاحقاً)
-- يتحمل بعد schema.sql. كل شي داخل schema اسمها t، ويندحذف بحذف القاعدة.
-- ============================================================================
drop schema if exists t cascade;
create schema t;

create table t.results (
  id     serial primary key,
  name   text not null,
  ok     boolean not null,
  detail text
);
create table t.ids (name text primary key, id bigint not null);

create function t.i(p_name text) returns bigint language sql stable as
$$ select id from t.ids where name = p_name $$;

create function t.pass(p_name text) returns void language sql as
$$ insert into t.results (name, ok) values (p_name, true) $$;

create function t.fail(p_name text, p_detail text) returns void language sql as
$$ insert into t.results (name, ok, detail) values (p_name, false, p_detail) $$;

-- الجملة لازم تفشل بنفس SQLSTATE المتوقع
create function t.expect_fail(p_name text, p_stmt text, p_state text) returns void
language plpgsql as $$
begin
  execute p_stmt;
  perform t.fail(p_name, 'expected ' || p_state || ' but statement succeeded');
exception when others then
  if sqlstate = p_state then
    perform t.pass(p_name);
  else
    perform t.fail(p_name, 'expected ' || p_state || ' got ' || sqlstate || ': ' || sqlerrm);
  end if;
end $$;

-- الجملة لازم تنجح
create function t.expect_ok(p_name text, p_stmt text) returns void
language plpgsql as $$
begin
  execute p_stmt;
  perform t.pass(p_name);
exception when others then
  perform t.fail(p_name, 'unexpected ' || sqlstate || ': ' || sqlerrm);
end $$;

create function t.check(p_name text, p_cond boolean, p_detail text default null) returns void
language plpgsql as $$
begin
  if coalesce(p_cond, false) then perform t.pass(p_name);
  else perform t.fail(p_name, coalesce(p_detail, 'condition false')); end if;
end $$;

-- ---------------------------------------------------------------- رقم الوصل
-- قفل number_counters داخل المعاملة: الرقم والوصل يثبتان أو يتراجعان سوا
create function t.next_no(p_branch bigint, p_kind text) returns text
language plpgsql as $$
declare v_year smallint := extract(year from clinic_today())::smallint; v_n int;
begin
  insert into number_counters (branch_id, kind, year, last_value) values (p_branch, p_kind, v_year, 1)
  on conflict (branch_id, kind, year) do update set last_value = number_counters.last_value + 1
  returning last_value into v_n;
  return v_year || '-' || lpad(v_n::text, 5, '0');
end $$;

-- ---------------------------------------------------------------- الحجز: وصفة الحد اليومي ورقم التسلسل
-- يرجع seq_no، أو null إذا اليوم ممتلئ. أي خطأ (مثل زيارة فعالة ثانية لنفس الزبون) يتراجع كله.
create function t.book(p_branch bigint, p_customer bigint, p_day date, p_limit int, p_source text default 'cashier')
returns int language plpgsql as $$
declare v_used int; v_seq int;
begin
  insert into booking_days (branch_id, day) values (p_branch, p_day) on conflict do nothing;
  select used_slots into v_used from booking_days where branch_id = p_branch and day = p_day for update;
  if v_used >= p_limit then return null; end if;
  update booking_days set used_slots = used_slots + 1, last_seq = last_seq + 1
   where branch_id = p_branch and day = p_day returning last_seq into v_seq;
  insert into visits (branch_id, customer_id, visit_date, seq_no, source)
  values (p_branch, p_customer, p_day, v_seq, p_source);
  return v_seq;
end $$;

-- إلغاء زيارة: المقعد يرجع، والرقم ما ينعاد
create function t.cancel_visit(p_visit bigint) returns void language plpgsql as $$
declare v visits%rowtype;
begin
  select * into v from visits where id = p_visit for update;
  if v.status not in ('booked','arrived') then return; end if;
  perform 1 from booking_days where branch_id = v.branch_id and day = v.visit_date for update;
  update visits set status = 'cancelled', cancelled_at = now(), cancel_reason = 'test' where id = p_visit;
  update booking_days set used_slots = used_slots - 1 where branch_id = v.branch_id and day = v.visit_date;
end $$;

-- ---------------------------------------------------------------- زبون جاهز بزيارة وخطة وجلسات محجوزة
-- يرجع customer_id. الجلسات كلها على زيارة اليوم.
create function t.setup_customer(p_idx int, p_sessions int) returns bigint
language plpgsql as $$
declare
  v_branch bigint := t.i('branch'); v_doc bigint := t.i('doctor1');
  v_cust bigint; v_visit bigint; v_cons bigint; v_plan bigint; v_item bigint; v_seq int; k int;
  v_day date := clinic_today();
begin
  insert into customers (branch_id, public_code, phone, full_name, source)
  values (v_branch, 'T' || lpad(p_idx::text, 4, '0'), '+96477' || lpad((10000000 + p_idx)::text, 8, '0'), 'زبون تجربة ' || p_idx, 'cashier')
  returning id into v_cust;
  v_seq := t.book(v_branch, v_cust, v_day, 1000);
  select id into v_visit from visits where customer_id = v_cust and visit_date = v_day;
  insert into consultations (branch_id, visit_id, customer_id, doctor_id, status, entered_at, finished_at)
  values (v_branch, v_visit, v_cust, v_doc, 'finished', now(), now()) returning id into v_cons;
  insert into treatment_plans (branch_id, customer_id, consultation_id, doctor_id, status)
  values (v_branch, v_cust, v_cons, v_doc, 'active') returning id into v_plan;
  insert into plan_items (plan_id, service_id, sessions_count, first_session_date)
  values (v_plan, t.i('svc_laser'), greatest(p_sessions, 1), v_day) returning id into v_item;
  for k in 1..p_sessions loop
    insert into treatment_sessions (branch_id, customer_id, plan_item_id, seq_no, status, scheduled_date, doctor_planned_date, visit_id)
    values (v_branch, v_cust, v_item, k, 'booked', v_day, v_day, v_visit);
  end loop;
  return v_cust;
end $$;

-- ---------------------------------------------------------------- الدفع: وصفة قفل الجلسة (الطريقة الصحيحة)
-- يرجع: 'paid' | 'already_paid'. القفل FOR UPDATE على الجلسة، وبعده فحص الحالة.
create function t.pay_session(p_session bigint, p_net bigint) returns text
language plpgsql as $$
declare
  s treatment_sessions%rowtype; v_pay bigint; v_no text; v_shift bigint := t.i('shift1');
begin
  select * into s from treatment_sessions where id = p_session for update;
  if s.status <> 'booked' then return 'already_paid'; end if;
  v_no := t.next_no(s.branch_id, 'receipt');
  insert into payments (branch_id, receipt_no, customer_id, visit_id, shift_id, cashier_id, kind,
                        gross_amount, net_amount, clinic_snapshot)
  values (s.branch_id, v_no, s.customer_id, s.visit_id, v_shift, t.i('cashier1'), 'sessions',
          p_net, p_net, '{"name":"test"}') returning id into v_pay;
  insert into payment_items (payment_id, item_type, session_id, service_id, service_name, list_price, net_amount)
  values (v_pay, 'session', p_session, t.i('svc_laser'), 'ليزر', p_net, p_net);
  insert into payment_tenders (payment_id, method_id, method_name, method_kind, amount)
  values (v_pay, t.i('pm_cash'), 'كاش', 'cash', p_net);
  update treatment_sessions set status = 'paid', version = version + 1 where id = p_session;
  return 'paid';
end $$;

-- نفس الدفع بدون قفل ولا فحص حالة: الفهرس الفريد هو الحارس الوحيد
create function t.pay_session_nolock(p_session bigint, p_net bigint) returns text
language plpgsql as $$
declare
  s treatment_sessions%rowtype; v_pay bigint; v_no text; v_shift bigint := t.i('shift1');
begin
  select * into s from treatment_sessions where id = p_session;
  v_no := t.next_no(s.branch_id, 'receipt');
  insert into payments (branch_id, receipt_no, customer_id, visit_id, shift_id, cashier_id, kind,
                        gross_amount, net_amount, clinic_snapshot)
  values (s.branch_id, v_no, s.customer_id, s.visit_id, v_shift, t.i('cashier1'), 'sessions',
          p_net, p_net, '{"name":"test"}') returning id into v_pay;
  perform pg_sleep(0.2);
  insert into payment_items (payment_id, item_type, session_id, service_id, service_name, list_price, net_amount)
  values (v_pay, 'session', p_session, t.i('svc_laser'), 'ليزر', p_net, p_net);
  insert into payment_tenders (payment_id, method_id, method_name, method_kind, amount)
  values (v_pay, t.i('pm_cash'), 'كاش', 'cash', p_net);
  update treatment_sessions set status = 'paid', version = version + 1 where id = p_session;
  return 'paid';
end $$;

-- وصل جاهز بدون ما يلمس حالة الجلسة (للاختبارات اللي تحتاج وصل بس)
create function t.make_payment(p_customer bigint, p_session bigint, p_net bigint) returns bigint
language plpgsql as $$
declare v_pay bigint;
begin
  insert into payments (branch_id, receipt_no, customer_id, shift_id, cashier_id, kind,
                        gross_amount, net_amount, clinic_snapshot)
  values (t.i('branch'), t.next_no(t.i('branch'), 'receipt'), p_customer, t.i('shift1'), t.i('cashier1'), 'sessions',
          p_net, p_net, '{"name":"test"}') returning id into v_pay;
  insert into payment_items (payment_id, item_type, session_id, service_id, service_name, list_price, net_amount)
  values (v_pay, 'session', p_session, t.i('svc_laser'), 'ليزر', p_net, p_net);
  insert into payment_tenders (payment_id, method_id, method_name, method_kind, amount)
  values (v_pay, t.i('pm_cash'), 'كاش', 'cash', p_net);
  return v_pay;
end $$;

-- ---------------------------------------------------------------- المخزون: صرف بلا قفل (الـ CHECK هو الحارس)
create function t.consume(p_session bigint, p_batch bigint, p_qty numeric) returns text
language plpgsql as $$
declare b material_batches%rowtype;
begin
  select * into b from material_batches where id = p_batch;
  insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, treatment_session_id)
  values (b.branch_id, b.material_id, p_batch, 'consume', -p_qty, b.unit_cost, -round(p_qty * b.unit_cost), p_session);
  return 'ok';
end $$;

-- ---------------------------------------------------------------- الخزنة: مصروف من الخزنة (المصروف والحركة معاملة وحدة)
-- إذا الرصيد ما يكفي، الـ CHECK على safes.balance يفشل والمصروف يتراجع معاه
create function t.spend(p_amount bigint) returns text
language plpgsql as $$
declare v_exp bigint; v_att bigint;
begin
  -- كل مصروف له صورة إثبات خاصة به (فهرس expenses_proof_uq يمنع استخدام صورة لمصروفين)
  insert into attachments (branch_id, kind, storage_key, mime, size_bytes, sha256, uploaded_by)
  values (t.i('branch'), 'expense_proof', 'test/spend-' || gen_random_uuid(), 'image/jpeg', 1000, 'abc', t.i('manager1')) returning id into v_att;
  insert into expenses (branch_id, category_id, amount, expense_date, pay_source, proof_attachment_id, recorded_by)
  values (t.i('branch'), t.i('exp_cat'), p_amount, clinic_today(), 'safe', v_att, t.i('manager1'))
  returning id into v_exp;
  insert into safe_movements (branch_id, direction, amount, kind, expense_id, created_by)
  values (t.i('branch'), 'out', p_amount, 'expense', v_exp, t.i('manager1'));
  return 'ok';
end $$;
