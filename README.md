# VALORANT 戦績サイト

自分の VALORANT の試合を取り込み、HS%・FB・FD などを集計して表示する個人用サイト。
Cloudflare Workers + D1 で動き、データは [HenrikDev API](https://docs.henrikdev.xyz/)（非公式）から取得する。

## 見られるもの

- **概要**: 勝率、K/D、ACS、ADR、HS%、KAST、FB / FD（回数と、その時のラウンド勝率）、試合ごとの推移、ランク推移
- **内訳**: 命中部位、攻守別、ピストルラウンド、マルチキル、クラッチ、トレード、設置 / 解除
- **切り口別**: エージェント別、マップ別、武器別キル、一緒に遊んだ人ごとの勝率
- **試合一覧と試合詳細**: 全10人のスコアボードと、ラウンドごとのキルの流れ
- モード、アクト、エージェント、マップ、直近N試合で絞り込み

## 指標の定義

| 指標 | 定義 |
|---|---|
| HS% | 命中した弾のうち頭に当たった割合（頭 ÷ 頭+胴+脚） |
| ACS | 戦闘スコア ÷ ラウンド数 |
| ADR | 与ダメージ ÷ ラウンド数 |
| FB / FD | 各ラウンドで最初に「敵を倒した」キルの、倒した側 / 倒された側。落下死やスパイクでの自滅は含めない |
| KAST | キル・アシスト・生存・トレードされたデスのいずれかがあったラウンドの割合 |
| トレード | 味方を倒した敵を 5 秒以内に倒すこと（`src/stats.ts` の `TRADE_WINDOW_MS`） |
| クラッチ | チームで最後の1人になった時点で敵が1人以上残っていて、そのラウンドに勝つこと。蘇生は考慮しない |

## 仕組み

- 10分おきの定期実行が、新しい試合IDを検出してキューに積み、1回につき2試合ずつ取り込む
- 初回は Riot の試合履歴と HenrikDev 側の保存済み試合から、取れるだけ過去に遡る
- 取り込んだ試合の生データも D1 に保存するので、指標の定義を変えても作り直せる
- テーブルは起動時にコードが自動作成する（マイグレーションの手動実行は不要）

## デプロイ（Cloudflare）

1. Cloudflare ダッシュボードの **Workers & Pages → Create → Import a repository** でこのリポジトリを選ぶ
   - Build command は空、Deploy command は `npx wrangler deploy` のまま
   - D1 データベースは初回デプロイ時に自動で作られる
2. 作成された Worker の **Settings → Variables and Secrets** に、種類 **Secret** で `HENRIK_API_KEY` を追加する（HenrikDev の APIキー）
3. **Settings → Domains & Routes** でカスタムドメイン（例 `val.example.com`）を割り当てる
4. サイトを開くと初回の取り込みが始まる

追跡する Riot ID は `wrangler.jsonc` の `RIOT_IDS`（カンマ区切りで複数可）。

自分だけに見せたい場合は、Cloudflare Zero Trust の Access でそのドメインにログイン制限をかける。

## ローカル開発

```bash
npm install
echo 'HENRIK_API_KEY=HDEV-xxxx' > .dev.vars   # コミットしない
npm run sync:local                            # 実データをローカル D1 に取り込む
npm run dev                                   # http://localhost:8787
npm test                                      # 指標計算の単体テスト
npm run sync:local -- --recompute             # 保存済みの生データから再集計
```

## 制約

- HenrikDev API は非公式。仕様変更や停止で取得できなくなる可能性がある
- 無料キーは 30 リクエスト/分。初回の取り込みは数分かかる
- 過去の試合は API 側に残っている分しか取れない。取り込み開始以降の試合は欠けずに貯まる
- ランク推移は API が返す直近分から貯め始める
- Cloudflare 無料プランは1回の実行あたりの CPU 時間が短い。取り込みで CPU 制限のエラーが続く場合は Workers 有料プランが必要

このサイトは Riot Games の承認・後援を受けたものではありません。
