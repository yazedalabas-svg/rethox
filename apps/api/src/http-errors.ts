export type ClientHttpError = { status: 400 | 413; message: string };

/** Converts body-parser failures into stable client errors instead of false 500s. */
export const clientHttpError = (error: unknown): ClientHttpError | null => {
  const candidate = error as { type?: unknown; status?: unknown } | null;
  if (candidate?.type === "entity.too.large" || candidate?.status === 413)
    return { status: 413, message: "حجم الطلب أكبر من الحد المسموح" };
  if (
    candidate?.type === "entity.parse.failed" ||
    (error instanceof SyntaxError && candidate?.status === 400)
  ) return { status: 400, message: "صيغة الطلب غير صحيحة" };
  return null;
};
