import { describe, expect, it } from "vitest";
import { resetSeconds } from "../src/henrik";

describe("resetSeconds", () => {
  it("Ratelimit ヘッダーから、制限が解けるまでの秒数を読む", () => {
    expect(resetSeconds(`"per1min";r=0;t=8;pk=:abc:`)).toBe(8);
    expect(resetSeconds(`"per1min";r=12;t=60`)).toBe(60);
  });
  it("ヘッダーが無い・形が違うときは undefined", () => {
    expect(resetSeconds(null)).toBeUndefined();
    expect(resetSeconds("limit=30")).toBeUndefined();
  });
});
