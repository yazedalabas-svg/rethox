# REST API المختصر

- Auth: `/api/auth/register`, `/login`, `/refresh`, `/logout`, `/me`
- Catalog: `/api/books`, `/api/books/:slug`, `/api/search`, `/api/recommendations`
- Reader: `/api/chapters/:id/content`, `/api/progress/:bookId`, `/api/bookmarks`
- Commerce: `/api/orders`, `/api/entitlements`
- Payments: `/api/payments/verify`, `/api/payments/webhook`
- AI: `/api/sentences/:id/summary`
- Admin: `/api/admin/books`, `/api/admin/users`, `/api/admin/overview`

جميع استجابات الأخطاء تستخدم `{ "message": "..." }`. المسارات المحمية تستقبل `Authorization: Bearer <access-token>`.

## الدفع

`POST /api/orders` بجسم `{ "bookIds": [...] }` ينشئ طلبًا بحالة `PENDING` ويعيد
`{ order, paymentUrl }`. المبلغ يُحسب من أسعار الكتب في قاعدة البيانات، ولا
يُقرأ من الطلب أبدًا. يُحوَّل المشتري إلى `paymentUrl` عند ميسر.

`POST /api/payments/webhook` هو المسار الرسمي للتسوية. يرفض أي طلب لا يحمل
`secret_token` مطابقًا لـ `MOYASR_WEBHOOK_SECRET`، أو يأتي من وضع مختلف عن وضع
المفتاح المستخدم. لا يثق بجسم الطلب: يعيد جلب الفاتورة من ميسر ثم يسوّي الطلب.

`POST /api/payments/verify` بجسم `{ "orderId": "..." }` يتحقق من نفس الفاتورة عند
عودة المشتري للموقع، حتى لا ينتظر وصول الـ webhook. يتطلب تسجيل الدخول ويعمل على
طلبات صاحب الحساب فقط.

منح صلاحية القراءة يحدث حصريًا داخل دالة `complete_paid_order` بعد تطابق المبلغ
والعملة مع الطلب. الدالة idempotent، وفهرس فريد على `payments.external_id` يمنع
تسوية الفاتورة الواحدة لأكثر من طلب.
