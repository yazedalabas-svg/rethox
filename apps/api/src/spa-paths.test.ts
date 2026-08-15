import { describe, expect, it } from "vitest";
import { isStaticSpaPath } from "./spa-paths.js";

describe("static SPA paths", () => {
  it("serves the customer support desk on direct navigation and refresh", () => {
    expect(isStaticSpaPath("/support")).toBe(true);
    expect(isStaticSpaPath("/support/")).toBe(true);
  });

  it("does not turn unknown URLs into successful SPA responses", () => {
    expect(isStaticSpaPath("/not-a-real-page")).toBe(false);
  });
});
