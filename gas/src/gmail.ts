import { classify } from "./classifier";
import { getConfig, type Config } from "./config";
import { countEmailsByCategorySince, getExistingDocIds, upsertDocument } from "./firestore";

const SUMMARY_MAX_LENGTH = 200;
/** GmailLabel.addToThreads が1回で受け付けるスレッド数の上限 */
const ADD_TO_THREADS_MAX = 100;

/** 定時巡回の本体。main.tsのpollGmail()から呼ばれる */
export function runPoll(): void {
  const cfg = getConfig();
  const label = getOrCreateLabel(cfg.processedLabel);

  // 未読フラグではなくFirestoreのmessageIdで処理済み判定する。
  // category:primary でプロモーション等を入口で除外（仕様書セクション14）。
  // 通常の未処理スレッドを優先し、処理済みスレッドへの新規返信は別クエリで拾う。
  const baseQuery = `in:inbox category:primary newer_than:${cfg.searchWindow}`;
  const labelQueryValue = quoteGmailSearchValue(cfg.processedLabel);
  const queries = [
    `${baseQuery} -label:${labelQueryValue}`,
    `${baseQuery} label:${labelQueryValue}`,
  ];

  // cutoffは処理済みスレッドの再スキャン（クエリ2）にだけ適用する。
  // 未処理スレッドは、SEARCH_WINDOWより古い初回メールが返信でスレッドごと
  // 再浮上したケースを取りこぼさないようcutoffなしで全件候補にする
  // （既存docはbatchGetの結果で除外されるため二重保存はない）。
  // ただし期間外の過去メッセージは文脈保存のみで、下書き生成対象には
  // しない（saveEmailのwithinSearchWindow参照）。
  const windowCutoff = getSearchWindowCutoff(cfg.searchWindow);
  const cutoffs: Array<Date | null> = [null, windowCutoff];

  // 第1パス: HTTPを発行せず、保存候補メッセージとラベル対象スレッドを集める
  const seenThreadIds: Record<string, true> = {};
  const threadsToLabel: GoogleAppsScript.Gmail.GmailThread[] = [];
  const candidates: GoogleAppsScript.Gmail.GmailMessage[] = [];
  let skipped = 0;
  let scannedThreads = 0;

  for (let i = 0; i < queries.length; i++) {
    const threads = GmailApp.search(queries[i], 0, cfg.maxThreadsPerRun);
    for (const thread of threads) {
      const threadId = thread.getId();
      if (seenThreadIds[threadId]) {
        continue;
      }
      seenThreadIds[threadId] = true;
      scannedThreads += 1;
      for (const message of thread.getMessages()) {
        if (isCandidateMessage(message, cutoffs[i])) {
          candidates.push(message);
        } else {
          skipped += 1;
        }
      }
      threadsToLabel.push(thread);
    }
  }

  // 既存docの確認はメッセージごとのGETでなくbatchGetでまとめて行う
  // （6分制限とUrlFetchAppクォータの節約）
  const existingIds = getExistingDocIds(
    cfg.projectId,
    "emails",
    candidates.map((message) => message.getId()),
  );

  let saved = 0;
  for (const message of candidates) {
    if (existingIds[message.getId()]) {
      skipped += 1;
    } else {
      saveEmail(cfg, message, isWithinSearchWindow(message, windowCutoff));
      saved += 1;
    }
  }

  // ラベルは1スレッドずつでなく一括付与してGmail API呼び出しを減らす。
  // 保存途中の例外停止でラベルが付かなくても、次回巡回の再スキャンと
  // 既存doc除外により重複なく回収される
  for (let i = 0; i < threadsToLabel.length; i += ADD_TO_THREADS_MAX) {
    label.addToThreads(threadsToLabel.slice(i, i + ADD_TO_THREADS_MAX));
  }

  updateDailyReport(cfg);
  Logger.log(`pollGmail: ${scannedThreads}スレッド・${saved}件のメールを処理しました（${skipped}件スキップ）`);
}

function isCandidateMessage(
  message: GoogleAppsScript.Gmail.GmailMessage,
  cutoff: Date | null,
): boolean {
  if (!message.isInInbox()) {
    return false;
  }
  return cutoff === null || message.getDate().getTime() >= cutoff.getTime();
}

