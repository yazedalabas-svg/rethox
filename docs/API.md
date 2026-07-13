# REST API المختصر

- Auth: `/api/auth/register`, `/login`, `/refresh`, `/logout`, `/me`
- Catalog: `/api/books`, `/api/books/:slug`, `/api/search`, `/api/recommendations`
- Reader: `/api/chapters/:id/content`, `/api/progress/:bookId`, `/api/bookmarks`
- Commerce: `/api/orders`, `/api/entitlements`
- AI: `/api/sentences/:id/summary`
- Admin: `/api/admin/books`, `/api/admin/users`, `/api/admin/overview`

جميع استجابات الأخطاء تستخدم `{ "message": "..." }`. المسارات المحمية تستقبل `Authorization: Bearer <access-token>`.
