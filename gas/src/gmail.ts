import { classify } from "./classifier";
import { getConfig, type Config } from "./config";
import { countEmailsByCategorySince, documentExists, upsertDocument } from "./firestore";

const SUMMARY_MAX_LENGTH = 200;

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

  let saved = 0;
  let skipped = 0;
  let scannedThreads = 0;
  const seenThreadIds: Record<string, true> = {};
  const cutoff = getSearchWindowCutoff(cfg.searchWindow);

  for (const query of queries) {
    const threads = GmailApp.search(query, 0, cfg.maxThreadsPerRun);
    for (const thread of threads) {
      const threadId = thread.getId();
      if (seenThreadIds[threadId]) {
        continue;
      }
      seenThreadIds[threadId] = true;
      scannedThreads += 1;

      const result = processThread(cfg, thread, cutoff);
      saved += result.saved;
      skipped += result.skipped;
      thread.addLabel(label);
    }
  }

  updateDailyReport(cfg);
  Logger.log(`pollGmail: ${scannedThreads}スレッド・${saved}件のメールを処理しました（${skipped}件スキップ）`);
}

function processThread(
  cfg: Config,
  thread: GoogleAppsScript.Gmail.GmailThread,
  cutoff: Date | null,
): { saved: number; skipped: number } {
  let saved = 0;
  let skipped = 0;
  for (const message of thread.getMessages()) {
    if (shouldProcessMessage(cfg, message, cutoff)) {
      saveEmail(cfg, message);
      saved += 1;
    } else {
      skipped += 1;
    }
  }
  return { saved, skipped };
}

function shouldProcessMessage(
  cfg: Config,
  message: GoogleAppsScript.Gmail.GmailMessage,
  cutoff: Date | null,
): boolean {
  if (!message.isInInbox()) {
    return false;
  }
  if (cutoff !== null && message.getDate().getTime() < cutoff.getTime()) {
    return false;
  }
  return !documentExists(cfg.projectId, "emails", message.getId());
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
  if (unit === "d") {
    cutoff.setDate(cutoff.getDate() - amount);
  } else if (unit === "m") {
    cutoff.setMonth(cutoff.getMonth() - amount);
  } else {
    cutoff.setFullYear(cutoff.getFullYear() - amount);
  }
  return cutoff;
}

function saveEmail(cfg: Config, message: GoogleAppsScript.Gmail.GmailMessage): void {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const category = classify(subject, body);
  const needsDraft = category === "inquiry" || category === "bug";

  // docId = GmailのmessageId。既存docはshouldProcessMessageで除外するため、
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
  const collapsed = body.replace(/\s+/g, " ").trim();
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
