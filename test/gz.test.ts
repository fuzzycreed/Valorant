import { describe, expect, it } from "vitest";
import { gunzip, gzip } from "../src/gz";

describe("gzip / gunzip", () => {
  const text = JSON.stringify({ data: { players: Array.from({ length: 200 }, (_, i) => ({ name: `プレイヤー${i}`, score: i * 37 })) } });
  it("圧縮して展開すると元に戻る", async () => {
    const z = await gzip(text);
    expect(z.byteLength).toBeLessThan(text.length / 3);
    expect(await gunzip(z)).toBe(text);
  });
  it("D1 が返す数値の配列からも展開できる", async () => {
    const z = await gzip(text);
    expect(await gunzip(Array.from(new Uint8Array(z)))).toBe(text);
  });
});
