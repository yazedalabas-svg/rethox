ملف تقرير: صور ري:زيرو
======================

موجودات وملاحظات سريعة
---------------------
- صور الفصول والرسوم موجودة محليًا في: `apps/web/public/illustrations/rezero-arc-6/`
- غلاف الكتاب المشار إليه في البيانات: `apps/api/data/deploy-seed.json` و `apps/api/data/runtime-store.json` كـ `/covers/rezero-arc-6.webp`.
- عند البناء، مجلد `apps/web/dist` يتضمن الملفات الثابتة من `apps/web/public`، لذا أي مسار يبدأ بـ `/covers/...` أو `/illustrations/...` يُخدَم مباشرة من الواجهة النهائية.

كيف وُضعت الصور
-----------------
1. بعض الصور أُدرجت داخل المستودع تحت `apps/web/public/illustrations/rezero-arc-6/`.
2. بيانات الكتاب (الـ seed) تُشير إلى الـ `coverUrl` كنقطة وصول (`/covers/rezero-arc-6.webp`) — يتوقع أن يكون الملف الفعلي موجودًا في `apps/web/public/covers/rezero-arc-6.webp` أو أن عملية البناء تضع نسخة مناسبة في `apps/web/dist/covers/`.

خطوات للتأكد و/أو إصلاح الحالة
--------------------------------
1) تحقق من وجود الغلاف فعليًا في `apps/web/public/covers/`:

```powershell
ls .\apps\web\public\covers\
```

2) إن لم يكن موجودًا، انسخ/نقل الملف من `apps/web/public/illustrations/rezero-arc-6/` إلى `apps/web/public/covers/rezero-arc-6.webp` أو حدّث `deploy-seed.json` و `runtime-store.json` ليشيروا إلى المسار الصحيح (`/illustrations/rezero-arc-6/chapter-01-opening.png` مثلا).

3) إن كنت تستخدم Supabase Storage أو R2 بدلاً من تخزين الملفات ضمن build، ارفع الملفات إلى البكت المناسب (مثلاً `public` bucket) ثم حدّث `coverUrl` لمسار CDN أو مسار البكت (مثال: `https://<bucket>.supabase.co/storage/v1/object/public/covers/rezero-arc-6.webp`).

فحص الصور على Supabase
----------------------
إذا أردت التحقق من الصور في Supabase:

1. افتح لوحة Supabase للمشروع → Storage → اختر البكت `public` أو البكت الذي تستخدمه.
2. ابحث عن المجلد `covers/` أو `illustrations/rezero-arc-6/` وراجع الملفات.
3. بدلاً من ذلك استخدم واجهة API:

```bash
curl -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  "https://<project>.supabase.co/storage/v1/object/list/public/covers"
```

ملاحظات حول الـ app وسلوك الصور
--------------------------------
- التطبيق حالياً يخدم الملفات الثابتة من البناء (`apps/web/dist`) لذا أي ملف ضمن `apps/web/public` سينتهى ضمن المخرَج بعد `npm run build`.
- إذا تود جعل الصور تُخدم من Supabase/R2 (لتقليل حجم الريبو)، اجعل `coverUrl` في الـ seed نقاطًا كاملة إلى التخزين الخارجي.

اقتراح عملي (سريع وآمن)
-----------------------
1. أنسخ الغلاف إلى `apps/web/public/covers/rezero-arc-6.webp` إن لم يكن موجودًا.
2. شغّل محليًا:
```powershell
npm run build -w @rethox/web
```
3. ارفع البناء أو دَفِع التغييرات إلى GitHub ثم شغّل الـ workflow للنشر.

هل تريد أن أضيف ملف `apps/web/public/covers/rezero-arc-6.webp` إلى المستودع الآن (إن توفر الصورة محلياً) أو أرفعها إلى Supabase لو تحط لي مفاتيح الوصول؟
