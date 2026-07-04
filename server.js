const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const { fetchTodaySchedule } = require("./src/scraper");
const pollManager = require("./src/pollManager");

const app = express();
app.use(cors());

// 直近の日程結果を軽くキャッシュ（数分に1回程度の更新で十分なため）
let scheduleCache = { data: null, fetchedAt: 0 };
const SCHEDULE_CACHE_MS = 60000;

app.get("/api/games/today", async (req, res) => {
  try {
    const now = Date.now();
    if (!scheduleCache.data || now - scheduleCache.fetchedAt > SCHEDULE_CACHE_MS) {
      scheduleCache.data = await fetchTodaySchedule();
      scheduleCache.fetchedAt = now;
    }
    res.json(scheduleCache.data);
  } catch (err) {
    console.error("[GET /api/games/today]", err.message);
    res.status(502).json({ error: "スケジュールの取得に失敗しました" });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// 死んだ接続（回線が切れているのにcloseイベントが飛んでこない状態）を検知するための
// ハートビート。ブラウザ側は特別な実装なしに自動でpongを返してくれる。
// Renderのようなプロキシ経由の環境では、通信が一定時間無いと途中で無言のまま
// 切られることがあるため、これが無いと「更新が止まって見える」原因になる。
function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "watch" && msg.gameId) {
      pollManager.watch(msg.gameId, ws);
    } else if (msg.type === "unwatch" && msg.gameId) {
      pollManager.unwatch(msg.gameId, ws);
    }
  });

  ws.on("close", () => {
    pollManager.removeSocketEverywhere(ws);
  });
});

const HEARTBEAT_INTERVAL_MS = 20000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      // 前回のpingに応答が無かった＝実質的に切れている接続なので、
      // ここで確実にcloseイベントを発火させ、pollManager側の購読も解除する
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeatTimer));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`npb-live-backend listening on :${PORT}`);
});
