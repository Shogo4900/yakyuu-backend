const { fetchGameScore } = require("./scraper");

const POLL_INTERVAL_MS = 5000; // 実測25〜50秒に対し、検知の遅延をさらに減らすため5秒間隔に短縮

/**
 * gameId ごとに {intervalHandle, subscribers:Set<ws>, lastState} を保持する。
 * 誰も見ていない試合はポーリングしないことで、スポナビ側への負荷を抑える。
 */
class PollManager {
  constructor() {
    this.games = new Map();
  }

  watch(gameId, ws) {
    let entry = this.games.get(gameId);
    if (!entry) {
      entry = { subscribers: new Set(), lastState: null, timer: null };
      this.games.set(gameId, entry);
      this._startPolling(gameId, entry);
    }
    entry.subscribers.add(ws);
    console.log(
      `[watch] gameId=${gameId} at=${new Date().toISOString()} subscribers=${entry.subscribers.size}`
    );

    // 直近の状態が既にあれば、接続直後に即座に送る
    if (entry.lastState) {
      this._sendTo(ws, { type: "update", gameId, state: entry.lastState });
    }
  }

  unwatch(gameId, ws) {
    const entry = this.games.get(gameId);
    if (!entry) return;
    entry.subscribers.delete(ws);
    console.log(
      `[unwatch] gameId=${gameId} at=${new Date().toISOString()} subscribers=${entry.subscribers.size}`
    );
    if (entry.subscribers.size === 0) {
      clearInterval(entry.timer);
      this.games.delete(gameId);
    }
  }

  /** クライアント切断時に、購読していた全試合から外す */
  removeSocketEverywhere(ws) {
    for (const gameId of [...this.games.keys()]) {
      this.unwatch(gameId, ws);
    }
  }

  _startPolling(gameId, entry) {
    const poll = async () => {
      try {
        const state = await fetchGameScore(gameId);
        const prev = entry.lastState;
        const changed = !prev || prev.pitchIndex !== state.pitchIndex;
        entry.lastState = state;

        console.log(
          `[poll] gameId=${gameId} at=${new Date().toISOString()} pitchIndex=${state.pitchIndex} changed=${changed} subscribers=${entry.subscribers.size}`
        );

        if (changed) {
          this._broadcast(entry, { type: "update", gameId, state });
        }
      } catch (err) {
        this._broadcast(entry, {
          type: "error",
          gameId,
          message: "取得に失敗しました。次回のポーリングで再試行します。",
        });
        console.error(`[pollManager] gameId=${gameId} fetch error:`, err.message);
      }
    };

    poll(); // 初回は即実行
    entry.timer = setInterval(poll, POLL_INTERVAL_MS);
  }

  _broadcast(entry, payload) {
    for (const ws of entry.subscribers) {
      this._sendTo(ws, payload);
    }
  }

  _sendTo(ws, payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
}

module.exports = new PollManager();
