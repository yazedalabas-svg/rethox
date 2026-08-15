import { describe, expect, it } from "vitest";
import { clientHttpError } from "./http-errors.js";

describe("clientHttpError", () => {
  it("classifies oversized bodies", () => {
    expect(clientHttpError({ type: "entity.too.large" })).toEqual({
      status: 413,
      message: "حجم الطلب أكبر من الحد المسموح",
    });
  });

  it("classifies malformed JSON", () => {
    const error = Object.assign(new SyntaxError("bad json"), { status: 400 });
    expect(clientHttpError(error)?.status).toBe(400);
  });

  it("leaves internal errors private", () => {
    expect(clientHttpError(new Error("database unavailable"))).toBeNull();
  });
});
