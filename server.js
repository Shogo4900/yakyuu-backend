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

wss.on("connection", (ws) => {
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`npb-live-backend listening on :${PORT}`);
});
