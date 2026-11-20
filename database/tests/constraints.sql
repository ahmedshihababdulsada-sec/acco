-- ============================================================================
-- اختبارات القيود: كل قاعدة عمل لازم تفشل بنفس SQLSTATE المتوقع، والصحيحة تنجح.
-- 23505 فريد | 23514 CHECK | 23P01 تداخل (exclusion) | 42501 ممنوع (سجل إضافة فقط / وصل ثابت)
-- ============================================================================

-- ---------------------------------------------------------------- دوال مساعدة للاختبارات
create function t.make_refund(p_payment bigint, p_item bigint, p_amount bigint, p_points_returned int default 0, p_clawed int default 0)
returns bigint language plpgsql as $$
declare v_ref bigint;
begin
  insert into refunds (branch_id, payment_id, refund_no, shift_id, cashier_id, total_amount, points_returned, points_clawed_back, reason)
  values (t.i('branch'), p_payment, t.next_no(t.i('branch'), 'refund'), t.i('shift1'), t.i('cashier1'), p_amount, p_points_returned, p_clawed, 'تجربة')
  returning id into v_ref;
  insert into refund_items (refund_id, payment_item_id, amount) values (v_ref, p_item, p_amount);
  insert into refund_tenders (refund_id, original_method_id, payout_method_id, payout_method_name, payout_kind, amount)
  values (v_ref, t.i('pm_cash'), t.i('pm_cash'), 'كاش', 'cash', p_amount);
  update payment_items set status = 'refunded' where id = p_item;
  return v_ref;
end $$;

-- كسب النقاط المسحوب عند الاسترجاع (المثال 1 و2 من ACCOUNTING_RULES.md):
-- floor(N/A)*B  −  floor((N−R)/A)*B
create function t.points_clawback(n bigint, r bigint, a bigint, b int) returns int
language sql immutable as $$ select (floor(n::numeric / a) * b - floor((n - r)::numeric / a) * b)::int $$;

-- يحاكي وصلاً فيه مجموع الطرق ≠ الصافي ويرجع عدد صفوف الخلل، ثم يتراجع كله
create function t.demo_tender_mismatch() returns int language plpgsql as $$
declare v_pay bigint; v_n int; v_cust bigint := t.i('c_pay');
begin
  insert into payments (branch_id, receipt_no, customer_id, shift_id, cashier_id, kind, gross_amount, net_amount, clinic_snapshot)
  values (t.i('branch'), 'DEMO-1', v_cust, t.i('shift1'), t.i('cashier1'), 'sessions', 1000, 1000, '{}') returning id into v_pay;
  insert into payment_tenders (payment_id, method_id, method_name, method_kind, amount)
  values (v_pay, t.i('pm_cash'), 'كاش', 'cash', 400);
  select count(*) into v_n from v_integrity_checks where check_name = 'payment_tenders_sum_mismatch' and entity_id = v_pay;
  raise exception 'rollback_demo %', v_n using errcode = 'T0001';
exception when sqlstate 'T0001' then
  return split_part(sqlerrm, ' ', 2)::int;
end $$;

-- ================================================================= أ) الهوية والموظفين
select t.expect_fail('users: الاسم يتكرر حتى باختلاف الحروف', $q$insert into users (username,password_hash,full_name,role,branch_id) values ('OWNER','x','x','owner',null)$q$, '23505');
select t.expect_fail('users: غير المالك لازم فرع', $q$insert into users (username,password_hash,full_name,role,branch_id) values ('nobranch','x','x','manager',null)$q$, '23514');
select t.expect_fail('users: دور غير معروف', $q$insert into users (username,password_hash,full_name,role,branch_id) values ('weird','x','x','janitor',t.i('branch'))$q$, '23514');
select t.expect_fail('users: معطل لازم تاريخ تعطيل', $q$insert into users (username,password_hash,full_name,role,branch_id,is_active) values ('off1','x','x','nurse',t.i('branch'),false)$q$, '23514');

select t.expect_fail('pay_rules: النسبة للأطباء بس', $q$insert into pay_rules (user_id,effective_from,consult_percent,set_by) values (t.i('cashier1'),current_date,10,t.i('owner'))$q$, '23514');
select t.expect_fail('pay_rules: نسبة فوق 100', $q$insert into pay_rules (user_id,effective_from,consult_percent,set_by) values (t.i('doctor1'),current_date,101,t.i('owner'))$q$, '23514');
select t.expect_fail('pay_rules: راتب سالب', $q$insert into pay_rules (user_id,effective_from,monthly_salary,set_by) values (t.i('cashier1'),current_date,-1,t.i('owner'))$q$, '23514');
select t.expect_ok  ('pay_rules: نسبة الطبيب صحيحة', $q$insert into pay_rules (user_id,effective_from,monthly_salary,consult_percent,set_by) values (t.i('doctor1'),current_date,1000000,20,t.i('owner'))$q$);
select t.expect_fail('pay_rules: نفس التاريخ مرتين', $q$insert into pay_rules (user_id,effective_from,monthly_salary,set_by) values (t.i('doctor1'),current_date,5,t.i('owner'))$q$, '23505');

select t.expect_fail('users: TOTP مفعل بدون مفتاح', $q$update users set totp_enabled_at = now(), totp_secret_enc = null where username = 'owner'$q$, '23514');
select t.expect_ok  ('users: TOTP مفعل مع مفتاح', $q$update users set totp_secret_enc = 'v1.x.y.z', totp_enabled_at = now() where username = 'owner'$q$);
select t.expect_ok  ('totp_recovery_codes: رمز استرجاع', $q$insert into totp_recovery_codes (user_id, code_hash) values (t.i('owner'), 'hash-1')$q$);
select t.expect_fail('totp_recovery_codes: بصمة مكررة', $q$insert into totp_recovery_codes (user_id, code_hash) values (t.i('owner'), 'hash-1')$q$, '23505');

-- ================================================================= ب) الزبائن
select t.expect_fail('customers: صيغة تلفون غلط', $q$insert into customers (branch_id,public_code,phone,full_name,source) values (t.i('branch'),'BAD1','07700000000','x','cashier')$q$, '23514');
select t.expect_ok  ('customers: تلفون صحيح', $q$insert into customers (branch_id,public_code,phone,full_name,source) values (t.i('branch'),'X1','+9647801111111','زبون','cashier')$q$);
select t.expect_fail('customers: نفس التلفون لزبون فعال ثاني', $q$insert into customers (branch_id,public_code,phone,full_name,source) values (t.i('branch'),'X2','+9647801111111','ثاني','cashier')$q$, '23505');
select t.expect_fail('customers: الرمز المميز يتكرر', $q$insert into customers (branch_id,public_code,phone,full_name,source) values (t.i('branch'),'X1','+9647802222222','ثالث','cashier')$q$, '23505');
select t.expect_ok  ('customers: الملف المدموج ما يمنع التلفون', $q$insert into customers (branch_id,public_code,phone,full_name,source,status,merged_into_id) select t.i('branch'),'X3','+9647801111111','مدموج','cashier','merged',id from customers where public_code='X1'$q$);
select t.expect_fail('customers: مدموج بدون وجهة', $q$insert into customers (branch_id,public_code,phone,full_name,source,status) values (t.i('branch'),'X4','+9647803333333','x','cashier','merged')$q$, '23514');

