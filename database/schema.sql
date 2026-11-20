-- ============================================================================
-- مخطط قاعدة بيانات نظام مركز التجميل (PostgreSQL 15+)
-- الحالة: اشتغل على PostgreSQL 16 فعلي (2026-11-13) وعدّت عليه اختبارات القيود والسباق بـ database/tests/run.sh.
-- لسه ما انجرب على حمل كبير ولا على PostgreSQL 15، وما اختُبر على بيانات حقيقية.
-- الشرح والقرارات بملف ../DATABASE_DESIGN.md
--
-- قواعد عامة:
--  * المبالغ bigint بالدينار العراقي (عدد صحيح). الكميات numeric(14,3) بوحدة الاستهلاك الصغرى.
--  * التواريخ التجارية (يوم الدوام) نوع date بتوقيت بغداد، واللحظات timestamptz.
--  * القيم المحدودة text + CHECK (أسهل بالتعديل من enum).
--  * السجلات المالية والمخزنية والنقاط "إضافة فقط": ما تنعدل ولا تنحذف (triggers بآخر الملف).
--  * الربط يمشي من السجل (ledger) باتجاه المصدر، حتى ما تصير مراجع دائرية.
-- ============================================================================

begin;

create extension if not exists btree_gist;

-- ---------------------------------------------------------------- دوال مساعدة
create function clinic_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Baghdad')::date $$;

create function forbid_modify() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed: table is append-only', tg_op, tg_table_name
    using errcode = '42501';
end $$;

