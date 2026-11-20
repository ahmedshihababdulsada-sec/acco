# برامج Flutter لنظام مركز التجميل

برنامجين من نفس الكود (`lib/core/` مشترك):

| البرنامج | نقطة الدخول | الأدوار |
|---|---|---|
| الموظفين | `lib/main.dart` | كاشير، طبيب، ممرض، مدير، مالك (الواجهة حسب الدور) |
| الزبون | `lib/main_customer.dart` | زبون (دخول برمز OTP) |

## التشغيل (تطوير)
```bash
export PATH=$HOME/development/flutter/bin:$PATH
cd app
flutter pub get
flutter run -d chrome --dart-define=API_URL=http://127.0.0.1:3100                         # الموظفين
flutter run -d chrome -t lib/main_customer.dart --dart-define=API_URL=http://127.0.0.1:3100   # الزبون
```
الخادم لازم يسمح بأصل الواجهة: `CORS_ORIGINS=http://localhost:8080` (للويب فقط؛ التطبيقات الأصلية ما تحتاج). للتجربة اليدوية للزبون شغّل الخادم بـ`OTP_DEV_LOG=1` ليطبع رمز التأكيد بسجله (يتجاهل بالإنتاج).

## الاختبار
```bash
flutter analyze
flutter test        # 52 اختبار: تنسيق/وصل/شعار، عميل الـAPI، دخول الموظف والزبون، الممرض، السحوبات، معرض الصور
```

## الهيكل
- `lib/core/`: `api.dart` (عميل HTTP: تجديد توكن single-flight، مفتاح منع التكرار، رفع ملفات)، `theme.dart`، `format.dart`، `widgets.dart`، `receipt/` (وصل A5 وPDF والطباعة).
- `lib/staff/`: الدخول (+TOTP للمالك) و`home_shell.dart` (توجيه حسب الدور)، `cashier/`، `doctor/`، `nurse/`، `manager/` (إطار `AdminShell` وأقسامه)، `owner/` (التقارير والتقييمات والتعويضات ودمج الزبائن).
- `lib/customer/`: الجلسة، الدخول بـOTP، والصفحات الخمس (رئيسية، مواعيد، جلسات، مدفوعات، حساب) والإشعارات.

## قواعد ثابتة
- أرقام المال كلها من الخادم (الصافي، التقريب، معاينة السعر): التطبيق ما يحسب ولا يتجاوز.
- الصلاحيات يقررها الخادم؛ التطبيق يعرض خطأه العربي.
- العملة دينار عراقي فقط، الواجهة RTL عربي.