-- ================================================================= ج) الدوام والعطل
select t.expect_ok  ('دوام الطبيب: فترة الاثنين', $q$insert into doctor_schedules (doctor_id,weekday,start_time,end_time,effective_from,effective_to,created_by) values (t.i('doctor1'),1,'08:00','12:00','2030-01-01','2030-06-30',t.i('manager1'))$q$);
select t.expect_fail('دوام الطبيب: فترة ثانية لنفس اليوم والمدى تتداخل', $q$insert into doctor_schedules (doctor_id,weekday,start_time,end_time,effective_from,effective_to,created_by) values (t.i('doctor1'),1,'14:00','18:00','2030-03-01','2030-12-31',t.i('manager1'))$q$, '23P01');
select t.expect_ok  ('دوام الطبيب: نفس اليوم بمدى لاحق', $q$insert into doctor_schedules (doctor_id,weekday,start_time,end_time,effective_from,created_by) values (t.i('doctor1'),1,'09:00','13:00','2030-07-01',t.i('manager1'))$q$);
select t.expect_ok  ('دوام الطبيب: يوم ثاني ما يتداخل', $q$insert into doctor_schedules (doctor_id,weekday,start_time,end_time,effective_from,created_by) values (t.i('doctor1'),2,'08:00','12:00','2030-01-01',t.i('manager1'))$q$);
select t.expect_fail('دوام الطبيب: النهاية قبل البداية', $q$insert into doctor_schedules (doctor_id,weekday,start_time,end_time,effective_from,created_by) values (t.i('doctor1'),3,'12:00','08:00','2030-01-01',t.i('manager1'))$q$, '23514');
select t.expect_fail('دوام الطبيب: يوم 8 غلط', $q$insert into doctor_schedules (doctor_id,weekday,start_time,end_time,effective_from,created_by) values (t.i('doctor1'),8,'08:00','12:00','2030-01-01',t.i('manager1'))$q$, '23514');

select t.expect_ok  ('إجازة طبيب: يوم', $q$insert into doctor_days_off (doctor_id,off_date,created_by) values (t.i('doctor1'),'2030-02-04',t.i('manager1'))$q$);
select t.expect_fail('إجازة طبيب: نفس اليوم فعالة مرتين', $q$insert into doctor_days_off (doctor_id,off_date,created_by) values (t.i('doctor1'),'2030-02-04',t.i('manager1'))$q$, '23505');
select t.expect_ok  ('إجازة طبيب: بعد الإلغاء تنضاف من جديد', $q$with c as (update doctor_days_off set cancelled_at=now(), cancelled_by=t.i('manager1') where off_date='2030-02-04' returning 1) insert into doctor_days_off (doctor_id,off_date,created_by) select t.i('doctor1'),'2030-02-04',t.i('manager1') from c$q$);

select t.expect_ok  ('عطلة: يوم', $q$insert into holidays (branch_id,holiday_date,name,created_by) values (t.i('branch'),'2030-03-21','نوروز',t.i('manager1'))$q$);
select t.expect_fail('عطلة: نفس اليوم فعالة مرتين', $q$insert into holidays (branch_id,holiday_date,name,created_by) values (t.i('branch'),'2030-03-21','ثانية',t.i('manager1'))$q$, '23505');

-- ================================================================= د) الخدمات والعروض
select t.expect_fail('services: كشفية فعالة ثانية بالفرع', $q$insert into services (branch_id,name_ar,kind,pricing_model) values (t.i('branch'),'كشفية ثانية','consultation','fixed')$q$, '23505');
select t.expect_fail('services: نوع تسعير غلط', $q$insert into services (branch_id,name_ar,kind,pricing_model) values (t.i('branch'),'x','treatment','magic')$q$, '23514');
select t.expect_fail('service_prices: نفس التاريخ مرتين', $q$insert into service_prices (service_id,price,effective_from,set_by) select service_id,1,effective_from,t.i('owner') from service_prices limit 1$q$, '23505');
select t.expect_fail('service_prices: سعر سالب', $q$insert into service_prices (service_id,price,set_by) values (t.i('svc_laser'),-5,t.i('owner'))$q$, '23514');

select t.expect_ok  ('عروض: عرض على الليزر 10 أيام', $q$insert into offers (branch_id,service_id,title,percent,start_date,end_date,created_by) values (t.i('branch'),t.i('svc_laser'),'عرض أ',20,'2031-01-01','2031-01-10',t.i('manager1'))$q$);
select t.expect_fail('عروض: تداخل على نفس الخدمة', $q$insert into offers (branch_id,service_id,title,percent,start_date,end_date,created_by) values (t.i('branch'),t.i('svc_laser'),'عرض ب',30,'2031-01-10','2031-01-20',t.i('manager1'))$q$, '23P01');
select t.expect_ok  ('عروض: اليوم التالي مباشرة مسموح', $q$insert into offers (branch_id,service_id,title,percent,start_date,end_date,created_by) values (t.i('branch'),t.i('svc_laser'),'عرض ج',30,'2031-01-11','2031-01-20',t.i('manager1'))$q$);
select t.expect_ok  ('عروض: عرض ملغى ما يمنع التداخل', $q$insert into offers (branch_id,service_id,title,percent,start_date,end_date,status,created_by) values (t.i('branch'),t.i('svc_laser'),'ملغى',50,'2031-01-05','2031-01-15','cancelled',t.i('manager1'))$q$);
select t.expect_fail('عروض: الخصم 100%', $q$insert into offers (branch_id,service_id,title,percent,start_date,end_date,created_by) values (t.i('branch'),t.i('svc_consult'),'x',100,'2032-01-01','2032-01-02',t.i('manager1'))$q$, '23514');
select t.expect_fail('عروض: النهاية قبل البداية', $q$insert into offers (branch_id,service_id,title,percent,start_date,end_date,created_by) values (t.i('branch'),t.i('svc_consult'),'x',10,'2032-01-05','2032-01-02',t.i('manager1'))$q$, '23514');

