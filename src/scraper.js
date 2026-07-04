const axios = require("axios");
const cheerio = require("cheerio");

// 2026年シーズン時点のNPB12球団名（新規参入2球団含む）
// 表記ゆれ対策のため、スポナビ表記に合わせている
const TEAM_NAMES = [
  "オイシックス",
  "くふうハヤテ",
  "ソフトバンク",
  "日本ハム",
  "オリックス",
  "楽天",
  "西武",
  "ロッテ",
  "DeNA",
  "巨人",
  "中日",
  "広島",
  "ヤクルト",
  "阪神",
];

const STATUS_KEYWORDS = ["中止", "順延", "延期", "試合終了", "試合中", "見どころ", "試合前"];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/**
 * 現在時刻(JST)が、指定した"HH:MM"の開始時刻を過ぎているかどうかで
 * 「試合中」「試合前」を推測する。ステータスの文言が既知キーワードに
 * 一致しない場合の最終フォールバック用（「-」表示のまま残さないため）。
 */
function inferStatusFromTime(time) {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  const jstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const gameStart = new Date(jstNow);
  gameStart.setHours(h, m, 0, 0);

  return jstNow >= gameStart ? "試合中" : "試合前";
}

// 球場の愛称（ネーミングライツ）にチーム名がそのまま含まれるケースがあり、
// それを誤ってチーム名の出現位置として拾ってしまうと、本来の球場名部分が
// 空文字になり「球場未定」表示になってしまう。
// 例: 「楽天モバイル 最強パーク宮城」の「楽天」を、球団名の「楽天」と誤検出する
const TEAM_NAME_FALSE_POSITIVE_SUFFIX = {
  楽天: ["モバイル"],
};

/**
 * 球場名等に含まれる「チーム名っぽい部分文字列」を誤検出しないよう、
 * 除外リストに該当する続き文字が無いことを確認しながらチーム名の位置を探す。
 */
function findTeamIndex(text, team) {
  const excludes = TEAM_NAME_FALSE_POSITIVE_SUFFIX[team] || [];
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf(team, searchFrom);
    if (idx === -1) return -1;
    const after = text.slice(idx + team.length, idx + team.length + 4);
    if (excludes.some((ex) => after.startsWith(ex))) {
      searchFrom = idx + team.length;
      continue; // 球場名の一部などの誤検出なので、続きを探す
    }
    return idx;
  }
}

/**
 * 本日の日付をJSTのYYYY-MM-DD形式で返す
 */
function todayJST() {
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 1つの<a>要素のテキストから、球場・チーム2つ・予告先発2人・時刻/状況を抜き出す。
 * クラス名に依存せず「既知のチーム名」「時刻の正規表現」「状況キーワード」を
 * 手がかりにすることで、サイト側のマークアップ変更に強くしている。
 */
function parseGameCardText(text) {
  const compact = text.replace(/\s+/g, " ").trim();

  // 本文中に含まれるチーム名を、出現位置順に抽出
  const teamHits = [];
  for (const team of TEAM_NAMES) {
    const idx = findTeamIndex(compact, team);
    if (idx !== -1) teamHits.push({ team, idx });
  }
  teamHits.sort((a, b) => a.idx - b.idx);
  if (teamHits.length < 2) return null; // 対戦カードとして成立しない場合はスキップ

  const [teamA, teamB] = teamHits.slice(0, 2).map((h) => h.team);

  // 球場名は、最初のチーム名より前の部分にあることが多い
  const venue = compact.slice(0, teamHits[0].idx).trim() || null;


  const timeMatch = compact.match(/(\d{1,2}:\d{2})/);
  const time = timeMatch ? timeMatch[1] : null;

  let status = null;
  for (const kw of STATUS_KEYWORDS) {
    if (compact.includes(kw)) {
      status = kw;
      break;
    }
  }
  if (!status) {
    status = inferStatusFromTime(time);
  }

  const pitcherMatches = [...compact.matchAll(/\(予\)([^\s()0-9]+)/g)].map((m) => m[1]);

  return {
    venue,
    teamA,
    teamB,
    pitcherA: pitcherMatches[0] || null,
    pitcherB: pitcherMatches[1] || null,
    time,
    status,
  };
}

/**
 * 本日のNPB全試合を取得する
 */
async function fetchTodaySchedule() {
  const url = "https://baseball.yahoo.co.jp/npb/schedule/first/all";
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(html);

  const games = [];
  const seenIds = new Set();

  $('a[href*="/npb/game/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const idMatch = href.match(/\/npb\/game\/(\d+)\//);
    if (!idMatch) return;
    const gameId = idMatch[1];
    if (seenIds.has(gameId)) return;

    const parsed = parseGameCardText($(el).text());
    if (!parsed) return;

    seenIds.add(gameId);
    games.push({ gameId, ...parsed });
  });

  return { date: todayJST(), games };
}

