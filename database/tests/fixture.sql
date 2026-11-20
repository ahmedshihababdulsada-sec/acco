-- بيانات أساسية للاختبارات: فرع، موظفين، خدمات، طرق دفع، شفت، خزنة، مادة بدفعة
do $$
declare
  v_branch bigint; v_owner bigint; v_mgr bigint; v_c1 bigint; v_doc bigint; v_nurse bigint;
  v_cons bigint; v_laser bigint; v_cash bigint; v_kc bigint; v_shift bigint; v_att bigint;
  v_mat bigint; v_batch bigint; v_cat bigint;
begin
  insert into branches (code, name) values ('MAIN', 'الفرع الرئيسي') returning id into v_branch;
  insert into t.ids values ('branch', v_branch);

  insert into users (username, password_hash, full_name, role, branch_id)
  values ('owner', 'x', 'المالك', 'owner', null) returning id into v_owner;
  insert into users (username, password_hash, full_name, role, branch_id)
  values ('manager1', 'x', 'المدير', 'manager', v_branch) returning id into v_mgr;
  insert into users (username, password_hash, full_name, role, branch_id)
  values ('cashier1', 'x', 'كاشير ١', 'cashier', v_branch) returning id into v_c1;
  insert into users (username, password_hash, full_name, role, branch_id)
  values ('doctor1', 'x', 'دكتورة تجربة', 'doctor', v_branch) returning id into v_doc;
  insert into users (username, password_hash, full_name, role, branch_id)
  values ('nurse1', 'x', 'ممرض تجربة', 'nurse', v_branch) returning id into v_nurse;
  insert into doctors (user_id, title) values (v_doc, 'تجميل');
  insert into t.ids values ('owner', v_owner), ('manager1', v_mgr), ('cashier1', v_c1), ('doctor1', v_doc), ('nurse1', v_nurse);

  insert into services (branch_id, name_ar, kind, pricing_model) values (v_branch, 'كشفية', 'consultation', 'fixed') returning id into v_cons;
  insert into services (branch_id, name_ar, kind, pricing_model) values (v_branch, 'ليزر', 'treatment', 'fixed') returning id into v_laser;
  insert into service_prices (service_id, price, set_by) values (v_cons, 25000, v_owner), (v_laser, 50000, v_owner);
  insert into t.ids values ('svc_consult', v_cons), ('svc_laser', v_laser);

  insert into payment_methods (branch_id, name_ar, kind) values (v_branch, 'كاش', 'cash') returning id into v_cash;
  insert into payment_methods (branch_id, name_ar, kind, device_label) values (v_branch, 'كي كارد', 'electronic', 'جهاز ١') returning id into v_kc;
  insert into t.ids values ('pm_cash', v_cash), ('pm_keycard', v_kc);

  insert into shifts (branch_id, cashier_id, opening_float, float_given_by) values (v_branch, v_c1, 0, v_mgr) returning id into v_shift;
  insert into t.ids values ('shift1', v_shift);

  -- الخزنة: رصيد افتتاحي 100,000
  insert into safes (branch_id, balance) values (v_branch, 0);
  insert into safe_movements (branch_id, direction, amount, kind, created_by)
  values (v_branch, 'in', 100000, 'opening_balance', v_owner);

  -- مرفق إثبات للمصاريف + فئة مصروف
  insert into attachments (branch_id, kind, storage_key, mime, size_bytes, sha256, uploaded_by)
  values (v_branch, 'expense_proof', 'test/proof-1', 'image/jpeg', 1000, 'abc', v_mgr) returning id into v_att;
  insert into t.ids values ('att1', v_att);
  insert into expense_categories (branch_id, name) values (v_branch, 'نظافة') returning id into v_cat;
  insert into t.ids values ('exp_cat', v_cat);
  -- مادة بدفعة افتتاحية 10 cc
  insert into materials (branch_id, name, base_unit, pack_unit, base_per_mid, last_unit_cost)
  values (v_branch, 'بوتكس', 'cc', 'كرتون', 1, 1000) returning id into v_mat;
  insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand)
  values (v_branch, v_mat, 'opening', clinic_today(), clinic_today() + 365, 1000, 10, 0) returning id into v_batch;
  insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, created_by)
  values (v_branch, v_mat, v_batch, 'opening', 10, 1000, 10000, v_mgr);
  insert into t.ids values ('mat1', v_mat), ('batch1', v_batch);
end $$;