-- ================================================================== الهوية والموظفين
create table branches (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  name        text not null,
  timezone    text not null default 'Asia/Baghdad',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table users (
  id                   bigint generated always as identity primary key,
  username             text not null,
  password_hash        text not null,
  full_name            text not null,
  phone                text,
  role                 text not null check (role in ('owner','manager','cashier','doctor','nurse')),
  branch_id            bigint references branches(id),            -- null للمالك فقط (كل الفروع)
  is_active            boolean not null default true,
  must_change_password boolean not null default true,
  totp_secret_enc      text,                                      -- التحقق الإضافي للمالك: المفتاح مشفر AES-256-GCM (مفتاح التشفير بمتغير بيئة، مو بالقاعدة)
  totp_enabled_at      timestamptz,                               -- null = المفتاح المعلق لسه ما انفعل (ما يُقبل للدخول)
  totp_last_step       bigint,                                    -- آخر خطوة وقت مقبولة: تمنع إعادة استخدام نفس الرمز
  failed_logins        int not null default 0,
  locked_until         timestamptz,
  created_by           bigint references users(id),
  created_at           timestamptz not null default now(),
  deactivated_at       timestamptz,
  deactivated_by       bigint references users(id),
  check (role = 'owner' or branch_id is not null),
  check (is_active or deactivated_at is not null),
  check (totp_enabled_at is null or totp_secret_enc is not null)
);
create unique index users_username_uq on users (lower(username));

-- راتب الموظف ونسبة الطبيب: كل سجل يمثل الحالة الكاملة من تاريخه (null = غير محدد / ماكو نسبة).
-- التغيير يبدي من تاريخه وما يغير اللي قبله. الطبيب بدون راتب = "الراتب ما انحدد".
create table pay_rules (
  id              bigint generated always as identity primary key,
  user_id         bigint not null references users(id),
  effective_from  date not null,
  monthly_salary  bigint check (monthly_salary >= 0),
  consult_percent numeric(5,2) check (consult_percent between 0 and 100),  -- للأطباء بس، ويحددها المالك
  set_by          bigint not null references users(id),
  created_at      timestamptz not null default now(),
  unique (user_id, effective_from)
);

create table doctors (
  user_id  bigint primary key references users(id),
  title    text,
  room     text,
  notes    text
);

-- دوام الطبيب الأسبوعي (weekday: 1=الاثنين ... 7=الأحد). فترة وحدة لليوم بالفترة الزمنية.
create table doctor_schedules (
  id             bigint generated always as identity primary key,
  doctor_id      bigint not null references doctors(user_id),
  weekday        smallint not null check (weekday between 1 and 7),
  start_time     time not null,
  end_time       time not null,
  effective_from date not null,
  effective_to   date,
  created_by     bigint not null references users(id),
  created_at     timestamptz not null default now(),
  check (end_time > start_time),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (
    doctor_id with =, weekday with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
  )
);

-- إلغاء يوم دوام طبيب (يحرك كشفياته ومراجعاته بس، مو الجلسات)
create table doctor_days_off (
  id           bigint generated always as identity primary key,
  doctor_id    bigint not null references doctors(user_id),
  off_date     date not null,
  reason       text,
  created_by   bigint not null references users(id),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by bigint references users(id)
);
create unique index doctor_days_off_uq on doctor_days_off (doctor_id, off_date) where cancelled_at is null;

-- أيام دوام العيادة
create table clinic_weekdays (
  branch_id bigint not null references branches(id),
  weekday   smallint not null check (weekday between 1 and 7),
  is_open   boolean not null default true,
  primary key (branch_id, weekday)
);

create table holidays (
  id           bigint generated always as identity primary key,
  branch_id    bigint not null references branches(id),
  holiday_date date not null,
  name         text not null,
  kind         text not null default 'official' check (kind in ('official','sudden')),
  created_by   bigint not null references users(id),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,          -- إلغاء عطلة قادمة ما يرجع الحجوزات اللي انتقلت (افتراض بانتظار التأكيد)
  cancelled_by bigint references users(id)
);
create unique index holidays_uq on holidays (branch_id, holiday_date) where cancelled_at is null;

-- ================================================================== الزبائن
create table customers (
  id                 bigint generated always as identity primary key,
  branch_id          bigint not null references branches(id),     -- فرع التسجيل
  public_code        text not null unique,                        -- الرمز المميز (للبحث بس، مو كلمة سر)
  phone              text not null check (phone ~ '^\+9647[0-9]{9}$'),  -- موحد: 07xx = +9647xx
  full_name          text not null,
  gender             text check (gender in ('female','male')),
  birth_date         date,
  source             text not null check (source in ('app','cashier')),
  app_registered_at  timestamptz,
  app_deleted_at     timestamptz,                                 -- حذف الحساب من التطبيق: السجل العلاجي والمالي يبقى
  status             text not null default 'active' check (status in ('active','merged')),
  merged_into_id     bigint references customers(id),
  points_balance     int not null default 0,                      -- يتحدث بس من points_ledger (trigger)، وممكن يصير سالب بعد الاسترجاع
  notify_offers      boolean not null default true,
  created_by         bigint references users(id),                 -- null = سجل نفسه من التطبيق
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((status = 'merged') = (merged_into_id is not null))
);
create unique index customers_phone_uq on customers (phone) where status = 'active';

create table customer_devices (
  id           bigint generated always as identity primary key,
  customer_id  bigint not null references customers(id),
  platform     text not null check (platform in ('ios','android')),
  push_token   text not null unique,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create table otp_requests (
  id          bigint generated always as identity primary key,
  phone       text not null,
  purpose     text not null check (purpose in ('register','login','change_phone')),
  customer_id bigint references customers(id),
  code_hash   text not null,
  attempts    smallint not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index otp_requests_phone_idx on otp_requests (phone, created_at desc);

create table refresh_tokens (
  id          bigint generated always as identity primary key,
  user_id     bigint references users(id),
  customer_id bigint references customers(id),
  token_hash  text not null unique,
  device      text,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  check (num_nonnulls(user_id, customer_id) = 1)
);

-- رموز الاسترجاع للمالك لو ضاع التلفون: 8 رموز، كل واحد يُستخدم مرة وحدة. ينحفظ بصمتها (SHA-256) مو الرمز
create table totp_recovery_codes (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id),
  code_hash  text not null unique,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index totp_recovery_codes_user_idx on totp_recovery_codes (user_id) where used_at is null;

create table customer_merges (
  id                bigint generated always as identity primary key,
  from_customer_id  bigint not null references customers(id),
  into_customer_id  bigint not null references customers(id),
  reason            text not null,
  summary           jsonb,
  merged_by         bigint not null references users(id),         -- المالك بس
  created_at        timestamptz not null default now(),
  check (from_customer_id <> into_customer_id)
);

-- ================================================================== المرفقات (صور وملفات)
create table attachments (
  id           bigint generated always as identity primary key,
  branch_id    bigint not null references branches(id),
  kind         text not null check (kind in ('purchase_receipt','expense_proof','supplier_payment_proof','before_after','receipt_pdf','logo')),
  storage_key  text not null unique,
  mime         text not null,
  size_bytes   bigint not null check (size_bytes > 0),
  sha256       text not null,
  customer_id  bigint references customers(id),                   -- لصور قبل وبعد (تحديد من يشوفها)
  uploaded_by  bigint references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,                                       -- حذف ناعم (المالك بس لصور قبل وبعد)
  deleted_by   bigint references users(id),
  check (kind <> 'before_after' or customer_id is not null)
);

-- ================================================================== المخزون: المواد والموردين
create table materials (
  id             bigint generated always as identity primary key,
  branch_id      bigint not null references branches(id),
  name           text not null,
  base_unit      text not null,                                   -- وحدة الاستهلاك (cc / قطعة)
  pack_unit      text not null,                                   -- وحدة الشراء (كرتون)
  mid_unit       text,                                            -- وسطية اختيارية (علبة)
  mid_per_pack   numeric(12,3) check (mid_per_pack > 0),
  base_per_mid   numeric(12,3) not null default 1 check (base_per_mid > 0),
  base_per_pack  numeric(14,3) generated always as (coalesce(mid_per_pack, 1) * base_per_mid) stored,
  low_threshold  numeric(14,3) not null default 0 check (low_threshold >= 0),   -- على المتاح
  last_unit_cost numeric(18,4) check (last_unit_cost >= 0),       -- آخر سعر شراء لوحدة الاستهلاك (للمخزون السالب)
  is_active      boolean not null default true,
  version        int not null default 1,
  created_by     bigint references users(id),
  created_at     timestamptz not null default now(),
  check ((mid_unit is null) = (mid_per_pack is null))
);
create unique index materials_name_uq on materials (branch_id, lower(name));

create table suppliers (
  id              bigint generated always as identity primary key,
  branch_id       bigint not null references branches(id),
  name            text not null,
  phone           text,
  notes           text,
  opening_balance bigint not null default 0,                      -- اللي علينا قبل ما يبدي النظام
  is_active       boolean not null default true,
  created_by      bigint references users(id),
  created_at      timestamptz not null default now()
);
create unique index suppliers_name_uq on suppliers (branch_id, lower(btrim(name)));   -- الاسم فريد حتى بين المعطلين

create table purchases (
  id                    bigint generated always as identity primary key,
  branch_id             bigint not null references branches(id),
  supplier_id           bigint not null references suppliers(id),
  invoice_no            text,
  purchase_date         date not null,
  total_amount          bigint not null check (total_amount > 0),
  receipt_attachment_id bigint not null references attachments(id),   -- صورة الوصل إلزامية
  status                text not null default 'posted' check (status in ('posted','voided')),  -- voided: مقترح بانتظار التأكيد
  void_reason           text,
  voided_by             bigint references users(id),
  voided_at             timestamptz,
  created_by            bigint not null references users(id),
  created_at            timestamptz not null default now(),
  check (status = 'posted' or (void_reason is not null and voided_by is not null))
);
create unique index purchases_invoice_uq on purchases (supplier_id, invoice_no) where invoice_no is not null and status = 'posted';
create unique index purchases_receipt_uq on purchases (receipt_attachment_id);   -- صورة وصل وحدة لفاتورة وحدة

create table purchase_items (
  id            bigint generated always as identity primary key,
  purchase_id   bigint not null references purchases(id),
  material_id   bigint not null references materials(id),
  qty_pack      numeric(14,3) not null check (qty_pack > 0),       -- المكتوب بالفاتورة (كراتين)
  qty_base      numeric(14,3) not null check (qty_base > 0),       -- بوحدة الاستهلاك بعد التحويل
  unit_cost     numeric(18,4) not null check (unit_cost >= 0),     -- = line_total / qty_base
  line_total    bigint not null check (line_total >= 0),
  expiry_date   date not null
);

create table material_batches (
  id               bigint generated always as identity primary key,
  branch_id        bigint not null references branches(id),
  material_id      bigint not null references materials(id),
  source           text not null check (source in ('purchase','opening','count')),
  purchase_item_id bigint unique references purchase_items(id),
  received_on      date not null,
  expiry_date      date not null,
  unit_cost        numeric(18,4) not null check (unit_cost >= 0),
  qty_initial      numeric(14,3) not null check (qty_initial > 0),
  qty_on_hand      numeric(14,3) not null check (qty_on_hand >= 0),   -- يتحدث بـ trigger من stock_movements
  created_at       timestamptz not null default now(),
  check (source <> 'purchase' or purchase_item_id is not null)
);
create index material_batches_fifo_idx on material_batches (material_id, expiry_date) where qty_on_hand > 0;

create table stock_waste (
  id          bigint generated always as identity primary key,
  branch_id   bigint not null references branches(id),
  material_id bigint not null references materials(id),
  batch_id    bigint not null references material_batches(id),
  qty         numeric(14,3) not null check (qty > 0),
  reason      text not null check (reason in ('expired','damaged','opened_unused','prep_error','other')),
  note        text,
  cost_amount bigint not null check (cost_amount >= 0),            -- الكمية × كلفة الدفعة
  wasted_on   date not null default clinic_today(),
  created_by  bigint not null references users(id),
  created_at  timestamptz not null default now(),
  check (reason <> 'other' or btrim(coalesce(note, '')) <> '')
);

create table stock_counts (
  id          bigint generated always as identity primary key,
  branch_id   bigint not null references branches(id),
  count_date  date not null default clinic_today(),
  status      text not null default 'draft' check (status in ('draft','posted')),
  note        text,
  created_by  bigint not null references users(id),
  posted_by   bigint references users(id),
  posted_at   timestamptz,
  created_at  timestamptz not null default now(),
  check (status = 'draft' or posted_at is not null)
);

-- بند الجرد: line_kind='batch' لدفعة موجودة، و 'material_level' لتصحيح مادة سالبة/بدون دفعات (تنفتح دفعة جديدة)
create table stock_count_lines (
  id                  bigint generated always as identity primary key,
  count_id            bigint not null references stock_counts(id),
  material_id         bigint not null references materials(id),
  batch_id            bigint references material_batches(id),
  line_kind           text not null check (line_kind in ('batch','material_level')),
  system_qty          numeric(14,3) not null,
  actual_qty          numeric(14,3) check (actual_qty >= 0),       -- null = الخانة فارغة = ما تتغير
  diff_qty            numeric(14,3) generated always as (coalesce(actual_qty - system_qty, 0)) stored,
  note                text,
  new_batch_expiry    date,
  new_batch_unit_cost numeric(18,4),                               -- آخر سعر شراء
  unique (count_id, batch_id),
  check ((line_kind = 'batch') = (batch_id is not null)),
  check (line_kind = 'batch' or (actual_qty is not null and new_batch_expiry is not null and new_batch_unit_cost is not null)),
  check (coalesce(actual_qty - system_qty, 0) = 0 or btrim(coalesce(note, '')) <> '')   -- أي فرق يحتاج ملاحظة
);

create table supplier_returns (
  id            bigint generated always as identity primary key,
  branch_id     bigint not null references branches(id),
  supplier_id   bigint not null references suppliers(id),
  purchase_id   bigint not null references purchases(id),
  return_date   date not null default clinic_today(),
  reason        text not null,
  credit_amount bigint not null check (credit_amount > 0),         -- ينقص اللي علينا للمورد
  created_by    bigint not null references users(id),
  created_at    timestamptz not null default now()
);

create table supplier_return_items (
  id               bigint generated always as identity primary key,
  return_id        bigint not null references supplier_returns(id),
  purchase_item_id bigint not null references purchase_items(id),
  batch_id         bigint not null references material_batches(id),
  qty_base         numeric(14,3) not null check (qty_base > 0),
  credit_amount    bigint not null check (credit_amount >= 0)
);

-- ================================================================== الخدمات وحقولها وأسعارها
create table services (
  id            bigint generated always as identity primary key,
  branch_id     bigint not null references branches(id),
  name_ar       text not null,
  name_en       text,
  kind          text not null check (kind in ('consultation','treatment')),
  pricing_model text not null check (pricing_model in ('fixed','per_unit','per_option')),
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  version       int not null default 1,                            -- قفل تفاؤلي: الحفظ القديم يرفض
  created_by    bigint references users(id),
  created_at    timestamptz not null default now()
);
create unique index services_one_consultation_uq on services (branch_id) where kind = 'consultation' and is_active;

-- تاريخ السعر: السعر المعتمد هو آخر سجل effective_from <= وقت الدفع
create table service_prices (
  id             bigint generated always as identity primary key,
  service_id     bigint not null references services(id),
  price          bigint not null check (price >= 0),               -- للجلسة (fixed) أو للوحدة، مثل cc (per_unit)
  effective_from timestamptz not null default now(),
  set_by         bigint not null references users(id),
  unique (service_id, effective_from)
);

create table service_fields (
  id           bigint generated always as identity primary key,
  service_id   bigint not null references services(id),
  field_key    text not null,
  label_ar     text not null,
  label_en     text,
  field_type   text not null check (field_type in ('number','select','multi_select','text','bool')),
  unit_label   text,
  is_required  boolean not null default false,
  pricing_role text not null default 'none' check (pricing_role in ('none','quantity','option')),
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  version      int not null default 1,
  unique (service_id, field_key)
);

-- نسخة لكل تعديل: بند الخطة يشير للنسخة اللي انكتب بيها
create table service_field_versions (
  id          bigint generated always as identity primary key,
  field_id    bigint not null references service_fields(id),
  version_no  int not null,
  definition  jsonb not null,
  changed_by  bigint not null references users(id),
  changed_at  timestamptz not null default now(),
  unique (field_id, version_no)
);

-- خيارات الحقل (مناطق الليزر...). is_exclusive: مثل «فول بدي» ينلغي معه باقي الخيارات
create table service_options (
  id           bigint generated always as identity primary key,
  field_id     bigint not null references service_fields(id),
  label_ar     text not null,
  label_en     text,
  is_exclusive boolean not null default false,
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  version      int not null default 1
);

create table option_prices (
  id             bigint generated always as identity primary key,
  option_id      bigint not null references service_options(id),
  price          bigint not null check (price >= 0),
  effective_from timestamptz not null default now(),
  set_by         bigint not null references users(id),
  unique (option_id, effective_from)
);

-- ربط الحقل/الخدمة بالمادة: الاستهلاك = قيمة الحقل × factor، أو كمية ثابتة للجلسة
create table service_materials (
  id          bigint generated always as identity primary key,
  service_id  bigint not null references services(id),
  field_id    bigint references service_fields(id),
  material_id bigint not null references materials(id),
  formula     text not null check (formula in ('per_field_value','fixed_per_session')),
  factor      numeric(14,4) not null check (factor > 0),
  check ((formula = 'per_field_value') = (field_id is not null))
);

-- ================================================================== الحجز والزيارة
-- صف لكل يوم: قفله (FOR UPDATE) يحمي الحد اليومي ورقم التسلسل من الحجز المتزامن
create table booking_days (
  branch_id  bigint not null references branches(id),
  day        date not null,
  used_slots int not null default 0 check (used_slots >= 0),       -- يتجاوز الحد لو نزل الحد بعد الحجز (الحجوزات القديمة تبقى)
  last_seq   int not null default 0 check (last_seq >= 0),
  stopped_at  timestamptz,                                          -- المدير أوقف الحجز الجديد لهذا اليوم (الحجوزات الموجودة تبقى)
  stopped_by  bigint references users(id),
  stop_reason text,
  primary key (branch_id, day),
  check ((stopped_at is null) = (stopped_by is null))
);

-- الزيارة = مكان واحد ورقم تسلسل واحد، مهما كان بيها (كشفية وأكثر من جلسة)
create table visits (
  id             bigint generated always as identity primary key,
  branch_id      bigint not null references branches(id),
  customer_id    bigint not null references customers(id),
  visit_date     date not null,
  seq_no         int not null check (seq_no > 0),                  -- الرقم الملغى ما ينعاد استخدامه
  status         text not null default 'booked' check (status in ('booked','arrived','missed','cancelled')),
  source         text not null check (source in ('app','cashier')),
  doctor_id      bigint references doctors(user_id),               -- للزيارة اللي بيها كشفية/مراجعة
  created_by     bigint references users(id),                      -- null = الزبون من التطبيق
  cancel_reason  text,
  cancelled_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (branch_id, visit_date, seq_no),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create unique index visits_one_per_day_uq on visits (customer_id, visit_date) where status in ('booked','arrived');
create index visits_day_idx on visits (branch_id, visit_date, seq_no);

create table consultations (
  id                     bigint generated always as identity primary key,
  branch_id              bigint not null references branches(id),
  visit_id               bigint not null references visits(id),
  customer_id            bigint not null references customers(id),
  doctor_id              bigint not null references doctors(user_id),
  kind                   text not null default 'new' check (kind in ('new','free_followup','sessions_only')),   -- sessions_only: «جلسات فقط»: كشفية بسعر قابل للضبط (الافتراضي 0 = مجانية)
  parent_consultation_id bigint references consultations(id),      -- المراجعة المجانية ترتبط بكشفيتها خلال 7 أيام
  booking_note           text check (booking_note is null or char_length(booking_note) between 1 and 500),   -- ملاحظة الزبون وقت الحجز (ليش يريد الخدمة، حساسية...)
  interest_service_id    bigint references services(id),           -- الخدمة اللي يريدها الزبون وقت الحجز (اختياري، للطبيب بس)
  status                 text not null default 'awaiting_payment'
                         check (status in ('awaiting_payment','paid','with_doctor','finished','cancelled')),
  entered_at             timestamptz,                              -- الطبيب فتح ملفه: من هنا ما تنسترجع
  finished_at            timestamptz,
  created_at             timestamptz not null default now(),
  check ((kind = 'free_followup') = (parent_consultation_id is not null)),
  check (status not in ('with_doctor','finished') or entered_at is not null),
  check (status <> 'finished' or finished_at is not null)
);
create unique index consultations_one_per_visit_uq on consultations (visit_id) where status <> 'cancelled';
create index consultations_doctor_day_idx on consultations (doctor_id, status);

-- المعلومات الصحية: إضافة فقط، آخر سجل هو الحالي
create table customer_health (
  id                  bigint generated always as identity primary key,
  customer_id         bigint not null references customers(id),
  consultation_id     bigint references consultations(id),
  recorded_by         bigint not null references users(id),        -- الطبيب
  allergies           text,
  pregnancy           text not null default 'unknown' check (pregnancy in ('no','yes','unknown')),
  chronic_conditions  text,
  medications         text,
  notes               text,
  created_at          timestamptz not null default now()
);
create index customer_health_latest_idx on customer_health (customer_id, created_at desc);

-- ================================================================== الخطة العلاجية والجلسات
create table treatment_plans (
  id                  bigint generated always as identity primary key,
  branch_id           bigint not null references branches(id),
  customer_id         bigint not null references customers(id),
  consultation_id     bigint not null references consultations(id),
  doctor_id           bigint not null references doctors(user_id),
  status              text not null default 'draft' check (status in ('draft','active','stopped','completed')),
  treatments_text     text,                                        -- العلاجات (نص حر)
  draft_failure_reason text,                                       -- لو فشل حجز الجلسات: تبقى مسودة بسبب الفشل
  stopped_at          timestamptz,
  stopped_by          bigint references users(id),
  stop_reason         text,
  version             int not null default 1,
  created_at          timestamptz not null default now(),
  check (status <> 'stopped' or (stopped_at is not null and stopped_by is not null))
);

create table plan_items (
  id                 bigint generated always as identity primary key,
  plan_id            bigint not null references treatment_plans(id),
  service_id         bigint not null references services(id),
  sessions_count     smallint not null check (sessions_count between 1 and 60),
  interval_days      smallint not null default 0 check (interval_days >= 0),   -- أقل فرق بين جلسة وجلسة
  first_session_date date not null,
  note               text,
  sort_order         int not null default 0
);

create table plan_item_values (
  id               bigint generated always as identity primary key,
  plan_item_id     bigint not null references plan_items(id),
  field_id         bigint not null references service_fields(id),
  field_version_id bigint not null references service_field_versions(id),
  value_number     numeric(14,3),
  value_text       text,
  value_bool       boolean,
  unique (plan_item_id, field_id),
  check (num_nonnulls(value_number, value_text, value_bool) <= 1)
);

create table plan_item_value_options (
  plan_item_value_id bigint not null references plan_item_values(id),
  option_id          bigint not null references service_options(id),
  primary key (plan_item_value_id, option_id)
);

create table treatment_sessions (
  id                 bigint generated always as identity primary key,
  branch_id          bigint not null references branches(id),
  customer_id        bigint not null references customers(id),
  plan_item_id       bigint not null references plan_items(id),
  seq_no             smallint not null check (seq_no > 0),         -- ترتيب الجلسة بالخطة
  status             text not null default 'awaiting_booking'
                     check (status in ('awaiting_booking','booked','paid','completed','cancelled')),
  scheduled_date     date,
  doctor_planned_date date not null,                               -- التاريخ اللي كتبه الطبيب (للمقارنة)
  visit_id           bigint references visits(id),
  completed_at       timestamptz,
  completed_by       bigint references users(id),                  -- الممرض بس
  cancelled_at       timestamptz,
  cancel_reason      text,
  version            int not null default 1,
  created_at         timestamptz not null default now(),
  unique (plan_item_id, seq_no),
  check (status not in ('booked','paid') or (visit_id is not null and scheduled_date is not null)),
  check (status <> 'awaiting_booking' or visit_id is null),
  check (status <> 'completed' or (completed_at is not null and completed_by is not null)),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create index treatment_sessions_customer_idx on treatment_sessions (customer_id, status);
create index treatment_sessions_visit_idx on treatment_sessions (visit_id) where visit_id is not null;
create index treatment_sessions_day_idx on treatment_sessions (branch_id, scheduled_date, status);

-- التراجع عن تأكيد جلسة انضغط بالغلط (المدير/المالك، بسبب إلزامي)
create table confirmation_reverts (
  id          bigint generated always as identity primary key,
  session_id  bigint not null references treatment_sessions(id),
  reverted_by bigint not null references users(id),
  reason      text not null check (btrim(reason) <> ''),
  reverted_at timestamptz not null default now(),
  original_completed_at timestamptz not null,                      -- لقطة التأكيد المتراجع عنه: الإيراد ينعكس بتاريخ التصحيح وما يمحى من يومه الأصلي
  original_completed_by bigint not null references users(id),
  payment_item_id bigint not null                                 -- بند الوصل اللي كان فعال وقت التأكيد (لعكس إيراده بالتقارير بالمبلغ الصحيح)؛ المفتاح الأجنبي يُضاف بعد جدول البنود
);
create index confirmation_reverts_session_idx on confirmation_reverts (session_id);

-- تاريخ نقل المواعيد (الحجز، النقل، التحرير، الفوات) لعرض «قبل/بعد» وللتدقيق
create table booking_events (
  id                    bigint generated always as identity primary key,
  visit_id              bigint references visits(id),
  consultation_id       bigint references consultations(id),
  treatment_session_id  bigint references treatment_sessions(id),
  event                 text not null check (event in ('booked','moved','postponed_by_customer','moved_by_cashier',
                          'moved_by_closure','rolled_over','released_missed','released_chain','cancelled','missed','arrived')),
  from_date             date,
  to_date               date,
  from_seq              int,
  to_seq                int,
  actor_user_id         bigint references users(id),
  actor_customer_id     bigint references customers(id),
  reason                text,
  created_at            timestamptz not null default now(),
  check (num_nonnulls(visit_id, consultation_id, treatment_session_id) >= 1)
);

create table session_photos (
  id                   bigint generated always as identity primary key,
  attachment_id        bigint not null unique references attachments(id),
  customer_id          bigint not null references customers(id),
  consultation_id      bigint references consultations(id),
  treatment_session_id bigint references treatment_sessions(id),
  phase                text not null check (phase in ('before','after')),
  body_area            text,
  uploaded_by          bigint not null references users(id),
  created_at           timestamptz not null default now(),
  check (num_nonnulls(consultation_id, treatment_session_id) >= 1)
);

-- ================================================================== حركات المخزون
-- ledger إضافة فقط. الكمية الموجبة دخول والسالبة خروج. batch_id فارغ = مخزون سالب بدون دفعة (يتكلف بآخر سعر شراء)
create table stock_movements (
  id                     bigint generated always as identity primary key,
  branch_id              bigint not null references branches(id),
  material_id            bigint not null references materials(id),
  batch_id               bigint references material_batches(id),
  movement_type          text not null check (movement_type in
                          ('purchase','opening','consume','consume_reversal','waste','count_adjust','supplier_return','purchase_void')),
  qty_delta              numeric(14,3) not null check (qty_delta <> 0),
  unit_cost              numeric(18,4) not null check (unit_cost >= 0),
  cost_amount            bigint not null,                          -- موقّع = تقريب(qty_delta × unit_cost)
  business_date          date not null default clinic_today(),
  occurred_at            timestamptz not null default now(),
  purchase_item_id       bigint references purchase_items(id),
  treatment_session_id   bigint references treatment_sessions(id),
  waste_id               bigint references stock_waste(id),
  count_line_id          bigint references stock_count_lines(id),
  supplier_return_item_id bigint references supplier_return_items(id),
  reverses_movement_id   bigint references stock_movements(id),
  note                   text,
  created_by             bigint references users(id),
  check (num_nonnulls(purchase_item_id, treatment_session_id, waste_id, count_line_id, supplier_return_item_id) <= 1),
  check (movement_type not in ('purchase','opening','consume_reversal') or qty_delta > 0),
  check (movement_type not in ('consume','waste','supplier_return','purchase_void') or qty_delta < 0),   -- purchase_void: عكس مخزون فاتورة شراء ملغاة
  check (movement_type not in ('purchase','purchase_void') or purchase_item_id is not null),
  check (movement_type not in ('consume','consume_reversal') or treatment_session_id is not null),
  check (movement_type <> 'waste' or waste_id is not null),
  check (movement_type <> 'supplier_return' or supplier_return_item_id is not null),
  check (movement_type <> 'consume_reversal' or reverses_movement_id is not null)
);
create index stock_movements_material_idx on stock_movements (material_id, occurred_at);
create index stock_movements_batch_idx on stock_movements (batch_id) where batch_id is not null;
create index stock_movements_session_idx on stock_movements (treatment_session_id) where treatment_session_id is not null;

-- المحجوز: لقطة الاستهلاك المتوقع للجلسة وقت دفعها. تنحسب محجوزة وهي بحالة paid بس
create table session_material_needs (
  treatment_session_id bigint not null references treatment_sessions(id),
  material_id          bigint not null references materials(id),
  qty_base             numeric(14,3) not null check (qty_base > 0),
  primary key (treatment_session_id, material_id)
);

-- ================================================================== الدفع
create table payment_methods (
  id            bigint generated always as identity primary key,
  branch_id     bigint not null references branches(id),
  name_ar       text not null,
  name_en       text,
  kind          text not null check (kind in ('cash','electronic')),
  device_label  text,                                              -- اسم الجهاز/المصرف للإلكتروني
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  check (kind = 'cash' or btrim(coalesce(device_label, '')) <> '')   -- اسم الجهاز/المصرف إلزامي للإلكتروني
);
create unique index payment_methods_label_uq on payment_methods (branch_id, lower(btrim(name_ar)), lower(btrim(coalesce(device_label, ''))));   -- كل جزء يتقص لحاله حتى مسافة بنهاية الاسم ما تهرّب التكرار
create unique index payment_methods_one_cash_uq on payment_methods (branch_id) where kind = 'cash' and is_active;

-- المدير يدخل المبلغ. الطلب يرتبط بزبون وزيارة، ويستخدم مرة وحدة (payments.discount_request_id unique)
create table discount_requests (
  id            bigint generated always as identity primary key,
  branch_id     bigint not null references branches(id),
  customer_id   bigint not null references customers(id),
  visit_id      bigint references visits(id),
  basket        jsonb not null,                                    -- لقطة البنود وقت الطلب
  status        text not null default 'pending' check (status in ('pending','approved','rejected','used','expired','cancelled')),
  requested_by  bigint not null references users(id),              -- الكاشير
  requested_at  timestamptz not null default now(),
  amount        bigint check (amount > 0),
  decided_by    bigint references users(id),                       -- المدير أو المالك
  decided_at    timestamptz,
  decision_note text,
  check (status not in ('approved','used') or (amount is not null and decided_by is not null))
);
create index discount_requests_pending_idx on discount_requests (branch_id, status) where status = 'pending';

create table offers (
  id                   bigint generated always as identity primary key,
  branch_id            bigint not null references branches(id),
  service_id           bigint not null references services(id),
  title                text not null,
  percent              numeric(5,2) not null check (percent > 0 and percent < 100),
  start_date           date not null,
  end_date             date not null,
  notify_audience      text not null default 'all' check (notify_audience in ('all','did_service','none')),
  notify_service_id    bigint references services(id),             -- فئة: اللي سووا الخدمة قبل
  notify_title         text,
  notify_body          text,                                        -- النص الافتراضي بدون اسم علاج
  notify_at            date,                                        -- افتراضياً يوم بداية العرض
  notification_sent_at timestamptz,
  status               text not null default 'scheduled' check (status in ('scheduled','active','ended','cancelled')),
  version              int not null default 1,
  created_by           bigint not null references users(id),
  created_at           timestamptz not null default now(),
  check (end_date >= start_date),
  check (notify_audience <> 'did_service' or notify_service_id is not null),
  exclude using gist (service_id with =, daterange(start_date, end_date, '[]') with &&) where (status <> 'cancelled')
);

-- ================================================================== الشفتات
create table shifts (
  id             bigint generated always as identity primary key,
  branch_id      bigint not null references branches(id),
  cashier_id     bigint not null references users(id),
  opened_at      timestamptz not null default now(),
  opening_float  bigint not null check (opening_float >= 0),       -- الفكة اللي استلمها من المدير
  float_given_by bigint references users(id),
  status         text not null default 'open' check (status in ('open','closed','confirmed')),
  closed_at      timestamptz,
  confirmed_by   bigint references users(id),
  confirmed_at   timestamptz,
  check (status = 'open' or closed_at is not null),
  check (status <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null))
);
create unique index shifts_one_open_per_cashier_uq on shifts (cashier_id) where status = 'open';

create table number_counters (
  branch_id  bigint not null references branches(id),
  kind       text not null check (kind in ('receipt','refund')),
  year       smallint not null,
  last_value int not null default 0 check (last_value >= 0),
  primary key (branch_id, kind, year)
);

create table payments (
  id                   bigint generated always as identity primary key,
  branch_id            bigint not null references branches(id),
  receipt_no           text not null,                              -- 2026-00125 (يتعزل LTR بالعرض)
  customer_id          bigint not null references customers(id),
  visit_id             bigint references visits(id),
  shift_id             bigint not null references shifts(id),
  cashier_id           bigint not null references users(id),
  kind                 text not null check (kind in ('consultation','sessions')),
  status               text not null default 'paid' check (status in ('paid','partially_refunded','refunded')),
  gross_amount         bigint not null check (gross_amount >= 0),
  offer_discount       bigint not null default 0 check (offer_discount >= 0),
  manual_discount      bigint not null default 0 check (manual_discount >= 0),
  points_discount      bigint not null default 0 check (points_discount >= 0),
  rounding_amount      bigint not null default 0 check (rounding_amount >= 0),   -- التقريب لصالح الزبون
  net_amount           bigint not null check (net_amount >= 0),
  points_used          int not null default 0 check (points_used >= 0),
  points_earned        int not null default 0 check (points_earned >= 0),
  discount_request_id  bigint unique references discount_requests(id),
  clinic_snapshot      jsonb not null,                             -- اسم العيادة والشعار والعنوان والتلفون وقت الإصدار
  pdf_attachment_id    bigint references attachments(id),
  paid_at              timestamptz not null default now(),
  business_date        date not null default clinic_today(),
  created_at           timestamptz not null default now(),
  unique (branch_id, receipt_no),
  check (net_amount = gross_amount - offer_discount - manual_discount - points_discount - rounding_amount),
  check (net_amount > 0 or points_earned = 0)                         -- الوصل الصفري ما يكسب نقاط
);
create index payments_customer_idx on payments (customer_id, paid_at desc);
create index payments_shift_idx on payments (shift_id);
create index payments_day_idx on payments (branch_id, business_date);

create table payment_items (
  id                    bigint generated always as identity primary key,
  payment_id            bigint not null references payments(id),
  item_type             text not null check (item_type in ('consultation','session')),
  consultation_id       bigint references consultations(id),
  session_id            bigint references treatment_sessions(id),
  service_id            bigint not null references services(id),
  service_name          text not null,
  quantity              numeric(14,3) not null default 1 check (quantity > 0),
  list_price            bigint not null check (list_price >= 0),   -- سعر البند (سعر × كمية) وقت الدفع
  offer_id              bigint references offers(id),
  offer_percent         numeric(5,2),
  offer_discount        bigint not null default 0 check (offer_discount >= 0),
  manual_discount_share bigint not null default 0 check (manual_discount_share >= 0),
  points_discount_share bigint not null default 0 check (points_discount_share >= 0),
  points_used_share     int not null default 0 check (points_used_share >= 0),
  rounding_share        bigint not null default 0 check (rounding_share >= 0),
  net_amount            bigint not null check (net_amount >= 0),   -- الاسترجاع الجزئي يرجع هذا الرقم بالضبط
  pricing_snapshot      jsonb,                                     -- سعر الوحدة، أسعار الخيارات، القيم المكتوبة
  status                text not null default 'paid' check (status in ('paid','refunded')),
  check ((item_type = 'consultation') = (consultation_id is not null)),
  check ((item_type = 'session') = (session_id is not null)),
  check (net_amount = list_price - offer_discount - manual_discount_share - points_discount_share - rounding_share)
);
alter table confirmation_reverts add constraint confirmation_reverts_item_fk foreign key (payment_item_id) references payment_items(id);

-- دفعتين لنفس الجلسة أو الكشفية: وحدة بس تنجح (الثانية تفشل هنا حتى لو فلتت من فحص التطبيق)
create unique index payment_items_session_paid_uq on payment_items (session_id) where status = 'paid' and session_id is not null;
create unique index payment_items_consult_paid_uq on payment_items (consultation_id) where status = 'paid' and consultation_id is not null;
create index payment_items_payment_idx on payment_items (payment_id);

-- كم اندفع بكل طريقة (الوصل الواحد ينقسم على أكثر من طريقة). اسم الطريقة والجهاز ينحفظ مع الدفعة
create table payment_tenders (
  id           bigint generated always as identity primary key,
  payment_id   bigint not null references payments(id),
  method_id    bigint not null references payment_methods(id),
  method_name  text not null,
  method_kind  text not null check (method_kind in ('cash','electronic')),
  device_label text,
  amount       bigint not null check (amount > 0),
  reference    text
);
create index payment_tenders_payment_idx on payment_tenders (payment_id);

create table receipt_prints (
  id          bigint generated always as identity primary key,
  payment_id  bigint not null references payments(id),
  printed_by  bigint not null references users(id),
  printed_at  timestamptz not null default now(),
  is_reprint  boolean not null default false,
  note        text
);

create table refunds (
  id                    bigint generated always as identity primary key,
  branch_id             bigint not null references branches(id),
  payment_id            bigint not null references payments(id),   -- يبقى مرتبط بالوصل الأصلي حتى لو بشفت سابق
  refund_no             text not null,
  shift_id              bigint not null references shifts(id),     -- شفت الكاشير الحالي
  cashier_id            bigint not null references users(id),
  total_amount          bigint not null check (total_amount > 0),
  points_returned       int not null default 0 check (points_returned >= 0),     -- المنصرفة بالدفع ترجع
  points_clawed_back    int not null default 0 check (points_clawed_back >= 0),  -- المكتسبة تنسحب
  reason                text not null check (btrim(reason) <> ''),
  refunded_at           timestamptz not null default now(),
  business_date         date not null default clinic_today(),
  unique (branch_id, refund_no)
);

create table refund_items (
  id               bigint generated always as identity primary key,
  refund_id        bigint not null references refunds(id),
  payment_item_id  bigint not null unique references payment_items(id),
  amount           bigint not null check (amount > 0)
);

-- كل استرجاع يحفظ طريقتين: طريقة الدفع الأصلية وطريقة إرجاع الفلوس الفعلية
create table refund_tenders (
  id                 bigint generated always as identity primary key,
  refund_id          bigint not null references refunds(id),
  original_method_id bigint not null references payment_methods(id),
  payout_method_id   bigint not null references payment_methods(id),
  payout_method_name text not null,
  payout_kind        text not null check (payout_kind in ('cash','electronic')),
  device_label       text,
  amount             bigint not null check (amount > 0)
);

-- كل طريقة/جهاز بالشفت: المقبوض والمرتجع والمتوقع، وعدّ الكاشير، وتأكيد المدير
create table shift_method_totals (
  id            bigint generated always as identity primary key,
  shift_id      bigint not null references shifts(id),
  method_id     bigint not null references payment_methods(id),
  method_name   text not null,
  method_kind   text not null check (method_kind in ('cash','electronic')),
  collected     bigint not null default 0,
  refunded      bigint not null default 0,
  expected      bigint not null,                                   -- كاش: الفكة + المقبوض − المرتجع. إلكتروني: المقبوض − المرتجع
  counted       bigint check (counted >= 0),                       -- اللي أدخله الكاشير (كاش معدود، أو كشف الجهاز)
  confirmed     bigint check (confirmed >= 0),                     -- اللي أكده المدير
  difference    bigint generated always as (confirmed - expected) stored,
  note          text,
  unique (shift_id, method_id),
  check (confirmed is null or confirmed = expected or btrim(coalesce(note, '')) <> '')
);

-- ================================================================== النقاط
create table points_ledger (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references customers(id),
  entry_type  text not null check (entry_type in ('earn','redeem','redeem_return','earn_clawback','merge_out','merge_in')),
  points      int not null check (points <> 0),
  payment_id  bigint references payments(id),
  refund_id   bigint references refunds(id),
  merge_id    bigint references customer_merges(id),
  note        text,
  created_by  bigint references users(id),
  created_at  timestamptz not null default now(),
  check (entry_type not in ('earn','redeem_return','merge_in') or points > 0),
  check (entry_type not in ('redeem','earn_clawback','merge_out') or points < 0),
  check (entry_type not in ('earn','redeem') or payment_id is not null),
  check (entry_type not in ('redeem_return','earn_clawback') or refund_id is not null),
  check (entry_type not in ('merge_in','merge_out') or merge_id is not null)
);
create unique index points_earn_once_uq on points_ledger (payment_id) where entry_type = 'earn';
create unique index points_redeem_once_uq on points_ledger (payment_id) where entry_type = 'redeem';
create unique index points_refund_once_uq on points_ledger (refund_id, entry_type) where refund_id is not null;
create index points_ledger_customer_idx on points_ledger (customer_id, created_at);

-- تعويض المالك عن جلسة تنفذت (مبلغ مستقل بسبب مكتوب، والمادة ما ترجع)
create table compensations (
  id           bigint generated always as identity primary key,
  branch_id    bigint not null references branches(id),
  customer_id  bigint not null references customers(id),
  session_id   bigint not null references treatment_sessions(id),
  amount       bigint not null check (amount > 0),
  reason       text not null check (btrim(reason) <> ''),
  pay_source   text not null check (pay_source in ('safe','electronic')),
  bank_name    text,
  decided_by   bigint not null references users(id),               -- المالك
  created_at   timestamptz not null default now(),
  check (pay_source <> 'electronic' or bank_name is not null)
);

-- ================================================================== المصاريف والخزنة والرواتب
create table expense_categories (
  id         bigint generated always as identity primary key,
  branch_id  bigint not null references branches(id),
  name       text not null,
  kind       text not null default 'operating' check (kind in ('operating','payment_fee','equipment')),
                                                                -- equipment: معدات طويلة الاستخدام، خارج مصروف التشغيل وخارج ربح الإدارة. payment_fee: عمولات الأجهزة والمصارف
  is_active  boolean not null default true,
  unique (branch_id, name)
);

create table expenses (
  id                  bigint generated always as identity primary key,
  branch_id           bigint not null references branches(id),
  category_id         bigint not null references expense_categories(id),
  amount              bigint not null check (amount > 0),
  expense_date        date not null,
  description         text,
  pay_source          text not null check (pay_source in ('safe','electronic')),
  bank_name           text,
  proof_attachment_id bigint not null references attachments(id),  -- صورة الإثبات إلزامية
  status              text not null default 'active' check (status in ('active','cancelled')),   -- الإلغاء مقترح بانتظار التأكيد
  cancel_reason       text,
  cancelled_by        bigint references users(id),
  version             int not null default 1,
  recorded_by         bigint not null references users(id),
  recorded_at         timestamptz not null default now(),
  check (pay_source <> 'electronic' or bank_name is not null),
  check (status = 'active' or (cancel_reason is not null and cancelled_by is not null))
);
create index expenses_date_idx on expenses (branch_id, expense_date);
create unique index expenses_proof_uq on expenses (proof_attachment_id);   -- صورة إثبات وحدة لمصروف واحد (ما تنستخدم لمصروفين)

-- تعديل المصروف بعد حفظه: المالك بس، بسبب إلزامي، والقديم والجديد ينحفظان
create table expense_edits (
  id          bigint generated always as identity primary key,
  expense_id  bigint not null references expenses(id),
  edited_by   bigint not null references users(id),
  reason      text not null check (btrim(reason) <> ''),
  old_values  jsonb not null,
  new_values  jsonb not null,
  edited_at   timestamptz not null default now()
);

create table owner_withdrawals (
  id                  bigint generated always as identity primary key,
  branch_id           bigint not null references branches(id),
  amount              bigint not null check (amount > 0),
  withdrawn_by_name   text not null,                               -- باسم منو
  withdrawal_date     date not null,
  note                text,
  status              text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),   -- cancelled: المدير ألغى طلبه قبل قرار المالك
  recorded_by         bigint not null references users(id),        -- المدير
  recorded_at         timestamptz not null default now(),
  decided_by          bigint references users(id),                 -- المالك
  decided_at          timestamptz,
  decision_note       text,
  check (status = 'pending' or (decided_by is not null and decided_at is not null))
);

create table supplier_payments (
  id                    bigint generated always as identity primary key,
  branch_id             bigint not null references branches(id),
  supplier_id           bigint not null references suppliers(id),
  purchase_id           bigint references purchases(id),           -- الجزء المدفوع وقت الشراء يرتبط بفاتورته
  amount                bigint not null check (amount > 0),
  pay_source            text not null check (pay_source in ('safe','electronic')),
  bank_name             text,
  paid_on               date not null,
  proof_attachment_id   bigint references attachments(id),
  created_by            bigint not null references users(id),
  created_at            timestamptz not null default now(),
  check (pay_source <> 'electronic' or bank_name is not null)
);
create index supplier_payments_supplier_idx on supplier_payments (supplier_id, paid_on);
create unique index supplier_payments_proof_uq on supplier_payments (proof_attachment_id) where proof_attachment_id is not null;   -- صورة إثبات وحدة لتسديد واحد

create table payroll_runs (
  id            bigint generated always as identity primary key,
  branch_id     bigint not null references branches(id),
  period_month  date not null check (extract(day from period_month) = 1),
  generated_at  timestamptz not null default now(),
  unique (branch_id, period_month)
);

create table payroll_items (
  id             bigint generated always as identity primary key,
  run_id         bigint not null references payroll_runs(id),
  user_id        bigint not null references users(id),
  role_snapshot  text not null,
  base_salary    bigint check (base_salary >= 0),                  -- null = الراتب ما انحدد
  consult_amount bigint not null default 0 check (consult_amount >= 0),   -- نسبة الطبيب من كشفيات الشهر
  adjustment_amount bigint not null default 0,                     -- خصم (سالب) أو إضافة (موجب) بقيد معتمد، الغياب والإجازة ما يخصمون تلقائياً
  adjustment_reason text,
  adjusted_by    bigint references users(id),
  total_due      bigint not null check (total_due >= 0),
  status         text not null default 'pending' check (status in ('pending','paid','not_payable')),
  pay_source     text check (pay_source in ('safe','electronic')),
  bank_name      text,
  paid_on        date,
  paid_by        bigint references users(id),                      -- المدير (راتب المدير: المالك)
  note           text,
  unique (run_id, user_id),
  check ((status = 'not_payable') = (base_salary is null)),
  check (total_due = coalesce(base_salary, 0) + consult_amount + adjustment_amount),
  check (adjustment_amount = 0 or (btrim(coalesce(adjustment_reason, '')) <> '' and adjusted_by is not null)),
  check (status <> 'paid' or (pay_source is not null and paid_on is not null and paid_by is not null)),
  check (pay_source is distinct from 'electronic' or bank_name is not null)
);

-- مستحق الطبيب من كشفية انتهت: النسبة والمبلغ يثبتان وقت «إنهاء الكشفية»
create table doctor_earnings (
  id               bigint generated always as identity primary key,
  doctor_id        bigint not null references doctors(user_id),
  consultation_id  bigint not null unique references consultations(id),
  base_amount      bigint not null check (base_amount >= 0),       -- صافي الكشفية بعد الخصم والنقاط
  percent          numeric(5,2) not null check (percent between 0 and 100),
  amount           bigint not null check (amount >= 0),
  earned_on        date not null,
  payroll_item_id  bigint references payroll_items(id)
);

create table safes (
  branch_id bigint primary key references branches(id),
  balance   bigint not null default 0 check (balance >= 0)         -- الدفع من الخزنة فوق رصيدها يفشل هنا
);

create table safe_movements (
  id                  bigint generated always as identity primary key,
  branch_id           bigint not null references branches(id),
  direction           text not null check (direction in ('in','out')),
  amount              bigint not null check (amount > 0),
  kind                text not null check (kind in ('opening_balance','shift_float','shift_handover','expense',
                        'expense_adjustment','supplier_payment','salary','owner_withdrawal','compensation')),
  shift_id            bigint references shifts(id),
  expense_id          bigint references expenses(id),
  supplier_payment_id bigint references supplier_payments(id),
  payroll_item_id     bigint references payroll_items(id),
  owner_withdrawal_id bigint references owner_withdrawals(id),
  compensation_id     bigint references compensations(id),
  note                text,
  occurred_at         timestamptz not null default now(),
  business_date       date not null default clinic_today(),
  created_by          bigint not null references users(id),
  check ((kind in ('shift_float','shift_handover')) = (shift_id is not null)),
  check ((kind in ('expense','expense_adjustment')) = (expense_id is not null)),
  check ((kind = 'supplier_payment') = (supplier_payment_id is not null)),
  check ((kind = 'salary') = (payroll_item_id is not null)),
  check ((kind = 'owner_withdrawal') = (owner_withdrawal_id is not null)),
  check ((kind = 'compensation') = (compensation_id is not null)),
  check (kind not in ('opening_balance','shift_handover') or direction = 'in'),
  check (kind not in ('shift_float','supplier_payment','salary','owner_withdrawal','compensation') or direction = 'out')
);
create unique index safe_one_handover_per_shift_uq on safe_movements (shift_id) where kind = 'shift_handover';
create unique index safe_one_float_per_shift_uq on safe_movements (shift_id) where kind = 'shift_float';
create unique index safe_one_salary_uq on safe_movements (payroll_item_id) where kind = 'salary';
create unique index safe_one_withdrawal_uq on safe_movements (owner_withdrawal_id) where kind = 'owner_withdrawal';
create index safe_movements_branch_idx on safe_movements (branch_id, occurred_at);

-- ================================================================== الإشعارات والتقييم
create table notifications (
  id                   bigint generated always as identity primary key,
  customer_id          bigint not null references customers(id),
  kind                 text not null check (kind in ('reminder','offer','rating_request','booking_moved')),
  title                text not null,
  body                 text not null,                              -- بدون اسم علاج (شاشة القفل)
  data                 jsonb,
  offer_id             bigint references offers(id),
  treatment_session_id bigint references treatment_sessions(id),
  status               text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  scheduled_at         timestamptz not null default now(),
  sent_at              timestamptz,
  read_at              timestamptz,
  created_at           timestamptz not null default now()
);
-- منع تكرار الإشعارات: مرة وحدة لكل (عرض، زبون)، وتذكير لكل زيارة، وإشعار نقل لكل حدث نقل (الطابور يشتغل بـ on conflict do nothing)
create unique index notifications_offer_uq on notifications (offer_id, customer_id) where kind = 'offer';
create unique index notifications_reminder_uq on notifications (customer_id, ((data->>'visit_id'))) where kind = 'reminder';
create unique index notifications_moved_uq on notifications (((data->>'event_id'))) where kind = 'booking_moved';
create index notifications_pending_idx on notifications (id) where status = 'pending';
create index notifications_customer_idx on notifications (customer_id, id desc);
create index notifications_due_idx on notifications (scheduled_at) where status = 'pending';

create table session_ratings (
  id            bigint generated always as identity primary key,
  session_id    bigint not null unique references treatment_sessions(id),
  customer_id   bigint not null references customers(id),
  service_id    bigint not null references services(id),
  nurse_id      bigint not null references users(id),              -- لقطة وقت التقييم
  stars         smallint not null check (stars between 1 and 5),
  comment       text,
  created_at    timestamptz not null default now()
);

-- ================================================================== الإعدادات والتدقيق ومنع التكرار
-- مفاتيح: points.earn_per_amount/points.earn_points/points.point_value/points.min_redeem/points.max_percent،
-- booking.daily_limit، booking.free_followup_days، money.rounding_step، stock.near_expiry_days،
-- receipt.clinic_name/logo_attachment_id/address/phone
create table settings (
  id         bigint generated always as identity primary key,
  branch_id  bigint references branches(id),                       -- null = عام
  key        text not null,
  value      jsonb not null,
  version    int not null default 1,                               -- UPDATE ... WHERE version = $المتوقع
  updated_by bigint references users(id),
  updated_at timestamptz not null default now()
);
create unique index settings_key_uq on settings (coalesce(branch_id, 0), key);

create table setting_history (
  id         bigint generated always as identity primary key,
  setting_id bigint not null references settings(id),
  version    int not null,
  value      jsonb not null,
  changed_by bigint references users(id),
  changed_at timestamptz not null default now(),
  reason     text,
  unique (setting_id, version)
);

create table idempotency_keys (
  actor_type      text not null check (actor_type in ('user','customer')),
  actor_id        bigint not null,
  key             text not null,
  endpoint        text not null,
  request_hash    text not null,
  status          text not null default 'in_progress' check (status in ('in_progress','done')),
  response_status smallint,
  response_body   jsonb,
  resource_type   text,
  resource_id     bigint,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '7 days',
  primary key (actor_type, actor_id, key)
);

create table audit_log (
  id                bigint generated always as identity primary key,
  at                timestamptz not null default now(),
  branch_id         bigint references branches(id),
  actor_user_id     bigint references users(id),
  actor_customer_id bigint references customers(id),
  actor_role        text,
  action            text not null,
  entity_type       text,
  entity_id         bigint,
  reason            text,
  before_values     jsonb,
  after_values      jsonb,
  request_id        text,
  ip                inet
);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);
create index audit_log_at_idx on audit_log (at desc);

-- ================================================================== دوال وtriggers
-- (1) دفعات المخزون: الكمية الحالية تنحدث من الحركة، والـ CHECK يمنع السالب بالدفعة
create function apply_stock_movement() returns trigger
language plpgsql as $$
begin
  if new.batch_id is not null then
    update material_batches set qty_on_hand = qty_on_hand + new.qty_delta where id = new.batch_id;
  end if;
  return new;
end $$;
create trigger stock_movements_apply after insert on stock_movements
  for each row execute function apply_stock_movement();

-- (2) النقاط: الرصيد المخزّن يتحدث من الحركة، والصرف ما ينزل الرصيد تحت الصفر (سالب بس بالاسترجاع)
create function apply_points_entry() returns trigger
language plpgsql as $$
declare v_balance int;
begin
  update customers set points_balance = points_balance + new.points
    where id = new.customer_id returning points_balance into v_balance;
  if new.entry_type = 'redeem' and v_balance < 0 then
    raise exception 'insufficient points balance' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger points_ledger_apply after insert on points_ledger
  for each row execute function apply_points_entry();

-- (3) الخزنة: الرصيد يتحدث من الحركة، والـ CHECK على safes.balance يمنع الدفع فوق الرصيد
create function apply_safe_movement() returns trigger
language plpgsql as $$
begin
  update safes set balance = balance + case when new.direction = 'in' then new.amount else -new.amount end
    where branch_id = new.branch_id;
  if not found then
    raise exception 'safe row missing for branch %', new.branch_id;
  end if;
  return new;
end $$;
create trigger safe_movements_apply after insert on safe_movements
  for each row execute function apply_safe_movement();

-- (4) وحدات المادة وتحويلها تنقفل لما تصير بيها حركات
create function materials_lock_units() returns trigger
language plpgsql as $$
begin
  if (old.base_unit, old.pack_unit, old.mid_unit, old.mid_per_pack, old.base_per_mid)
     is distinct from (new.base_unit, new.pack_unit, new.mid_unit, new.mid_per_pack, new.base_per_mid)
     and exists (select 1 from stock_movements where material_id = old.id) then
    raise exception 'material units are locked: material % already has movements', old.id using errcode = '23514';
  end if;
  return new;
end $$;
create trigger materials_lock_units_trg before update on materials
  for each row execute function materials_lock_units();

-- (5) نسبة الكشفية للأطباء بس
create function pay_rules_check() returns trigger
language plpgsql as $$
declare v_role text;
begin
  select role into v_role from users where id = new.user_id;
  if new.consult_percent is not null and v_role is distinct from 'doctor' then
    raise exception 'consult_percent is for doctors only' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger pay_rules_check_trg before insert or update on pay_rules
  for each row execute function pay_rules_check();

-- (6) الوصل: الأرقام والبيانات المحفوظة ما تتغير، يتغير بس status وإرفاق الـ PDF أول مرة
create function payments_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on payments is not allowed' using errcode = '42501';
  end if;
  if (old.branch_id, old.receipt_no, old.customer_id, old.visit_id, old.shift_id, old.cashier_id, old.kind,
      old.gross_amount, old.offer_discount, old.manual_discount, old.points_discount, old.rounding_amount,
      old.net_amount, old.points_used, old.points_earned, old.discount_request_id, old.paid_at, old.business_date)
     is distinct from
     (new.branch_id, new.receipt_no, new.customer_id, new.visit_id, new.shift_id, new.cashier_id, new.kind,
      new.gross_amount, new.offer_discount, new.manual_discount, new.points_discount, new.rounding_amount,
      new.net_amount, new.points_used, new.points_earned, new.discount_request_id, new.paid_at, new.business_date)
     or old.clinic_snapshot is distinct from new.clinic_snapshot
     or (old.pdf_attachment_id is not null and old.pdf_attachment_id is distinct from new.pdf_attachment_id) then
    raise exception 'payments are immutable except status and first PDF attachment' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger payments_guard_trg before update or delete on payments
  for each row execute function payments_guard();

create function payment_items_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on payment_items is not allowed' using errcode = '42501';
  end if;
  if (old.payment_id, old.item_type, old.consultation_id, old.session_id, old.service_id, old.service_name,
      old.quantity, old.list_price, old.offer_id, old.offer_percent, old.offer_discount, old.manual_discount_share,
      old.points_discount_share, old.points_used_share, old.rounding_share, old.net_amount)
     is distinct from
     (new.payment_id, new.item_type, new.consultation_id, new.session_id, new.service_id, new.service_name,
      new.quantity, new.list_price, new.offer_id, new.offer_percent, new.offer_discount, new.manual_discount_share,
      new.points_discount_share, new.points_used_share, new.rounding_share, new.net_amount)
     or old.pricing_snapshot is distinct from new.pricing_snapshot
     or (old.status = 'refunded' and new.status <> 'refunded') then
    raise exception 'payment_items are immutable except status paid -> refunded' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger payment_items_guard_trg before update or delete on payment_items
  for each row execute function payment_items_guard();

-- (7) السجلات الإضافية فقط: ما تنعدل ولا تنحذف ولا تنفرغ
do $$
declare t text;
begin
  foreach t in array array['stock_movements','safe_movements','points_ledger','audit_log','payment_tenders',
                           'refunds','refund_items','refund_tenders','receipt_prints','expense_edits',
                           'confirmation_reverts','customer_merges','customer_health','booking_events',
                           'setting_history'] loop
    if to_regclass(t) is null then continue; end if;
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_modify()',
                   t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function forbid_modify()',
                   t || '_no_truncate', t);
  end loop;
end $$;

-- ================================================================== Views
create function setting_int(p_branch bigint, p_key text, p_default int) returns int
language sql stable as $$
  select coalesce(
    (select (value #>> '{}')::int from settings where coalesce(branch_id, 0) = coalesce(p_branch, 0) and key = p_key),
    (select (value #>> '{}')::int from settings where branch_id is null and key = p_key),
    p_default)
$$;

-- رصيد المواد: الموجود، الصالح، المنتهي، قريب الانتهاء، المحجوز، المتاح، وتنبيه «قليل» على المتاح
create view v_material_stock as
select m.id as material_id, m.branch_id, m.name, m.base_unit, m.low_threshold,
       coalesce(mv.on_hand, 0)                                           as on_hand,
       coalesce(b.valid_qty, 0)                                          as valid_qty,
       coalesce(b.expired_qty, 0)                                        as expired_qty,
       coalesce(b.near_expiry_qty, 0)                                    as near_expiry_qty,
       coalesce(r.reserved, 0)                                           as reserved,
       coalesce(mv.on_hand, 0) - coalesce(r.reserved, 0)                 as available,
       (coalesce(mv.on_hand, 0) - coalesce(r.reserved, 0)) < m.low_threshold as is_low,
       coalesce(mv.on_hand, 0) < 0                                       as is_negative
from materials m
left join (select material_id, sum(qty_delta) as on_hand from stock_movements group by material_id) mv
       on mv.material_id = m.id
left join (select material_id,
                  sum(qty_on_hand) filter (where expiry_date >= clinic_today()) as valid_qty,
                  sum(qty_on_hand) filter (where expiry_date <  clinic_today()) as expired_qty,
                  sum(qty_on_hand) filter (where expiry_date >= clinic_today()
                        and expiry_date <= clinic_today() + setting_int(branch_id, 'stock.near_expiry_days', 30)) as near_expiry_qty
           from material_batches group by material_id, branch_id) b
       on b.material_id = m.id
left join (select n.material_id, sum(n.qty_base) as reserved
           from session_material_needs n
           join treatment_sessions s on s.id = n.treatment_session_id and s.status = 'paid'
           group by n.material_id) r
       on r.material_id = m.id;

-- باقي علينا لكل مورد = الافتتاحي + الفواتير − المرتجعات − التسديدات
create view v_supplier_balance as
select s.id as supplier_id, s.branch_id, s.name,
       s.opening_balance
       + coalesce((select sum(total_amount) from purchases p where p.supplier_id = s.id and p.status = 'posted'), 0)
       - coalesce((select sum(credit_amount) from supplier_returns r where r.supplier_id = s.id), 0)
       - coalesce((select sum(amount) from supplier_payments x where x.supplier_id = s.id), 0) as balance_owed
from suppliers s;

-- فحوصات تماسك: كل صف راجع = خلل. يشتغل ليلياً وبالاختبارات، والمفروض يرجع صفر صفوف
create view v_integrity_checks as
select 'payment_tenders_sum_mismatch'::text as check_name, p.id as entity_id,
       'net=' || p.net_amount || ' tenders=' || coalesce(t.s, 0) as detail
from payments p
left join (select payment_id, sum(amount) s from payment_tenders group by payment_id) t on t.payment_id = p.id
where p.net_amount <> coalesce(t.s, 0)
union all
select 'payment_items_sum_mismatch', p.id,
       'net=' || p.net_amount || ' items=' || coalesce(i.net, 0) || ' gross=' || p.gross_amount || ' items_gross=' || coalesce(i.gross, 0)
from payments p
left join (select payment_id, sum(net_amount) net, sum(list_price) gross from payment_items group by payment_id) i
       on i.payment_id = p.id
where p.net_amount <> coalesce(i.net, 0) or p.gross_amount <> coalesce(i.gross, 0)
union all
select 'refund_tenders_sum_mismatch', r.id, 'total=' || r.total_amount || ' tenders=' || coalesce(t.s, 0)
from refunds r
left join (select refund_id, sum(amount) s from refund_tenders group by refund_id) t on t.refund_id = r.id
where r.total_amount <> coalesce(t.s, 0)
union all
select 'refund_items_sum_mismatch', r.id, 'total=' || r.total_amount || ' items=' || coalesce(i.s, 0)
from refunds r
left join (select refund_id, sum(amount) s from refund_items group by refund_id) i on i.refund_id = r.id
where r.total_amount <> coalesce(i.s, 0)
union all
select 'purchase_total_mismatch', p.id, 'total=' || p.total_amount || ' items=' || coalesce(i.s, 0)
from purchases p
left join (select purchase_id, sum(line_total) s from purchase_items group by purchase_id) i on i.purchase_id = p.id
where p.total_amount <> coalesce(i.s, 0)
union all
select 'batch_qty_mismatch', b.id, 'cached=' || b.qty_on_hand || ' ledger=' || coalesce(m.s, 0)
from material_batches b
left join (select batch_id, sum(qty_delta) s from stock_movements where batch_id is not null group by batch_id) m
       on m.batch_id = b.id
where b.qty_on_hand <> coalesce(m.s, 0)
union all
select 'safe_balance_mismatch', s.branch_id,
       'cached=' || s.balance || ' ledger=' || coalesce(m.s, 0)
from safes s
left join (select branch_id, sum(case when direction = 'in' then amount else -amount end) s
           from safe_movements group by branch_id) m on m.branch_id = s.branch_id
where s.balance <> coalesce(m.s, 0)
union all
select 'points_balance_mismatch', c.id, 'cached=' || c.points_balance || ' ledger=' || coalesce(l.s, 0)
from customers c
left join (select customer_id, sum(points) s from points_ledger group by customer_id) l on l.customer_id = c.id
where c.points_balance <> coalesce(l.s, 0)
union all
select 'safe_payment_without_movement', x.id, 'supplier_payment from safe has no safe movement'
from supplier_payments x
where x.pay_source = 'safe' and not exists (select 1 from safe_movements m where m.supplier_payment_id = x.id)
union all
select 'safe_expense_without_movement', e.id, 'expense from safe has no safe movement'
from expenses e
where e.pay_source = 'safe' and e.status = 'active'
  and not exists (select 1 from safe_movements m where m.expense_id = e.id)
union all
select 'paid_session_without_payment', s.id, 'session status=' || s.status
from treatment_sessions s
where s.status in ('paid','completed')
  and not exists (select 1 from payment_items i where i.session_id = s.id)
union all
select 'booking_day_slots_mismatch', d.branch_id,
       'day=' || d.day || ' used=' || d.used_slots || ' visits=' || coalesce(v.c, 0)
from booking_days d
left join (select branch_id, visit_date, count(*) c from visits
           where status in ('booked','arrived') group by branch_id, visit_date) v
       on v.branch_id = d.branch_id and v.visit_date = d.day
where d.used_slots <> coalesce(v.c, 0);

-- الأطباء وزبائنهم: الزبون زبون الطبيب إذا سوّى كشفية عنده (كل طبيب يشوف تاريخه الكامل للقراءة بس)
create view v_doctor_customers as
select distinct doctor_id, customer_id from consultations where status <> 'cancelled';

-- ================================================================== صلاحيات قاعدة البيانات (مثال، يتفعل بالمرحلة 1أ)
-- create role clinic_app login;  -- حساب التطبيق: ما يملك DDL ولا DELETE على الجداول المالية
-- grant select, insert, update on all tables in schema public to clinic_app;
-- revoke update, delete on stock_movements, safe_movements, points_ledger, audit_log, payment_tenders,
--        refunds, refund_items, refund_tenders from clinic_app;
-- revoke delete on payments, payment_items from clinic_app;

commit;