-- ================================================================= هـ) طرق الدفع
select t.expect_fail('طرق الدفع: كاش فعال ثاني', $q$insert into payment_methods (branch_id,name_ar,kind) values (t.i('branch'),'كاش ثاني','cash')$q$, '23505');
select t.expect_fail('طرق الدفع: إلكتروني بدون جهاز', $q$insert into payment_methods (branch_id,name_ar,kind) values (t.i('branch'),'سويتش','electronic')$q$, '23514');
select t.expect_fail('طرق الدفع: إلكتروني باسم جهاز فارغ', $q$insert into payment_methods (branch_id,name_ar,kind,device_label) values (t.i('branch'),'سويتش','electronic','   ')$q$, '23514');
select t.expect_fail('طرق الدفع: نفس الاسم والجهاز بمسافات وحروف مختلفة', $q$insert into payment_methods (branch_id,name_ar,kind,device_label) values (t.i('branch'),'  كي كارد ','electronic','جهاز ١ ')$q$, '23505');
select t.expect_ok  ('طرق الدفع: نفس الاسم بجهاز ثاني', $q$insert into payment_methods (branch_id,name_ar,kind,device_label) values (t.i('branch'),'كي كارد','electronic','جهاز ٢')$q$);

-- ================================================================= و) الحجز والزيارات
select t.expect_fail('booking_days: مقاعد سالبة', $q$insert into booking_days (branch_id,day,used_slots) values (t.i('branch'),'2040-01-01',-1)$q$, '23514');

with i as (insert into customers (branch_id,public_code,phone,full_name,source) values (t.i('branch'),'V1','+9647811000001','زبون ١','cashier') returning id) insert into t.ids select 'c_v1', id from i;
with i as (insert into customers (branch_id,public_code,phone,full_name,source) values (t.i('branch'),'V2','+9647811000002','زبون ٢','cashier') returning id) insert into t.ids select 'c_v2', id from i;
select t.expect_ok  ('visits: زيارة أولى', $q$insert into visits (branch_id,customer_id,visit_date,seq_no,source) values (t.i('branch'),t.i('c_v1'),'2035-05-05',1,'cashier')$q$);
select t.expect_fail('visits: زيارة فعالة ثانية لنفس الزبون واليوم', $q$insert into visits (branch_id,customer_id,visit_date,seq_no,source) values (t.i('branch'),t.i('c_v1'),'2035-05-05',2,'cashier')$q$, '23505');
select t.expect_fail('visits: نفس الرقم لزبون ثاني بنفس اليوم', $q$insert into visits (branch_id,customer_id,visit_date,seq_no,source) values (t.i('branch'),t.i('c_v2'),'2035-05-05',1,'cashier')$q$, '23505');
select t.expect_fail('visits: رقم صفر', $q$insert into visits (branch_id,customer_id,visit_date,seq_no,source) values (t.i('branch'),t.i('c_v2'),'2035-05-05',0,'cashier')$q$, '23514');
select t.expect_fail('visits: ملغاة بدون وقت إلغاء', $q$insert into visits (branch_id,customer_id,visit_date,seq_no,source,status) values (t.i('branch'),t.i('c_v2'),'2035-05-05',2,'cashier','cancelled')$q$, '23514');
select t.expect_ok  ('visits: بعد إلغاء الأولى ينحجز بنفس اليوم', $q$with c as (update visits set status='cancelled', cancelled_at=now() where customer_id=t.i('c_v1') and visit_date='2035-05-05' returning 1) insert into visits (branch_id,customer_id,visit_date,seq_no,source) select t.i('branch'),t.i('c_v1'),'2035-05-05',2,'cashier' from c$q$);

-- كشفية على زيارة
insert into t.ids values ('v_cons', (select id from visits where customer_id = t.i('c_v1') and status = 'booked'));
select t.expect_ok  ('consultations: كشفية على الزيارة', $q$insert into consultations (branch_id,visit_id,customer_id,doctor_id) values (t.i('branch'),t.i('v_cons'),t.i('c_v1'),t.i('doctor1'))$q$);
select t.expect_fail('consultations: كشفية ثانية فعالة على نفس الزيارة', $q$insert into consultations (branch_id,visit_id,customer_id,doctor_id) values (t.i('branch'),t.i('v_cons'),t.i('c_v1'),t.i('doctor1'))$q$, '23505');
select t.expect_fail('consultations: مراجعة مجانية بدون كشفية أصلية', $q$insert into consultations (branch_id,visit_id,customer_id,doctor_id,kind) select t.i('branch'),id,t.i('c_v2'),t.i('doctor1'),'free_followup' from visits where customer_id=t.i('c_v1') and status='cancelled'$q$, '23514');
select t.expect_ok  ('visits: زيارة لكشفية «جلسات فقط»', $q$insert into visits (branch_id,customer_id,visit_date,seq_no,source) values (t.i('branch'),t.i('c_v2'),'2035-05-20',1,'cashier')$q$);
insert into t.ids values ('v_so', (select id from visits where customer_id = t.i('c_v2') and visit_date = '2035-05-20'));
select t.expect_fail('consultations: نوع غير معروف', $q$insert into consultations (branch_id,visit_id,customer_id,doctor_id,kind) values (t.i('branch'),t.i('v_so'),t.i('c_v2'),t.i('doctor1'),'weird')$q$, '23514');
select t.expect_ok  ('consultations: «جلسات فقط» بدون كشفية سابقة (مو مراجعة)', $q$insert into consultations (branch_id,visit_id,customer_id,doctor_id,kind) values (t.i('branch'),t.i('v_so'),t.i('c_v2'),t.i('doctor1'),'sessions_only')$q$);
select t.expect_fail('consultations: «جلسات فقط» ثانية فعالة على نفس الزيارة', $q$insert into consultations (branch_id,visit_id,customer_id,doctor_id,kind) values (t.i('branch'),t.i('v_so'),t.i('c_v2'),t.i('doctor1'),'sessions_only')$q$, '23505');
select t.expect_ok  ('consultations: ملاحظة الحجز وخدمة مطلوبة', $q$update consultations set booking_note='أريد بوتوكس', interest_service_id=(select id from services limit 1) where visit_id=t.i('v_so')$q$);
select t.expect_fail('consultations: ملاحظة فارغة', $q$update consultations set booking_note='' where visit_id=t.i('v_so')$q$, '23514');
select t.expect_fail('consultations: ملاحظة أطول من 500', $q$update consultations set booking_note=repeat('x',501) where visit_id=t.i('v_so')$q$, '23514');
select t.expect_fail('consultations: خدمة مطلوبة غير موجودة', $q$update consultations set interest_service_id=99999999 where visit_id=t.i('v_so')$q$, '23503');
select t.expect_ok  ('booking_days: إيقاف الحجز بموظف', $q$insert into booking_days (branch_id,day,stopped_at,stopped_by,stop_reason) values (t.i('branch'),'2041-02-02',now(),t.i('manager1'),'زحمة')$q$);
select t.expect_fail('booking_days: إيقاف بدون من أوقفه', $q$insert into booking_days (branch_id,day,stopped_at) values (t.i('branch'),'2041-02-03',now())$q$, '23514');
select t.expect_fail('booking_days: من أوقف بدون وقت', $q$insert into booking_days (branch_id,day,stopped_by) values (t.i('branch'),'2041-02-04',t.i('manager1'))$q$, '23514');
select t.expect_ok  ('booking_events: حدث ترحيل «ما وصله الدور»', $q$insert into booking_events (visit_id,event,from_date,to_date,from_seq,to_seq,reason) values (t.i('v_so'),'rolled_over','2035-05-20','2035-05-21',1,3,'ما وصله الدور')$q$);
select t.expect_fail('consultations: منتهية بدون دخول للطبيب', $q$update consultations set status='finished', finished_at=now() where visit_id=t.i('v_cons')$q$, '23514');

