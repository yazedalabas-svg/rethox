/**
 * Produces a speech-only version of the reader text.
 *
 * The displayed chapter is intentionally never altered.  Some typographic
 * marks that read nicely on a page (repeated ellipses, long dashes and French
 * quotes) make the speech service insert an exaggerated pause for every mark,
 * which sounds like stuttering at higher playback speeds.
 */
export const normalizeNarrationText = (value: string) =>
  value
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[«»‹›]/g, "")
    .replace(/[—–―]+/g, "، ")
    .replace(/…+|\.{3,}/g, "، ")
    .replace(/[■□◆◇]+/gu, " ")
    .replace(/\s+([،؛؟!.])/g, "$1")
    .replace(/([،؛؟!]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
