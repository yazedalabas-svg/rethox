import type { SupabaseClient } from "@supabase/supabase-js";
import type { Book, Chapter, Store } from "./types.js";

type Row = Record<string, any>;

const chunks = <T>(items: T[], size = 400) => {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    output.push(items.slice(index, index + size));
  return output;
};

const must = (error: { message?: string } | null, operation: string) => {
  if (error) throw new Error(`${operation}: ${error.message || "database error"}`);
};

const upsertRows = async (
  client: SupabaseClient,
  table: string,
  rows: Row[],
  onConflict?: string,
) => {
  for (const batch of chunks(rows)) {
    const { error } = await client
      .from(table)
      .upsert(batch, onConflict ? { onConflict } : undefined);
    must(error, `upsert ${table}`);
  }
};

const selectAll = async (client: SupabaseClient, table: string) => {
  const rows: Row[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .range(from, from + pageSize - 1);
    must(error, `select ${table}`);
    const page = (data || []) as Row[];
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
};

const slugify = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "") || "tag";

const catalogSignature = (books: Book[]) =>
  JSON.stringify(
    books.map((book) => ({
      id: book.id,
      slug: book.slug,
      title: book.title,
      author: book.author,
      synopsis: book.synopsis,
      priceMinor: book.priceMinor,
      coverTheme: book.coverTheme,
      coverUrl: book.coverUrl,
      pageCount: book.pageCount,
      status: book.status,
      chapters: book.chapters.map((chapter) => [
        chapter.id,
        chapter.title,
        chapter.position,
        chapter.isSample,
        chapter.durationMs,
      ]),
    })),
  );

let lastCatalogSignature = "";

export const syncCatalog = async (client: SupabaseClient, books: Book[]) => {
  const signature = catalogSignature(books);
  if (signature === lastCatalogSignature) return;

  await upsertRows(
    client,
    "books",
    books.map((book) => ({
      id: book.id,
      slug: book.slug,
      title: book.title,
      normalized_title: book.title.normalize("NFKD").toLowerCase(),
      author: book.author,
      synopsis: book.synopsis,
      price_minor: book.priceMinor,
      currency: book.currency,
      genre: book.genre,
      cover_theme: book.coverTheme,
      cover_url: book.coverUrl || null,
      page_count: book.pageCount ?? null,
      status: book.status,
    })),
    "id",
  );

  const tagRows = Array.from(new Set(books.flatMap((book) => book.tags))).map(
    (name) => ({ name, slug: slugify(name) }),
  );
  await upsertRows(client, "tags", tagRows, "slug");
  const { data: storedTags, error: tagError } = await client
    .from("tags")
    .select("id,slug");
  must(tagError, "load tags");
  const tagIds = new Map((storedTags || []).map((tag: any) => [tag.slug, tag.id]));
  await upsertRows(
    client,
    "book_tags",
    books.flatMap((book) =>
      book.tags
        .map((tag) => ({ book_id: book.id, tag_id: tagIds.get(slugify(tag)) }))
        .filter((item) => item.tag_id),
    ),
    "book_id,tag_id",
  );

  await upsertRows(
    client,
    "chapters",
    books.flatMap((book) =>
      book.chapters.map((chapter) => ({
        id: chapter.id,
        book_id: book.id,
        position: chapter.position,
        title: chapter.title,
        duration_ms: chapter.durationMs,
        is_sample: chapter.isSample,
        sentence_count: chapter.sentenceCount ?? chapter.sentences.length,
        status: "PUBLISHED",
      })),
    ),
    "id",
  );
  lastCatalogSignature = signature;
};

const orderNumber = (id: string) =>
  `RX-${id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase()}`;