-- جلسات
select t.setup_customer(901, 2);
insert into t.ids values ('c_ses', (select id from customers where public_code = 'T0901'));
select t.expect_fail('sessions: مكتملة بدون ممرض', $q$update treatment_sessions set status='completed', completed_at=now() where customer_id=t.i('c_ses') and seq_no=1$q$, '23514');
select t.expect_fail('sessions: بانتظار حجز وعليها زيارة', $q$update treatment_sessions set status='awaiting_booking' where customer_id=t.i('c_ses') and seq_no=1$q$, '23514');
select t.expect_fail('sessions: محجوزة بدون زيارة', $q$update treatment_sessions set visit_id=null where customer_id=t.i('c_ses') and seq_no=1$q$, '23514');
select t.expect_fail('sessions: نفس رقم الجلسة بالخطة', $q$insert into treatment_sessions (branch_id,customer_id,plan_item_id,seq_no,doctor_planned_date) select branch_id,customer_id,plan_item_id,1,current_date from treatment_sessions where customer_id=t.i('c_ses') limit 1$q$, '23505');
select t.expect_fail('sessions: ملغاة بدون وقت', $q$update treatment_sessions set status='cancelled' where customer_id=t.i('c_ses') and seq_no=2$q$, '23514');
select t.expect_fail('plan_items: 61 جلسة', $q$update plan_items set sessions_count=61$q$, '23514');
select t.expect_ok  ('sessions: اكتمال صحيح (ممرض ووقت)', $q$update treatment_sessions set status='completed', completed_at=now(), completed_by=t.i('nurse1') where customer_id=t.i('c_ses') and seq_no=2$q$);
-- (الجلسة 2 مكتملة بلا وصل: هذا خلل مقصود يكشفه v_integrity_checks، نرجعها قبل النهاية)
select t.check('integrity: جلسة مكتملة بلا وصل تنكشف', (select count(*) from v_integrity_checks where check_name='paid_session_without_payment') = 1);
update treatment_sessions set status='booked', completed_at=null, completed_by=null where customer_id = t.i('c_ses') and seq_no = 2;

-- ================================================================= ز) الدفع والوصل
select t.setup_customer(902, 4);
insert into t.ids values ('c_pay', (select id from customers where public_code = 'T0902'));
insert into t.ids select 's_pay' || seq_no, id from treatment_sessions where customer_id = t.i('c_pay');

select t.expect_fail('payments: الصافي ما يطابق المعادلة', $q$insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,net_amount,clinic_snapshot) values (t.i('branch'),'BAD-1',t.i('c_pay'),t.i('shift1'),t.i('cashier1'),'sessions',100,90,'{}')$q$, '23514');
select t.expect_fail('payments: وصل صفري ما يكسب نقاط', $q$insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,net_amount,points_earned,clinic_snapshot) values (t.i('branch'),'BAD-2',t.i('c_pay'),t.i('shift1'),t.i('cashier1'),'sessions',50000,0,5,'{}')$q$, '23514');
select t.expect_fail('payments: خصم سالب', $q$insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,manual_discount,net_amount,clinic_snapshot) values (t.i('branch'),'BAD-3',t.i('c_pay'),t.i('shift1'),t.i('cashier1'),'sessions',100,-10,110,'{}')$q$, '23514');
select t.expect_fail('payments: نوع غلط', $q$insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,net_amount,clinic_snapshot) values (t.i('branch'),'BAD-4',t.i('c_pay'),t.i('shift1'),t.i('cashier1'),'gift',100,100,'{}')$q$, '23514');

-- وصل أول كامل (جلسة 1)
insert into t.ids values ('pay1', t.make_payment(t.i('c_pay'), t.i('s_pay1'), 50000));
insert into t.ids select 'item1', id from payment_items where payment_id = t.i('pay1');
select t.expect_fail('payments: رقم وصل مكرر', $q$insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,net_amount,clinic_snapshot) select branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,0,0,'{}' from payments where id=t.i('pay1')$q$, '23505');
select t.expect_fail('payments: ما ينعدل الصافي', $q$update payments set net_amount=1, gross_amount=1 where id=t.i('pay1')$q$, '42501');
select t.expect_fail('payments: ما ينعدل الكاشير', $q$update payments set cashier_id=t.i('manager1') where id=t.i('pay1')$q$, '42501');
select t.expect_fail('payments: ما تنعدل لقطة بيانات العيادة', $q$update payments set clinic_snapshot='{"name":"changed"}' where id=t.i('pay1')$q$, '42501');
select t.expect_fail('payments: ما ينحذف', $q$delete from payments where id=t.i('pay1')$q$, '42501');
select t.expect_ok  ('payments: الحالة تتغير (استرجاع جزئي)', $q$update payments set status='partially_refunded' where id=t.i('pay1')$q$);
select t.expect_ok  ('payments: إرفاق PDF أول مرة', $q$update payments set pdf_attachment_id=(select id from attachments where kind='expense_proof' limit 1) where id=t.i('pay1')$q$);
select t.expect_fail('payments: تغيير PDF بعد الإرفاق', $q$update payments set pdf_attachment_id=null where id=t.i('pay1')$q$, '42501');
update payments set status = 'paid' where id = t.i('pay1');

select t.expect_ok  ('payments: وصل صفري صحيح', $q$insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,manual_discount,net_amount,clinic_snapshot) values (t.i('branch'),t.next_no(t.i('branch'),'receipt'),t.i('c_pay'),t.i('shift1'),t.i('cashier1'),'sessions',0,0,0,'{}')$q$);

