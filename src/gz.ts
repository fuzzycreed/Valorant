// gzip での圧縮・展開。生の試合データ（1試合 0.1〜0.7MB の JSON）を約 1/14 にして保存するために使う。

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  const out = new Response(stream.readable).arrayBuffer();
  const w = stream.writable.getWriter();
  await w.write(data);
  await w.close();
  return out;
}

export const gzip = (text: string): Promise<ArrayBuffer> => pipe(new TextEncoder().encode(text), new CompressionStream("gzip"));

/** D1 は BLOB を数値の配列で返すことがあるので、配列・ArrayBuffer・Uint8Array のどれでも受ける。 */
export async function gunzip(data: ArrayBuffer | ArrayLike<number>): Promise<string> {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
  return new TextDecoder().decode(await pipe(bytes, new DecompressionStream("gzip")));
}
