# npb-live-backend

スポナビ（baseball.yahoo.co.jp）をスクレイピングし、NPBの本日の対戦カード一覧と、
選択した試合の一球速報（カウント・得点・直近の結果など）をWebSocketで配信するサーバー。

個人・少人数での非公開利用を前提とした構成。

## エンドポイント

### `GET /api/games/today`
本日のNPB全試合を返す。

```json
{
  "date": "2026-07-03",
  "games": [
    {
      "gameId": "2021038866",
      "venue": "東京ドーム",
      "teamA": "巨人",
      "teamB": "DeNA",
      "pitcherA": "ウィットリー",
      "pitcherB": "篠木",
      "time": "14:00",
      "status": "試合前"
    }
  ]
}
```

### `WS /ws`
接続後、以下のメッセージを送ることで試合を購読/解除できる。

```json
{ "type": "watch", "gameId": "2021038866" }
{ "type": "unwatch", "gameId": "2021038866" }
```

サーバーからは以下の形式でpushされる（20秒間隔でポーリングし、直近の一球番号が
変化したときだけ配信）。

```json
{
  "type": "update",
  "gameId": "2021038866",
  "state": {
    "inning": { "number": 9, "half": "top", "raw": "9回表" },
    "count": { "balls": 2, "strikes": 1, "outs": 1 },
    "lastResult": "ボール",
    "pitchInfo": "152km/h ストレート",
    "pitchIndex": "0910401",
    "battingTeam": "巨人攻撃中",
    "runners": { "first": true, "second": false, "third": false },
    "score": [
      { "team": "ヤ", "runs": "1", "active": true },
      { "team": "巨", "runs": "2", "active": false }
    ]
  }
}
```

`runners`はテキストに「ランナー◯塁」の明言があったときだけ更新され、それ以外は前回の状態を維持する（打者走者がヒット後にアウトになるなどテキストが出ないケースがあるため）。イニングが切り替わったタイミングでは自動的に塁上をリセットする。

誰も購読していない試合はポーリングを止めるので、無駄なアクセスは発生しない。

## セットアップ

```bash
npm install
npm run dev   # nodemonで起動（開発用）
npm start     # 本番起動
```

環境変数 `PORT` でポート指定可能（デフォルト3001）。

## Railwayへのデプロイ

1. このディレクトリをGitHubリポジトリにpush
2. Railwayで「New Project」→「Deploy from GitHub repo」
3. Start Commandは `npm start`（package.jsonから自動検出されるはず）
4. デプロイ後に発行されるURL（`https://xxxx.up.railway.app`）を
   フロントエンド側の環境変数 `NEXT_PUBLIC_API_BASE` に設定する
   （WebSocketは `wss://xxxx.up.railway.app/ws` になる）

## 既知の注意点・要調整ポイント

- スケジュールページのパースは「チーム名の既知リスト」「時刻の正規表現」
  「試合前/試合中/試合終了などのキーワード」を手がかりにしており、
  HTML構造そのものへの依存を減らしているが、実際のレスポンスで
  一度動作確認・微調整してほしい
- `.sbo .b b` 等のカウント表示は、丸のUnicode文字数をそのまま数える実装。
  実データで確認した文字と異なる場合は `src/scraper.js` の `countLamps` を調整
- スコア表 (`td.nm`) のセレクタはMLBページで確認した構造。NPBページで
  クラス名が異なる場合は要修正
- 本日の対戦カード取得は `/npb/schedule/first/all`（日付パラメータなし＝当日扱い）
  を前提にしている