-- بنود الوصل
select t.expect_fail('payment_items: دفع نفس الجلسة مرتين', $q$insert into payment_items (payment_id,item_type,session_id,service_id,service_name,list_price,net_amount) values (t.i('pay1'),'session',t.i('s_pay1'),t.i('svc_laser'),'ليزر',1,1)$q$, '23505');
select t.expect_fail('payment_items: الصافي ما يطابق', $q$insert into payment_items (payment_id,item_type,session_id,service_id,service_name,list_price,manual_discount_share,net_amount) values (t.i('pay1'),'session',t.i('s_pay2'),t.i('svc_laser'),'ليزر',100,10,100)$q$, '23514');
select t.expect_fail('payment_items: بند كشفية بدون كشفية', $q$insert into payment_items (payment_id,item_type,service_id,service_name,list_price,net_amount) values (t.i('pay1'),'consultation',t.i('svc_consult'),'كشفية',1,1)$q$, '23514');
select t.expect_fail('payment_items: بند جلسة بدون جلسة', $q$insert into payment_items (payment_id,item_type,service_id,service_name,list_price,net_amount) values (t.i('pay1'),'session',t.i('svc_laser'),'ليزر',1,1)$q$, '23514');
select t.expect_fail('payment_items: ما ينعدل السعر', $q$update payment_items set list_price=1, net_amount=1 where id=t.i('item1')$q$, '42501');
select t.expect_fail('payment_items: ما ينحذف', $q$delete from payment_items where id=t.i('item1')$q$, '42501');

-- كشفية تنتدفع مرة وحدة
insert into t.ids select 'cons_pay', id from consultations where customer_id = t.i('c_pay');
select t.expect_ok  ('payment_items: دفع كشفية', $q$with p as (insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,net_amount,clinic_snapshot) values (t.i('branch'),t.next_no(t.i('branch'),'receipt'),t.i('c_pay'),t.i('shift1'),t.i('cashier1'),'consultation',25000,25000,'{}') returning id),
  i as (insert into payment_items (payment_id,item_type,consultation_id,service_id,service_name,list_price,net_amount) select id,'consultation',t.i('cons_pay'),t.i('svc_consult'),'كشفية',25000,25000 from p returning payment_id)
  insert into payment_tenders (payment_id,method_id,method_name,method_kind,amount) select payment_id,t.i('pm_cash'),'كاش','cash',25000 from i$q$);
select t.expect_fail('payment_items: دفع نفس الكشفية مرتين', $q$insert into payments (branch_id,receipt_no,customer_id,shift_id,cashier_id,kind,gross_amount,net_amount,clinic_snapshot) values (t.i('branch'),t.next_no(t.i('branch'),'receipt'),t.i('c_pay'),t.i('shift1'),t.i('cashier1'),'consultation',25000,25000,'{}'); insert into payment_items (payment_id,item_type,consultation_id,service_id,service_name,list_price,net_amount) select currval(pg_get_serial_sequence('payments','id')),'consultation',t.i('cons_pay'),t.i('svc_consult'),'كشفية',25000,25000$q$, '23505');

-- طرق الدفع بالوصل
select t.expect_fail('payment_tenders: مبلغ صفر', $q$insert into payment_tenders (payment_id,method_id,method_name,method_kind,amount) values (t.i('pay1'),t.i('pm_cash'),'كاش','cash',0)$q$, '23514');
select t.expect_fail('payment_tenders: نوع غلط', $q$insert into payment_tenders (payment_id,method_id,method_name,method_kind,amount) values (t.i('pay1'),t.i('pm_cash'),'كاش','crypto',5)$q$, '23514');
select t.expect_fail('payment_tenders: سجل إضافة فقط (تعديل)', $q$update payment_tenders set amount=1 where payment_id=t.i('pay1')$q$, '42501');
select t.expect_fail('payment_tenders: سجل إضافة فقط (حذف)', $q$delete from payment_tenders where payment_id=t.i('pay1')$q$, '42501');
select t.expect_fail('payment_tenders: سجل إضافة فقط (تفريغ)', $q$truncate payment_tenders$q$, '42501');
select t.check('integrity: مجموع الطرق ≠ الصافي ينكشف', t.demo_tender_mismatch() = 1);

-- الاسترجاع
select t.expect_fail('refunds: بدون سبب', $q$insert into refunds (branch_id,payment_id,refund_no,shift_id,cashier_id,total_amount,reason) values (t.i('branch'),t.i('pay1'),'R-BAD',t.i('shift1'),t.i('cashier1'),100,'  ')$q$, '23514');
select t.expect_fail('refunds: مبلغ صفر', $q$insert into refunds (branch_id,payment_id,refund_no,shift_id,cashier_id,total_amount,reason) values (t.i('branch'),t.i('pay1'),'R-BAD',t.i('shift1'),t.i('cashier1'),0,'x')$q$, '23514');

-- ================================================================= ح) النقاط
select t.expect_ok  ('points: كسب 250 على الوصل 1', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'earn',250,t.i('pay1'))$q$);
select t.expect_fail('points: كسب ثاني على نفس الوصل', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'earn',250,t.i('pay1'))$q$, '23505');
insert into t.ids values ('pay2', t.make_payment(t.i('c_pay'), t.i('s_pay2'), 50000));
select t.expect_fail('points: صرف أكثر من الرصيد', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'redeem',-300,t.i('pay2'))$q$, '23514');
select t.expect_ok  ('points: صرف ضمن الرصيد', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'redeem',-100,t.i('pay2'))$q$);
select t.expect_fail('points: صرف ثاني على نفس الوصل', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'redeem',-10,t.i('pay2'))$q$, '23505');
select t.expect_fail('points: كسب بقيمة سالبة', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'earn',-5,t.i('pay2'))$q$, '23514');
select t.expect_fail('points: صرف بقيمة موجبة', $q$insert into points_ledger (customer_id,entry_type,points) values (t.i('c_pay'),'redeem',5)$q$, '23514');
select t.expect_fail('points: حركة صفر', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'earn',0,t.i('pay2'))$q$, '23514');
select t.expect_fail('points: كسب بدون وصل', $q$insert into points_ledger (customer_id,entry_type,points) values (t.i('c_pay'),'earn',5)$q$, '23514');
select t.expect_fail('points: السجل إضافة فقط', $q$update points_ledger set points=1$q$, '42501');
select t.check('points: الرصيد المخزن = مجموع الحركات (150)', (select points_balance from customers where id = t.i('c_pay')) = 150);

-- سحب النقاط عند الاسترجاع يسمح بالسالب (قرار: الرصيد السالب مسموح بعد الاسترجاع)
do $$
declare v_ref bigint;
begin
  v_ref := t.make_refund(t.i('pay1'), t.i('item1'), 50000, 0, 250);
  insert into t.ids values ('ref1', v_ref);
  insert into points_ledger (customer_id, entry_type, points, refund_id) values (t.i('c_pay'), 'earn_clawback', -250, v_ref);
