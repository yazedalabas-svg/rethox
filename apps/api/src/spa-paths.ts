const staticSpaPaths = new Set([
  "/",
  "/login",
  "/register",
  "/cart",
  "/settings",
  "/account",
  "/admin",
  "/support",
]);

export const isStaticSpaPath = (requestPath: string) => {
  const normalizedPath =
    requestPath.length > 1 ? requestPath.replace(/\/+$/, "") : requestPath;
  return staticSpaPaths.has(normalizedPath);
};
