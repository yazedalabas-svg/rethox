export type RefreshSession = { userId: string; hash: string; expiresAt: string };

/** Replaces an active refresh token so a copied old cookie cannot be replayed. */
export const rotateRefreshSession = (
  sessions: RefreshSession[],
  currentHash: string,
  nextHash: string,
  nowMs: number,
  lifetimeMs: number,
) => {
  const index = sessions.findIndex(
    (session) => session.hash === currentHash && Date.parse(session.expiresAt) > nowMs,
  );
  if (index < 0) return null;
  const previous = sessions[index];
  const next: RefreshSession = {
    userId: previous.userId,
    hash: nextHash,
    expiresAt: new Date(nowMs + lifetimeMs).toISOString(),
  };
  sessions.splice(index, 1, next);
  return { previous, next };
};