end $$;
select t.check('points: الرصيد صار سالب بعد السحب (-100)', (select points_balance from customers where id = t.i('c_pay')) = -100);
select t.expect_fail('points: سحب ثاني لنفس الاسترجاع', $q$insert into points_ledger (customer_id,entry_type,points,refund_id) values (t.i('c_pay'),'earn_clawback',-1,t.i('ref1'))$q$, '23505');
select t.expect_fail('points: ما ينصرف من رصيد سالب', $q$insert into points_ledger (customer_id,entry_type,points,payment_id) values (t.i('c_pay'),'redeem',-1,t.i('pay1'))$q$, '23514');
select t.expect_fail('refund_items: نفس البند يتسترجع مرتين', $q$insert into refund_items (refund_id,payment_item_id,amount) values (t.i('ref1'),t.i('item1'),1)$q$, '23505');
select t.expect_fail('refund_items: السجل إضافة فقط', $q$delete from refund_items$q$, '42501');
select t.expect_fail('payment_items: المسترجع ما يرجع مدفوع', $q$update payment_items set status='paid' where id=t.i('item1')$q$, '42501');
update payments set status = 'refunded' where id = t.i('pay1');

-- معادلات النقاط من ACCOUNTING_RULES.md
select t.check('نقاط: المثال 1، استرجاع البند 2 يسحب 500', t.points_clawback(50000, 16667, 10000, 250) = 500);
select t.check('نقاط: المثال 2، استرجاع 5,000 يسحب 250 مو 125', t.points_clawback(20000, 5000, 10000, 250) = 250);
select t.check('نقاط: استرجاع كامل يسحب كل الكسب (1,250)', t.points_clawback(50000, 50000, 10000, 250) = 1250);

-- ================================================================= ط) الخزنة
select t.expect_fail('safe: صرف أكبر من الرصيد', $q$select t.spend(100001)$q$, '23514');
select t.expect_fail('safe: دخل مفتوح الرصيد بدون نوع', $q$insert into safe_movements (branch_id,direction,amount,kind,created_by) values (t.i('branch'),'in',5,'salary',t.i('owner'))$q$, '23514');
select t.expect_fail('safe: سحب المالك لازم اتجاه خروج', $q$insert into safe_movements (branch_id,direction,amount,kind,created_by) values (t.i('branch'),'in',5,'shift_handover',t.i('owner'))$q$, '23514');
select t.expect_fail('safe: تسليم شفت لازم شفت', $q$insert into safe_movements (branch_id,direction,amount,kind,created_by) values (t.i('branch'),'in',5,'shift_handover',t.i('owner'))$q$, '23514');
select t.expect_fail('safe: مبلغ صفر', $q$insert into safe_movements (branch_id,direction,amount,kind,created_by) values (t.i('branch'),'in',0,'opening_balance',t.i('owner'))$q$, '23514');
select t.expect_ok  ('safe: مصروف 30,000 من الخزنة', $q$select t.spend(30000)$q$);
select t.check('safe: الرصيد 70,000', (select balance from safes where branch_id = t.i('branch')) = 70000);
select t.expect_fail('safe: السجل إضافة فقط (تعديل)', $q$update safe_movements set amount=1$q$, '42501');
select t.expect_fail('safe: السجل إضافة فقط (حذف)', $q$delete from safe_movements$q$, '42501');
select t.expect_fail('safe: مصروف إلكتروني بدون مصرف', $q$insert into expenses (branch_id,category_id,amount,expense_date,pay_source,proof_attachment_id,recorded_by) values (t.i('branch'),t.i('exp_cat'),100,current_date,'electronic',t.i('att1'),t.i('manager1'))$q$, '23514');
select t.expect_fail('expenses: المبلغ صفر', $q$insert into expenses (branch_id,category_id,amount,expense_date,pay_source,proof_attachment_id,recorded_by) values (t.i('branch'),t.i('exp_cat'),0,current_date,'safe',t.i('att1'),t.i('manager1'))$q$, '23514');
select t.expect_fail('expenses: الإلغاء بدون سبب', $q$update expenses set status='cancelled' where id=(select min(id) from expenses)$q$, '23514');
select t.expect_fail('expenses: نفس صورة الإثبات لمصروفين', $q$insert into expenses (branch_id,category_id,amount,expense_date,pay_source,proof_attachment_id,recorded_by) values (t.i('branch'),t.i('exp_cat'),100,current_date,'safe',(select proof_attachment_id from expenses order by id limit 1),t.i('manager1'))$q$, '23505');
select t.expect_fail('expenses: بدون صورة إثبات', $q$insert into expenses (branch_id,category_id,amount,expense_date,pay_source,recorded_by) values (t.i('branch'),t.i('exp_cat'),100,current_date,'safe',t.i('manager1'))$q$, '23502');
select t.expect_ok  ('expense_categories: نوع معدات', $q$insert into expense_categories (branch_id,name,kind) values (t.i('branch'),'أجهزة','equipment')$q$);
select t.expect_fail('expense_categories: نوع غلط', $q$insert into expense_categories (branch_id,name,kind) values (t.i('branch'),'x','weird')$q$, '23514');
select t.expect_fail('expense_categories: الاسم يتكرر', $q$insert into expense_categories (branch_id,name) values (t.i('branch'),'نظافة')$q$, '23505');

