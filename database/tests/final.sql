-- الفحص النهائي بعد كل الاختبارات والسباقات: لازم ما ينكتشف أي خلل
select t.check('v_integrity_checks: صفر صفوف',
  (select count(*) from v_integrity_checks) = 0,
  (select string_agg(check_name || ':' || entity_id || ' ' || coalesce(detail, ''), ' | ') from v_integrity_checks));

-- أرقام الوصل متسلسلة بدون فجوات ولا تكرار، حتى مع المحاولات الفاشلة والمتزامنة
select t.check('أرقام الوصل بدون فجوات',
  (select count(*) from payments where receipt_no ~ '^[0-9]{4}-[0-9]{5}$')
    = (select last_value from number_counters where kind = 'receipt')
  and (select count(distinct receipt_no) from payments where receipt_no ~ '^[0-9]{4}-[0-9]{5}$')
    = (select last_value from number_counters where kind = 'receipt'),
  'payments=' || (select count(*) from payments where receipt_no ~ '^[0-9]{4}-[0-9]{5}$')
    || ' counter=' || (select last_value from number_counters where kind = 'receipt'));

select t.check('الخزنة: الرصيد ≥ 0', (select min(balance) from safes) >= 0);
select t.check('المخزون: ما أكو دفعة سالبة', (select count(*) from material_batches where qty_on_hand < 0) = 0);