function isWithinSearchWindow(
  message: GoogleAppsScript.Gmail.GmailMessage,
  windowCutoff: Date | null,
): boolean {
  // SEARCH_WINDOWが解釈不能（null）の場合は期間内扱い＝従来どおり
  return windowCutoff === null || message.getDate().getTime() >= windowCutoff.getTime();
}

function quoteGmailSearchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getSearchWindowCutoff(searchWindow: string): Date | null {
  const match = searchWindow.trim().match(/^(\d+)([dmy])$/i);
  if (!match) {
    Logger.log(`SEARCH_WINDOW "${searchWindow}" の形式を解釈できないため、メッセージ日付の追加フィルタを省略します`);
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const cutoff = new Date();
  // 実行時刻に依存した境界の揺れを避けるため当日0時に揃える。
  // newer_than:より過去寄り（緩い側）に倒れるため取りこぼしは増えない
  cutoff.setHours(0, 0, 0, 0);
  if (unit === "d") {
    cutoff.setDate(cutoff.getDate() - amount);
  } else if (unit === "m") {
    cutoff.setMonth(cutoff.getMonth() - amount);
  } else {
    cutoff.setFullYear(cutoff.getFullYear() - amount);
  }
  return cutoff;
}

function saveEmail(
  cfg: Config,
  message: GoogleAppsScript.Gmail.GmailMessage,
  withinSearchWindow: boolean,
): void {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const category = classify(subject, body);
  // SEARCH_WINDOWより古いメッセージはスレッド文脈の保存のみ行い、
  // 下書き生成対象（requested）にはしない。古い問い合わせは対応済みの
  // 可能性が高く、再浮上したスレッドでは期間内の新しい返信側がrequestedになる
  const needsDraft = withinSearchWindow && (category === "inquiry" || category === "bug");

  // docId = GmailのmessageId。既存docはbatchGetの結果で除外するため、
  // Phase3以降のdraftStatusをrequested/noneへ巻き戻さない。
  upsertDocument(cfg.projectId, "emails", message.getId(), {
    receivedAt: new Date(message.getDate().getTime()),
    category,
    subject,
    fromAddress: message.getFrom(),
    summary: buildSummary(body),
    draftStatus: needsDraft ? "requested" : "none",
    processedAt: new Date(),
  });
}

/** Phase 1ではClaude未使用のため、本文冒頭の抜粋をsummaryとする */
function buildSummary(body: string): string {
  // 巨大な本文（自動送信ログ等）全体に正規表現を掛けない。
  // 先頭に空白・空行が密集した本文でも要約が痩せないよう窓は10倍取る
  const truncated = body.slice(0, SUMMARY_MAX_LENGTH * 10);
  const collapsed = truncated.replace(/\s+/g, " ").trim();
  return collapsed.length > SUMMARY_MAX_LENGTH
    ? `${collapsed.slice(0, SUMMARY_MAX_LENGTH)}…`
    : collapsed;
}

function getOrCreateLabel(name: string): GoogleAppsScript.Gmail.GmailLabel {
  const existing = GmailApp.getUserLabelByName(name);
  return existing !== null ? existing : GmailApp.createLabel(name);
}

function updateDailyReport(cfg: Config): void {
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const dateKey = Utilities.formatDate(now, tz, "yyyy-MM-dd");
  // 当日0時。GAS(V8)のDateローカルタイムゾーンはappsscript.jsonのtimeZoneに
  // 一致するため、ローカル時刻ベースの組み立てで足りる
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const counts = countEmailsByCategorySince(cfg.projectId, startOfDay);

  // docId = daily_{日付}。1日4回の巡回で同じIDにupsertするため重複しない
  upsertDocument(cfg.projectId, "reports", `daily_${dateKey}`, {
    generatedAt: now,
    period: "daily",
    newSubscriptions: counts.subscription,
    cancellations: counts.cancel,
    inquiries: counts.inquiry,
    bugs: counts.bug,
    summaryText:
      `本日の集計: 新規${counts.subscription}件 / 解約${counts.cancel}件` +
      ` / 問い合わせ${counts.inquiry}件 / 不具合${counts.bug}件`,
  });
}
