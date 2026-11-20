-- يشغله مدير القاعدة مرة وحدة. حساب مخصص للنسخ (مو حساب التطبيق): يقرأ وينسخ بس.
create role clinic_backup login replication;
grant pg_read_all_data to clinic_backup;
-- ثم بـpg_hba.conf (مثال: اتصال محلي بـsocket بدون كلمة سر لمستخدم النظام clinic):
--   local  replication  clinic_backup  peer map=clinic
--   local  clinic       clinic_backup  peer map=clinic