export const syncRelationalStore = async (
  client: SupabaseClient,
  state: Store,
  options: { migration?: boolean } = {},
) => {
  await syncCatalog(client, state.books);

  await upsertRows(
    client,
    "app_users",
    state.users.map((user) => ({
      id: user.id,
      email: user.email ? user.email.trim().toLowerCase() : null,
      phone: user.phone || null,
      role: user.role,
      created_at: user.createdAt,
    })),
    "id",
  );
  await upsertRows(
    client,
    "profiles",
    state.users.map((user) => ({
      user_id: user.id,
      display_name: user.name || "قارئ rethox",
      avatar_url: user.avatarUrl || null,
    })),
    "user_id",
  );
  await upsertRows(
    client,
    "user_settings",
    state.users.map((user) => ({
      user_id: user.id,
      theme: user.theme || "light",
      locale: "ar",
    })),
    "user_id",
  );
  await upsertRows(
    client,
    "user_credentials",
    state.users
      .filter((user) => Boolean(user.passwordHash))
      .map((user) => ({ user_id: user.id, password_hash: user.passwordHash })),
    "user_id",
  );

  const identities = state.users.flatMap((user) => {
    const output: Row[] = [];
    if (user.email)
      output.push({
        user_id: user.id,
        provider: "email",
        provider_subject: user.email.trim().toLowerCase(),
        provider_email: user.email.trim().toLowerCase(),
      });
    if (user.oauthProvider === "google" && user.oauthSubject)
      output.push({
        user_id: user.id,
        provider: "google",
        provider_subject: user.oauthSubject,
        provider_email: user.email?.trim().toLowerCase() || null,
      });
    if (user.oauthProvider === "supabase" && user.oauthSubject)
      output.push({
        user_id: user.id,
        provider: "supabase_phone",
        provider_subject: user.oauthSubject,
        provider_email: null,
      });
    return output;
  });
  await upsertRows(client, "user_identities", identities, "provider,provider_subject");
  await upsertRows(
    client,
    "user_sessions",
    state.refreshTokens.map((token) => ({
      user_id: token.userId,
      token_hash: token.hash,
      expires_at: token.expiresAt,
    })),
    "token_hash",
  );
  // Tokens missing from the current application state were rotated, logged out,
  // or expired. Persist the revocation so a restart cannot activate them again.
  const activeSessionHashes = new Set(state.refreshTokens.map((token) => token.hash));
  const knownUserIds = new Set(state.users.map((user) => user.id));
  const storedSessions = await selectAll(client, "user_sessions");
  const sessionHashesToRevoke = storedSessions
    .filter(
      (session) =>
        knownUserIds.has(session.user_id) &&
        !session.revoked_at &&
        !activeSessionHashes.has(session.token_hash),
    )
    .map((session) => session.token_hash as string);
  const revokedAt = new Date().toISOString();
  for (const batch of chunks(sessionHashesToRevoke, 200)) {
    const { error } = await client
      .from("user_sessions")
      .update({ revoked_at: revokedAt })
      .in("token_hash", batch);
    must(error, "revoke user sessions");
  }

  await upsertRows(
    client,
    "orders",
    state.orders.map((order) => ({
      id: order.id,
      public_number: orderNumber(order.id),
      user_id: order.userId,
      status: order.status,
      total_minor: order.totalMinor,
      currency: order.currency,
      ...(options.migration ? { idempotency_key: `migration:${order.id}` } : {}),
      created_at: order.createdAt,
      completed_at: order.status === "COMPLETED" ? order.createdAt : null,
    })),
    "id",
  );
  const booksById = new Map(state.books.map((book) => [book.id, book]));
  await upsertRows(
    client,
    "order_items",
    state.orders.flatMap((order) =>
      order.bookIds.map((bookId) => {
        const book = booksById.get(bookId);
        return {
          order_id: order.id,
          book_id: bookId,
          title_snapshot: book?.title || bookId,
          price_minor: book?.priceMinor || 0,
        };
      }),
    ),
    "order_id,book_id",
  );
  await upsertRows(
    client,
    "entitlements",
    state.entitlements.map((item) => ({
      user_id: item.userId,
      book_id: item.bookId,
      order_id:
        state.orders.find(
          (order) => order.userId === item.userId && order.bookIds.includes(item.bookId),
        )?.id || null,
      source: "MIGRATION",
      revoked_at: null,
    })),
    "user_id,book_id",
  );

  if (options.migration) {
    await upsertRows(
      client,
      "reading_progress",
      state.progress.map((item) => ({
        user_id: item.userId,
        book_id: item.bookId,
        chapter_id: item.chapterId,
        sentence_id: item.sentenceId || null,
        word_id: item.wordId || null,
        position_ms: Math.max(0, Math.round(item.positionMs)),
        percentage: item.percentage,
        client_updated_at: item.updatedAt,
        updated_at: item.updatedAt,
      })),
      "user_id,book_id",
    );
    await upsertRows(
      client,
      "chapter_progress",
      state.progress.map((item) => ({
        user_id: item.userId,
        chapter_id: item.chapterId,
        status: item.percentage >= 99.5 ? "COMPLETED" : "IN_PROGRESS",
        percentage: item.percentage,
        sentence_id: item.sentenceId || null,
        word_id: item.wordId || null,
        position_ms: Math.max(0, Math.round(item.positionMs)),
        updated_at: item.updatedAt,
      })),
      "user_id,chapter_id",
    );
  }
  await upsertRows(
    client,
    "bookmarks",
    state.bookmarks.map((item) => ({
      id: item.id,
      user_id: item.userId,
      book_id: item.bookId,
      chapter_id: item.chapterId,
      sentence_id: item.sentenceId,
      created_at: item.createdAt,
    })),
    "id",
  );
  await upsertRows(
    client,
    "reading_list",
    state.readingList.map((item) => ({
      user_id: item.userId,
      book_id: item.bookId,
      created_at: item.createdAt,
    })),
    "user_id,book_id",
  );

  await upsertRows(
    client,
    "book_reviews",
    state.reviews.map((item) => ({
      id: item.id,
      user_id: item.userId,
      book_id: item.bookId,
      rating: item.rating,
      body: item.body || "",
      spoiler: item.spoiler,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    })),
    "id",
  );
  await upsertRows(
    client,
    "chapter_comments",
    state.chapterComments.map((item) => ({
      id: item.id,
      user_id: item.userId,
      chapter_id: item.chapterId,
      parent_id: item.parentId || null,
      rating: item.parentId ? null : item.rating,
      body: item.body,
      spoiler: item.spoiler,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    })),
    "id",
  );
  await upsertRows(
    client,
    "content_reports",
    state.reports.map((item) => ({
      id: item.id,
      user_id: item.userId,
      book_id: item.bookId,
      chapter_id: item.chapterId,
      sentence_id: item.sentenceId || null,
      message: item.message,
      status: item.status,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    })),
    "id",
  );
  await upsertRows(
    client,
    "admin_audit_logs",
    state.auditLogs.map((item) => ({
      id: item.id,
      user_id: item.userId,
      action: item.action,
      created_at: item.createdAt,
    })),
    "id",
  );

};