-- ================================================================= ي) المخزون
select t.expect_fail('stock: صرف أكبر من الدفعة', $q$select t.consume((select id from treatment_sessions where customer_id=t.i('c_pay') and seq_no=1), t.i('batch1'), 11)$q$, '23514');
select t.expect_fail('stock: كمية صفر', $q$insert into stock_movements (branch_id,material_id,batch_id,movement_type,qty_delta,unit_cost,cost_amount,created_by) values (t.i('branch'),t.i('mat1'),t.i('batch1'),'opening',0,1,0,t.i('manager1'))$q$, '23514');
select t.expect_fail('stock: صرف بكمية موجبة', $q$insert into stock_movements (branch_id,material_id,batch_id,movement_type,qty_delta,unit_cost,cost_amount,treatment_session_id) values (t.i('branch'),t.i('mat1'),t.i('batch1'),'consume',2,1,2,(select id from treatment_sessions limit 1))$q$, '23514');
select t.expect_fail('stock: صرف بدون جلسة', $q$insert into stock_movements (branch_id,material_id,batch_id,movement_type,qty_delta,unit_cost,cost_amount) values (t.i('branch'),t.i('mat1'),t.i('batch1'),'consume',-1,1,-1)$q$, '23514');
select t.expect_fail('stock: شراء بدون بند فاتورة', $q$insert into stock_movements (branch_id,material_id,batch_id,movement_type,qty_delta,unit_cost,cost_amount) values (t.i('branch'),t.i('mat1'),t.i('batch1'),'purchase',1,1,1)$q$, '23514');
select t.expect_fail('stock: عكس صرف بدون مرجع', $q$insert into stock_movements (branch_id,material_id,batch_id,movement_type,qty_delta,unit_cost,cost_amount,treatment_session_id) values (t.i('branch'),t.i('mat1'),t.i('batch1'),'consume_reversal',1,1,1,(select id from treatment_sessions limit 1))$q$, '23514');
select t.expect_ok  ('stock: صرف 4 cc', $q$select t.consume((select id from treatment_sessions where customer_id=t.i('c_pay') and seq_no=2), t.i('batch1'), 4)$q$);
select t.check('stock: الكمية بالدفعة 6', (select qty_on_hand from material_batches where id = t.i('batch1')) = 6);
select t.expect_fail('stock: إلغاء شراء بكمية موجبة', $q$insert into stock_movements (branch_id,material_id,batch_id,movement_type,qty_delta,unit_cost,cost_amount,purchase_item_id) values (t.i('branch'),t.i('mat1'),t.i('batch1'),'purchase_void',1,1,1,1)$q$, '23514');
select t.expect_fail('stock: إلغاء شراء بدون بند فاتورة', $q$insert into stock_movements (branch_id,material_id,batch_id,movement_type,qty_delta,unit_cost,cost_amount) values (t.i('branch'),t.i('mat1'),t.i('batch1'),'purchase_void',-1,1,-1)$q$, '23514');
select t.expect_fail('stock: السجل إضافة فقط', $q$update stock_movements set qty_delta=1$q$, '42501');
select t.expect_fail('materials: الوحدات تنقفل بعد أول حركة', $q$update materials set base_unit='ml' where id=t.i('mat1')$q$, '23514');
select t.expect_ok  ('materials: الاسم والحد يتعدلون بعد الحركات', $q$update materials set name='بوتكس أ', low_threshold=3 where id=t.i('mat1')$q$);
select t.expect_fail('materials: الاسم يتكرر', $q$insert into materials (branch_id,name,base_unit,pack_unit) values (t.i('branch'),'بوتكس أ','cc','علبة')$q$, '23505');
select t.expect_fail('materials: وسطية بدون تحويل', $q$insert into materials (branch_id,name,base_unit,pack_unit,mid_unit) values (t.i('branch'),'م2','cc','كرتون','علبة')$q$, '23514');
select t.expect_fail('batches: كمية سالبة', $q$update material_batches set qty_on_hand=-1 where id=t.i('batch1')$q$, '23514');
select t.expect_fail('stock_waste: سبب أخرى بدون ملاحظة', $q$insert into stock_waste (branch_id,material_id,batch_id,qty,reason,cost_amount,created_by) values (t.i('branch'),t.i('mat1'),t.i('batch1'),1,'other',1000,t.i('manager1'))$q$, '23514');

-- ================================================================= ك) الموردين والمشتريات
select t.expect_ok  ('suppliers: مورد', $q$insert into suppliers (branch_id,name,phone) values (t.i('branch'),'شركة النور','07701234567')$q$);
select t.expect_fail('suppliers: الاسم يتكرر بمسافات وحروف', $q$insert into suppliers (branch_id,name) values (t.i('branch'),'  شركة النور ')$q$, '23505');
select t.expect_ok  ('suppliers: نفس التلفون لمورد ثاني مسموح (تحذير بالواجهة بس)', $q$insert into suppliers (branch_id,name,phone) values (t.i('branch'),'شركة الأمل','07701234567')$q$);
select t.expect_fail('purchases: بدون صورة وصل', $q$insert into purchases (branch_id,supplier_id,purchase_date,total_amount,created_by) select t.i('branch'),id,current_date,1000,t.i('manager1') from suppliers limit 1$q$, '23502');
select t.expect_fail('purchases: إلغاء بدون سبب', $q$insert into purchases (branch_id,supplier_id,purchase_date,total_amount,receipt_attachment_id,status,created_by) select t.i('branch'),id,current_date,1000,t.i('att1'),'voided',t.i('manager1') from suppliers limit 1$q$, '23514');
select t.expect_ok  ('purchases: فاتورة', $q$insert into purchases (branch_id,supplier_id,invoice_no,purchase_date,total_amount,receipt_attachment_id,created_by) select t.i('branch'),id,'INV-1',current_date,1000,t.i('att1'),t.i('manager1') from suppliers where name='شركة النور'$q$);
select t.expect_fail('purchases: رقم الفاتورة يتكرر عند نفس المورد', $q$insert into purchases (branch_id,supplier_id,invoice_no,purchase_date,total_amount,receipt_attachment_id,created_by) select t.i('branch'),id,'INV-1',current_date,500,t.i('att1'),t.i('manager1') from suppliers where name='شركة النور'$q$, '23505');
select t.expect_fail('purchases: نفس صورة الوصل لفاتورتين', $q$insert into purchases (branch_id,supplier_id,invoice_no,purchase_date,total_amount,receipt_attachment_id,created_by) select t.i('branch'),id,'INV-1',current_date,500,t.i('att1'),t.i('manager1') from suppliers where name='شركة الأمل'$q$, '23505');
insert into attachments (branch_id, kind, storage_key, mime, size_bytes, sha256, uploaded_by) values (t.i('branch'), 'purchase_receipt', 'test/receipt-2', 'image/jpeg', 1000, 'abc', t.i('manager1'));
select t.expect_ok  ('purchases: نفس الرقم عند مورد ثاني', $q$insert into purchases (branch_id,supplier_id,invoice_no,purchase_date,total_amount,receipt_attachment_id,created_by) select t.i('branch'),id,'INV-1',current_date,500,(select max(id) from attachments where storage_key = 'test/receipt-2'),t.i('manager1') from suppliers where name='شركة الأمل'$q$);
-- الفواتير بلا بنود هنا مقصودة: نحذفها قبل الفحص النهائي (الإدراج الأصلي بالتطبيق فيه البنود)
delete from purchases;

