import { classify } from "./classifier";
import { getConfig, type Config } from "./config";
import { countEmailsByCategorySince, upsertDocument } from "./firestore";

const SUMMARY_MAX_LENGTH = 200;

/** 定時巡回の本体。main.tsのpollGmail()から呼ばれる */
export function runPoll(): void {
  const cfg = getConfig();
  const label = getOrCreateLabel(cfg.processedLabel);

  // 未読フラグではなく処理済みラベルで管理（既読化のタイミングに依存しない）。
  // category:primary でプロモーション等を入口で除外（仕様書セクション14）。
  const query = `in:inbox category:primary -label:${cfg.processedLabel} newer_than:${cfg.searchWindow}`;
  const threads = GmailApp.search(query, 0, cfg.maxThreadsPerRun);

  let saved = 0;
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      saveEmail(cfg, message);
      saved += 1;
    }
    // GmailAppのラベルはスレッド単位。処理済みスレッドへの新規返信は
    // 検索から漏れる既知の制限（gas/README.md参照）
    thread.addLabel(label);
  }

  updateDailyReport(cfg);
  Logger.log(`pollGmail: ${threads.length}スレッド・${saved}件のメールを処理しました`);
}

function saveEmail(cfg: Config, message: GoogleAppsScript.Gmail.GmailMessage): void {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const category = classify(subject, body);
  const needsDraft = category === "inquiry" || category === "bug";

  // docId = GmailのmessageId。巡回が重複してもupsertで冪等（仕様書セクション5）
  // getDate()はGoogleAppsScript.Base.Date型のため標準のDateに変換する
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
  // スクリプトのタイムゾーンでの当日0時
  const startOfDay = new Date(Utilities.formatDate(now, tz, "yyyy-MM-dd'T'00:00:00XXX"));

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