const mergeChapter = (
  row: Row,
  seeded: Chapter | undefined,
  illustrations: Chapter["illustrations"],
): Chapter => ({
  ...(seeded || {
    id: row.id,
    bookId: row.book_id,
    title: row.title,
    position: row.position,
    durationMs: row.duration_ms,
    isSample: row.is_sample,
    sentences: [],
  }),
  id: row.id,
  bookId: row.book_id,
  title: row.title,
  position: row.position,
  durationMs: row.duration_ms,
  isSample: row.is_sample,
  sentenceCount: row.sentence_count,
  illustrations: row.illustrations_managed ? illustrations : seeded?.illustrations,
});

export const loadRelationalStore = async (
  client: SupabaseClient,
  seededBooks: Book[],
): Promise<Store | null> => {
  const { data: setting, error: settingError } = await client
    .from("app_settings")
    .select("value")
    .eq("key", "relational_store")
    .maybeSingle();
  if (settingError || !setting?.value?.ready) return null;

  const [
    users,
    profiles,
    settings,
    credentials,
    identities,
    sessions,
    books,
    chapters,
    chapterAssets,
    orders,
    orderItems,
    entitlements,
    progress,
    bookmarks,
    readingList,
    reviews,
    comments,
    reports,
    auditLogs,
  ] = await Promise.all([
    selectAll(client, "app_users"),
    selectAll(client, "profiles"),
    selectAll(client, "user_settings"),
    selectAll(client, "user_credentials"),
    selectAll(client, "user_identities"),
    selectAll(client, "user_sessions"),
    selectAll(client, "books"),
    selectAll(client, "chapters"),
    selectAll(client, "chapter_assets"),
    selectAll(client, "orders"),
    selectAll(client, "order_items"),
    selectAll(client, "entitlements"),
    selectAll(client, "reading_progress"),
    selectAll(client, "bookmarks"),
    selectAll(client, "reading_list"),
    selectAll(client, "book_reviews"),
    selectAll(client, "chapter_comments"),
    selectAll(client, "content_reports"),
    selectAll(client, "admin_audit_logs"),
  ]);

  if (!books.length) return null;
  const profileMap = new Map(profiles.map((item) => [item.user_id, item]));
  const settingMap = new Map(settings.map((item) => [item.user_id, item]));
  const credentialMap = new Map(credentials.map((item) => [item.user_id, item]));
  const identitiesByUser = new Map<string, Row[]>();
  identities.forEach((identity) =>
    identitiesByUser.set(identity.user_id, [
      ...(identitiesByUser.get(identity.user_id) || []),
      identity,
    ]),
  );
  const seededById = new Map(seededBooks.map((book) => [book.id, book]));
  const imageAssetsByChapter = new Map<string, Chapter["illustrations"]>();
  chapterAssets
    .filter((asset) => asset.kind === "IMAGE")
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .forEach((asset) => {
      const src = asset.bucket === "site-public"
        ? asset.object_path
        : client.storage.from(asset.bucket).getPublicUrl(asset.object_path).data.publicUrl;
      imageAssetsByChapter.set(asset.chapter_id, [
        ...(imageAssetsByChapter.get(asset.chapter_id) || []),
        {
          id: asset.id,
          src,
          alt: asset.alt_text || "صورة من الفصل",
          afterSentenceId: asset.after_sentence_id || undefined,
          position: asset.position,
          storagePath: asset.bucket === "chapter-images" ? asset.object_path : undefined,
        },
      ]);
    });
  const loadedBooks: Book[] = books.map((row) => {
    const seeded = seededById.get(row.id);
    const baseChapters = seeded?.chapters || [];
    const seededChapters = new Map(baseChapters.map((chapter) => [chapter.id, chapter]));
    const loadedChapters = chapters
      .filter((chapter) => chapter.book_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((chapter) => mergeChapter(
        chapter,
        seededChapters.get(chapter.id),
        imageAssetsByChapter.get(chapter.id) || [],
      ));
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      author: row.author,
      synopsis: row.synopsis,
      priceMinor: row.price_minor,
      currency: row.currency,
      genre: row.genre,
      tags: seeded?.tags || [],
      coverTheme: row.cover_theme,
      coverUrl: row.cover_url || undefined,
      status: row.status,
      rating: seeded?.rating || 0,
      chapters: loadedChapters,
      contentUnitLabel: seeded?.contentUnitLabel,
      contentUnitLabelPlural: seeded?.contentUnitLabelPlural,
      documentFile: seeded?.documentFile,
      pageCount: row.page_count ?? seeded?.pageCount,
    };
  });
  lastCatalogSignature = catalogSignature(loadedBooks);
  const orderItemsByOrder = new Map<string, string[]>();
  orderItems.forEach((item) =>
    orderItemsByOrder.set(item.order_id, [
      ...(orderItemsByOrder.get(item.order_id) || []),
      item.book_id,
    ]),
  );

  return {
    users: users
      .filter((user) => user.status === "ACTIVE")
      .map((user) => {
        const profile = profileMap.get(user.id);
        const preference = settingMap.get(user.id);
        const identity = (identitiesByUser.get(user.id) || []).find(
          (item) => item.provider !== "email",
        );
        return {
          id: user.id,
          name: profile?.display_name || "قارئ rethox",
          email: user.email || "",
          phone: user.phone || undefined,
          passwordHash: credentialMap.get(user.id)?.password_hash || "",
          role: user.role,
          theme: preference?.theme || "light",
          avatarUrl: profile?.avatar_url || undefined,
          createdAt: user.created_at,
          oauthProvider:
            identity?.provider === "google"
              ? "google"
              : identity?.provider === "supabase_phone"
                ? "supabase"
                : undefined,
          oauthSubject: identity?.provider_subject,
        };
      }),
    books: loadedBooks,
    orders: orders.map((order) => ({
      id: order.id,
      userId: order.user_id,
      bookIds: orderItemsByOrder.get(order.id) || [],
      totalMinor: order.total_minor,
      currency: order.currency,
      status: order.status,
      createdAt: order.created_at,
    })),
    entitlements: entitlements
      .filter((item) => !item.revoked_at)
      .map((item) => ({ userId: item.user_id, bookId: item.book_id })),
    progress: progress.map((item) => ({
      userId: item.user_id,
      bookId: item.book_id,
      chapterId: item.chapter_id,
      sentenceId: item.sentence_id || undefined,
      wordId: item.word_id || undefined,
      positionMs: item.position_ms,
      percentage: Number(item.percentage),
      updatedAt: item.updated_at,
    })),
    bookmarks: bookmarks.map((item) => ({
      id: item.id,
      userId: item.user_id,
      bookId: item.book_id,
      chapterId: item.chapter_id,
      sentenceId: item.sentence_id,
      createdAt: item.created_at,
    })),
    readingList: readingList.map((item) => ({
      userId: item.user_id,
      bookId: item.book_id,
      createdAt: item.created_at,
    })),
    reports: reports.map((item) => ({
      id: item.id,
      userId: item.user_id,
      bookId: item.book_id,
      chapterId: item.chapter_id,
      sentenceId: item.sentence_id || undefined,
      message: item.message,
      status: item.status === "OPEN" ? "OPEN" : "RESOLVED",
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
    reviews: reviews
      .filter((item) => !item.deleted_at)
      .map((item) => ({
        id: item.id,
        userId: item.user_id,
        bookId: item.book_id,
        rating: item.rating,
        body: item.body,
        spoiler: item.spoiler,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
    chapterComments: comments
      .filter((item) => !item.deleted_at)
      .map((item) => ({
        id: item.id,
        userId: item.user_id,
        chapterId: item.chapter_id,
        rating: item.rating || 0,
        body: item.body,
        spoiler: item.spoiler,
        parentId: item.parent_id || undefined,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
    refreshTokens: sessions
      .filter((item) => !item.revoked_at)
      .map((item) => ({
        userId: item.user_id,
        hash: item.token_hash,
        expiresAt: item.expires_at,
      })),
    auditLogs: auditLogs.map((item) => ({
      id: item.id,
      userId: item.user_id,
      action: item.action,
      createdAt: item.created_at,
    })),
  };
};

export const markRelationalReady = async (client: SupabaseClient) => {
  const { error } = await client.from("app_settings").upsert({
    key: "relational_store",
    value: { ready: true, dual_write: true },
    is_public: false,
    updated_at: new Date().toISOString(),
  });
  must(error, "mark relational store ready");
};

export const relationalCounts = async (client: SupabaseClient) => {
  const tables = [
    "app_users",
    "orders",
    "entitlements",
    "reading_progress",
    "bookmarks",
    "book_reviews",
    "chapter_comments",
    "books",
    "chapters",
  ];
  const output: Record<string, number> = {};
  for (const table of tables) {
    const { count, error } = await client
      .from(table)
      .select("*", { count: "exact", head: true });
    must(error, `count ${table}`);
    output[table] = count || 0;
  }
  return output;
};
