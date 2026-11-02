import { describe, expect, it } from "vitest";
import { cleanDbName, resolveDbName } from "../config";

describe("db name guard", () => {
  it("rejects stringified-unset and test names", () => {
    for (const bad of ["undefined", "null", "None", "nan", "NaN", "", " ", "test", undefined]) {
      expect(cleanDbName(bad, "prism")).toBe("prism");
    }
    expect(cleanDbName("mydb", "prism")).toBe("mydb");
  });
  it("skips bad candidates and keeps later good ones", () => {
    expect(resolveDbName(["undefined", "null", "real"], "prism")).toBe("real");
    expect(resolveDbName(["undefined", undefined], "prism")).toBe("prism");
  });
});
