# معمارية rethox

## التشغيل الحالي

الواجهة تتصل بخادم REST. يعمل الخادم محليًا بمخزن JSON دائم لتسهيل التجربة على جهاز لا يحتوي PostgreSQL. مخطط Prisma الكامل موجود في `apps/api/prisma/schema.prisma` وهو مصدر الحقيقة للانتقال إلى PostgreSQL.

## الإنتاج

- Web: Vercel.
- API: Render، مع `NODE_ENV=production` و`JWT_SECRET` قوي.
- Database: Neon PostgreSQL، مع `pg_trgm` وفهارس بحث عربية.
- Media: Cloudflare R2، bucket خاص وروابط موقعة قصيرة العمر.
- Errors: Sentry؛ logs: Pino بدون نصوص خاصة أو رموز جلسة.

## الأمان

- Argon2id لكلمات المرور.
- Access JWT لمدة 10 دقائق في ذاكرة الواجهة.
- Refresh token دوّار داخل HttpOnly cookie ومخزن بصيغة SHA-256.
- Helmet وCORS محدود وrate limiting وZod.
- صلاحيات الإدارة تتحقق في الخادم، وليس في الواجهة فقط.

## الوسائط

النسخة الحالية تستخدم Web Speech API مع توقيت كلمات خيالي. عند تفعيل ملفات مرخصة: يحول الفصل إلى HLS بمقاطع 6 ثوانٍ، ويصدر الخادم رابط manifest مؤقتًا بعد فحص الملكية الرقمية.
