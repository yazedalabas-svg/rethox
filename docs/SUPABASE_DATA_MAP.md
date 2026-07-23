# خريطة بيانات Supabase لمنصة rethox

هذه الوثيقة هي مرجع التشغيل بعد نقل البيانات من `rethox_state` إلى جداول PostgreSQL المنظمة. تبقى الواجهة متصلة بـ Express؛ لا يصل مفتاح Supabase السري إلى المتصفح.

## أين تجد كل جزء

| الجزء | مكانه في Supabase أو المشروع |
|---|---|
| الحسابات العامة | Dashboard → Table Editor → `app_users` |
| الملفات الشخصية | Table Editor → `profiles` |
| بيانات الدخول السرية | `user_credentials`, `user_identities`, `user_sessions` — للخادم فقط |
| إعدادات المستخدم | `user_settings` |
| الكتب والفصول | `books`, `chapters`, `tags`, `book_tags` |
| ملفات الكتب والفصول | `book_assets`, `chapter_assets`, `audio_assets` |
| السلة | `carts`, `cart_items` |
| الطلبات والمدفوعات | `orders`, `order_items`, `payments` |
| ملكية الكتب | `entitlements` |
| تقدم القراءة | `reading_progress`, `chapter_progress`, `reading_sessions` |
| العلامات وقائمة القراءة | `bookmarks`, `reading_list` |
| تقييم العمل | `book_reviews` — تقييم واحد لكل مستخدم وعمل |
| تعليقات الفصول والردود | `chapter_comments` — الردود عبر `parent_id` ومن دون تقييم إلزامي |
| البلاغات | `content_reports` |
| إعدادات الموقع | `app_settings`, `feature_flags` |
| التلخيص والسجل الإداري | `sentence_summaries`, `admin_audit_logs` |
| سجل النسخ الاحتياطية | `backup_runs` |
| النسخة القديمة | `rethox_state` و`private.rethox_state_backups` للرجوع فقط |
| ملفات الترحيل | `supabase/migrations` داخل المستودع |
| طبقة الربط | `apps/api/src/relational-store.ts` |
| أداة الترحيل | `apps/api/src/migrate-relational.ts` |
| خدمة النسخ الاحتياطي | `apps/api/src/backup-service.ts` |
| لوحة التحكم | الموقع → `/admin` → قسم «النسخ الاحتياطية» |

## Storage

Dashboard → Storage:

| Bucket | الاستخدام | الوصول |
|---|---|---|
| `book-covers` | أغلفة الكتب | عام |
| `avatars` | صور الحسابات | عام |
| `chapter-content` | نصوص الفصول المضغوطة | خاص |
| `chapter-audio` | السرد الصوتي | خاص |
| `source-documents` | ملفات المصدر | خاص |
| `database-backups` | النسخ اليومية والشهرية واليدوية | خاص |

## قواعد الوصول

- الكتب المنشورة وبياناتها العامة والتقييمات والتعليقات النشطة قابلة للقراءة العامة فقط.
- الحسابات والجلسات والطلبات والملكية والتقدم والعلامات لا يقرأها المتصفح مباشرة؛ تمر عبر Express.
- الفصل المجاني يحدده `chapters.is_sample = true`. بقية الفصل والنص والصوت تتطلب `entitlements` فعالة أو دور `ADMIN`.
- الشراء التجريبي يستخدم الدالة `complete_demo_order` داخل معاملة واحدة ومع `idempotency_key` لمنع الطلبات المكررة.
- تقدم القراءة يستخدم `save_reading_progress` ويرفض الكتابة الأقدم حتى لا يعود القارئ إلى موضع سابق بسبب تزامن الطلبات.
- الحذف المجتمعي ناعم عبر `deleted_at`، فلا تفقد البيانات فورًا.
- RLS مفعّل على جداول `public`. الجداول التي لا تملك سياسة للمستخدم مقفلة عمدًا ويصل إليها `service_role` من الخادم فقط.

## متغيرات Render المطلوبة

أضفها في Render → Service → Environment من دون وضع قيمها داخل Git:

- `NEXT_PUBLIC_SUPABASE_URL` (يستخدمه الخادم أيضًا كعنوان احتياطي)
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUBLIC_SITE_URL=https://rethox.online`

يمكن إبقاء `NEXT_PUBLIC_SUPABASE_URL` والمفتاح القابل للنشر للواجهة، لكن لا تستخدم أبدًا `SUPABASE_SERVICE_ROLE_KEY` في متغير يبدأ بـ `NEXT_PUBLIC_`.

## النسخ الاحتياطية

- عند تشغيل API تُفحص النسخة اليومية، ويعاد الفحص كل ست ساعات.
- في اليوم الأول من الشهر تُنشأ نسخة شهرية.
- النسخة اليدوية من `/admin`.
- الملف المضغوط في Storage → `database-backups`، وحالته وبصمته SHA-256 في `backup_runs`.
- يجب تجربة الاستعادة دوريًا في مشروع/فرع اختبار، لا فوق قاعدة الإنتاج مباشرة.

## تشغيل الترحيل في بيئة جديدة

```bash
npm --workspace @rethox/api run migrate:relational
```

لا تشغّل الأمر على الإنتاج قبل أخذ نسخة، وتأكد بعده من الأعداد في `app_users`, `orders`, `entitlements`, `reading_progress`, `book_reviews`, و`chapter_comments`.
