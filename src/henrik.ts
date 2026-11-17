// HenrikDev API（非公式 VALORANT API）の薄いクライアント。

const BASE = "https://api.henrikdev.xyz/valorant";

export class HenrikError extends Error {
  constructor(
    public status: number,
    public path: string,
    body: string,
  ) {
    super(`HenrikDev API ${status} ${path}: ${body.slice(0, 200)}`);
  }
}

export class Henrik {
  constructor(private key: string) {}

  /** レスポンス本文を文字列のまま返す（試合データは大きいので、必要な箇所でだけパースする）。 */
  async text(path: string, init?: RequestInit): Promise<string> {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { Authorization: this.key, Accept: "application/json", ...(init?.headers ?? {}) },
    });
    const body = await res.text();
    if (!res.ok) throw new HenrikError(res.status, path, body);
    return body;
  }

  async json<T = any>(path: string, init?: RequestInit): Promise<T> {
    return JSON.parse(await this.text(path, init)) as T;
  }

  account(name: string, tag: string) {
    return this.json(`/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  }

  /** Riot の試合履歴（IDと開始時刻だけの軽いリスト）。 */
  matchHistory(region: string, puuid: string, start: number, end: number) {
    return this.json(`/v1/raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "matchhistory",
        value: puuid,
        region,
        queries: `?startIndex=${start}&endIndex=${end}`,
      }),
    });
  }

  /** HenrikDev 側に保存済みの過去試合の一覧（Riot の履歴より古い試合が残っていることがある）。 */
  storedMatches(region: string, name: string, tag: string) {
    return this.json(
      `/v1/stored-matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=100`,
    );
  }

  matchText(region: string, matchId: string) {
    return this.text(`/v4/match/${region}/${matchId}`);
  }

  mmr(region: string, platform: string, name: string, tag: string) {
    return this.json(`/v3/mmr/${region}/${platform}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  }

  /** puuid 指定のアカウント情報（アカウントレベルを含む）。 */
  accountByPuuid(puuid: string) {
    return this.json(`/v2/by-puuid/account/${puuid}`);
  }

  /** puuid 指定のランク取得。Riot ID を変更した人でも引ける。 */
  mmrByPuuid(region: string, platform: string, puuid: string) {
    return this.json(`/v3/by-puuid/mmr/${region}/${platform}/${puuid}`);
  }

  mmrHistory(region: string, platform: string, name: string, tag: string, stored = false) {
    const kind = stored ? "stored-mmr-history" : "mmr-history";
    const q = stored ? "?size=100" : "";
    return this.json(
      `/v2/${kind}/${region}/${platform}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}${q}`,
    );
  }
}