-- ================================================================= ل) الشفتات والرواتب والإعدادات والتكرار
select t.expect_fail('shifts: شفت ثاني مفتوح لنفس الكاشير', $q$insert into shifts (branch_id,cashier_id,opening_float) values (t.i('branch'),t.i('cashier1'),0)$q$, '23505');
select t.expect_fail('shifts: فكة سالبة', $q$insert into shifts (branch_id,cashier_id,opening_float,status,closed_at) values (t.i('branch'),t.i('cashier1'),-5,'closed',now())$q$, '23514');
select t.expect_fail('shifts: مسكر بدون وقت', $q$insert into shifts (branch_id,cashier_id,opening_float,status) values (t.i('branch'),t.i('cashier1'),0,'closed')$q$, '23514');
select t.expect_ok  ('shifts: شفت مسكر ما يمنع شفت جديد لكاشير ثاني', $q$insert into shifts (branch_id,cashier_id,opening_float,status,closed_at) values (t.i('branch'),t.i('cashier1'),0,'closed',now())$q$);

select t.expect_fail('settings: نفس المفتاح مرتين', $q$insert into settings (branch_id,key,value) values (t.i('branch'),'booking.daily_limit','30'::jsonb), (t.i('branch'),'booking.daily_limit','31'::jsonb)$q$, '23505');
select t.check('settings: القراءة مع قيمة افتراضية', setting_int(t.i('branch'), 'booking.nope', 7) = 7);
select t.expect_ok  ('settings: حد الحجز', $q$insert into settings (branch_id,key,value) values (t.i('branch'),'booking.daily_limit','30'::jsonb)$q$);
select t.check('settings: القراءة من الإعداد', setting_int(t.i('branch'), 'booking.daily_limit', 7) = 30);

select t.expect_fail('idempotency: نفس المفتاح مرتين', $q$insert into idempotency_keys (actor_type,actor_id,key,endpoint,request_hash) values ('user',1,'k1','/pay','h'),('user',1,'k1','/pay','h')$q$, '23505');

select t.expect_ok  ('audit_log: إضافة', $q$insert into audit_log (action, entity_type, entity_id) values ('test','payment',1)$q$);
select t.expect_fail('audit_log: السجل إضافة فقط (حذف)', $q$delete from audit_log$q$, '42501');
select t.expect_fail('audit_log: السجل إضافة فقط (تعديل)', $q$update audit_log set action='x'$q$, '42501');
select t.expect_fail('audit_log: السجل إضافة فقط (تفريغ)', $q$truncate audit_log$q$, '42501');

select t.expect_ok  ('customer_health: إضافة', $q$insert into customer_health (customer_id,recorded_by,allergies) values (t.i('c_pay'),t.i('doctor1'),'لا يوجد')$q$);
select t.expect_fail('customer_health: السجل إضافة فقط (تعديل)', $q$update customer_health set allergies='x'$q$, '42501');
select t.expect_ok  ('notifications: تذكير بزيارة', $q$insert into notifications (customer_id, kind, title, body, data) values (t.i('c_pay'),'reminder','t','b','{"visit_id":99101}')$q$);
select t.expect_fail('notifications: تذكير مكرر لنفس الزيارة', $q$insert into notifications (customer_id, kind, title, body, data) values (t.i('c_pay'),'reminder','t','b','{"visit_id":99101}')$q$, '23505');
select t.expect_ok  ('notifications: إشعار نقل موعد', $q$insert into notifications (customer_id, kind, title, body, data) values (t.i('c_pay'),'booking_moved','t','b','{"event_id":99201}')$q$);
select t.expect_fail('notifications: إشعار نقل مكرر لنفس الحدث', $q$insert into notifications (customer_id, kind, title, body, data) values (t.i('c_pay'),'booking_moved','t','b','{"event_id":99201}')$q$, '23505');
select t.expect_fail('confirmation_reverts: بدون بند وصل', $q$insert into confirmation_reverts (session_id, reverted_by, reason, original_completed_at, original_completed_by) values (1, t.i('owner1'), 'x', now(), t.i('owner1'))$q$, '23502');
select t.expect_fail('customer_health: السجل إضافة فقط (تفريغ)', $q$truncate customer_health$q$, '42501');
select t.expect_fail('booking_events: السجل إضافة فقط (تفريغ)', $q$truncate booking_events$q$, '42501');
select t.expect_fail('setting_history: السجل إضافة فقط (تفريغ)', $q$truncate setting_history$q$, '42501');

-- الحجز: الوصفة (نفس اليوم، الحد 3)
select t.expect_ok  ('book: حجز 1', $q$select t.book(t.i('branch'), t.i('c_v1'), '2036-06-06', 3)$q$);
select t.expect_ok  ('book: حجز 2', $q$select t.book(t.i('branch'), t.i('c_v2'), '2036-06-06', 3)$q$);
select t.check('book: التسلسل 1 و 2', (select array_agg(seq_no order by seq_no) from visits where visit_date = '2036-06-06') = array[1,2]);
select t.expect_fail('book: نفس الزبون يومين بنفس اليوم يفشل ويتراجع المقعد', $q$select t.book(t.i('branch'), t.i('c_v1'), '2036-06-06', 3)$q$, '23505');
select t.check('book: المقاعد المستخدمة ما زادت بعد الفشل', (select used_slots from booking_days where day = '2036-06-06') = 2);
select t.check('book: آخر تسلسل 2 بعد الفشل', (select last_seq from booking_days where day = '2036-06-06') = 2);
select t.cancel_visit(id) from visits where visit_date='2036-06-06' and seq_no=1;
select t.check('book: الإلغاء يرجع المقعد والرقم ما ينعاد', (select used_slots from booking_days where day='2036-06-06') = 1 and (select last_seq from booking_days where day='2036-06-06') = 2);
select t.check('book: حجز بعد الإلغاء ياخذ رقم 3 مو 1', t.book(t.i('branch'), t.i('c_v1'), '2036-06-06', 3) = 3);
select t.check('book: اليوم الممتلئ يرجع null', (select t.book(t.i('branch'), c.id, '2036-06-06', 2) from customers c where public_code = 'X1') is null);

-- سحب المالك: الحالات المسموحة (cancelled = المدير ألغى طلبه)
select t.expect_ok  ('owner_withdrawals: pending', $q$insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, recorded_by) values (t.i('branch'), 1000, 'المالك', current_date, t.i('manager1'))$q$);
select t.expect_ok  ('owner_withdrawals: cancelled بقرار المدير', $q$insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, recorded_by, status, decided_by, decided_at) values (t.i('branch'), 1000, 'المالك', current_date, t.i('manager1'), 'cancelled', t.i('manager1'), now())$q$);
select t.expect_fail('owner_withdrawals: cancelled بدون صاحب القرار يفشل', $q$insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, recorded_by, status) values (t.i('branch'), 1000, 'المالك', current_date, t.i('manager1'), 'cancelled')$q$, '23514');
select t.expect_fail('owner_withdrawals: حالة غير معروفة', $q$insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, recorded_by, status) values (t.i('branch'), 1000, 'المالك', current_date, t.i('manager1'), 'archived')$q$, '23514');