/**
 * 「●」等、count系の表示に使われる文字数をそのままカウントする
 */
function countLamps(text) {
  const trimmed = (text || "").replace(/\s+/g, "");
  if (!trimmed) return 0;
  return trimmed.length;
}

/**
 * "9回表" のようなテキストから { number, half, raw } を抜き出す
 */
function parseInning(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/(\d+)回(表|裏)/);
  if (!match) return { number: null, half: null, raw: trimmed };
  return {
    number: Number(match[1]),
    half: match[2] === "表" ? "top" : "bottom",
    raw: trimmed,
  };
}

/**
 * #base のclass属性（例: "b100"）から塁上状態を読み取る。
 * b + 3桁の0/1で、1塁・2塁・3塁の順に「走者あり=1」を表す確実な形式。
 * #base1/#base2/#base3 の中に走者名（背番号+名前）も入っているので、
 * 表示の一意性チェックも兼ねて併せて取得する。
 * テキスト解析（「ランナー1塁」等）と違い、常に現在の状態をそのまま反映するため、
 * 「明言が無い間は前回の状態を維持する」ような複雑な処理は不要になる。
 */
function parseRunnersFromBase($) {
  const classAttr = $("#base").attr("class") || "";
  const match = classAttr.match(/b([01])([01])([01])/);

  const bases = match
    ? {
        first: match[1] === "1",
        second: match[2] === "1",
        third: match[3] === "1",
      }
    : { first: false, second: false, third: false };

  const names = {
    first: $("#base1 span").first().text().trim() || null,
    second: $("#base2 span").first().text().trim() || null,
    third: $("#base3 span").first().text().trim() || null,
  };

  return { bases, names };
}

/**
 * 試合IDから一球速報ページを取得し、現在の状況をパースする
 */
async function fetchGameScore(gameId) {
  const url = `https://baseball.yahoo.co.jp/npb/game/${gameId}/score`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  const $ = cheerio.load(html);

  const balls = countLamps($(".sbo .b b").first().text());
  const strikes = countLamps($(".sbo .s b").first().text());
  const outs = countLamps($(".sbo .o b").first().text());

  const inning = parseInning($("#sbo h4.live em").first().text());

  const lastResultText = $("#result span").first().text().trim() || null;
  const pitchInfoText = $("#result em").first().text().trim() || null;

  // 「試合中止」「降雨のため」のような表記を検知する。
  // 中止・降雨・順延・ノーゲームのいずれかが直近の結果テキストに含まれていれば中止扱い。
  const suspendKeywords = ["中止", "降雨", "順延", "ノーゲーム"];
  const suspended = suspendKeywords.some(
    (kw) => (lastResultText || "").includes(kw) || (pitchInfoText || "").includes(kw)
  );
  const suspendedReason = suspended
    ? [lastResultText, pitchInfoText].filter(Boolean).join(" ")
    : null;

  const { bases: runners, names: runnerNames } = parseRunnersFromBase($);

  // #currentActionIndex の value が一球ごとの一意な番号（NPBページで確認済み）。
  // 見つからない場合は #replay の index にフォールバック（MLBページで確認済み）。
  const pitchIndex =
    $("#currentActionIndex").attr("value") ||
    $("#replay a#btn_prev").attr("index") ||
    null;

  const battingTeamText = $("#liveinfo p").first().text().trim() || null;

  // スコア表: <td class="nm act"> チーム略称 </td><td>得点</td> のペアを拾う
  const score = [];
  $("td.nm").each((_, el) => {
    const teamAbbr = $(el).text().trim();
    const runsText = $(el).next("td").text().trim();
    if (teamAbbr && runsText !== "") {
      score.push({
        team: teamAbbr,
        runs: runsText,
        active: $(el).hasClass("act"),
      });
    }
  });

  // 試合前はスコア表自体がまだ存在せず、scoreが空のままになることがある
  // （表示側でチーム名が「?」になる原因）。ページの<title>には
  // 「◯◯vs.◯◯ 一球速報」という形式でチーム名が入っているはずなので、
  // そこから補完する。
  if (score.length < 2) {
    const titleText = $("title").first().text();
    const titleMatch = titleText.match(/\d+年\d+月\d+日\s*(.+?)vs\.(.+?)\s*一球速報/);
    if (titleMatch) {
      score.push(
        { team: titleMatch[1].trim(), runs: "0", active: false },
        { team: titleMatch[2].trim(), runs: "0", active: false }
      );
    }
  }

  return {
    gameId,
    fetchedAt: new Date().toISOString(),
    inning,
    count: { balls, strikes, outs },
    lastResult: lastResultText,
    pitchInfo: pitchInfoText,
    pitchIndex,
    battingTeam: battingTeamText,
    runners,
    runnerNames,
    suspended,
    suspendedReason,
    score,
  };
}

module.exports = {
  fetchTodaySchedule,
  fetchGameScore,
  todayJST,
};
