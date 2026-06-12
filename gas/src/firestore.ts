import type { Category } from "./classifier";

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string };

export type DocumentData = Record<string, string | number | boolean | Date>;

const BASE_URL = "https://firestore.googleapis.com/v1";

function databasePath(projectId: string): string {
  return `projects/${projectId}/databases/(default)`;
}

function toFirestoreValue(val: string | number | boolean | Date): FirestoreValue {
  if (val instanceof Date) {
    return { timestampValue: val.toISOString() };
  }
  if (typeof val === "string") {
    return { stringValue: val };
  }
  if (typeof val === "boolean") {
    return { booleanValue: val };
  }
  // REST APIでは整数は文字列で渡す
  return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
}

function fetchJson(url: string, options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions): unknown {
  const res = UrlFetchApp.fetch(url, { ...options, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code >= 300) {
    throw new Error(`Firestore API error ${code}: ${res.getContentText().slice(0, 500)}`);
  }
  return JSON.parse(res.getContentText());
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` };
}

export function documentExists(projectId: string, collection: string, docId: string): boolean {
  const url = `${BASE_URL}/${databasePath(projectId)}/documents/${collection}/${encodeURIComponent(docId)}`;
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: authHeaders(),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200) {
    return true;
  }
  if (code === 404) {
    return false;
  }
  throw new Error(`Firestore API error ${code}: ${res.getContentText().slice(0, 500)}`);
}

/**
 * updateMask付きPATCH。docIdが同じなら何度実行しても同じ結果になる（upsert）。
 * updateMaskを付けない素のPATCHはドキュメント全体を置き換えてしまい、
 * Cloud Functionsが書いたフィールド（draftText等）を消すため必ず付ける。
 */
export function upsertDocument(
  projectId: string,
  collection: string,
  docId: string,
  data: DocumentData,
): void {
  const fields: Record<string, FirestoreValue> = {};
  const maskParams: string[] = [];
  for (const key of Object.keys(data)) {
    fields[key] = toFirestoreValue(data[key]);
    maskParams.push(`updateMask.fieldPaths=${encodeURIComponent(key)}`);
  }
  const url =
    `${BASE_URL}/${databasePath(projectId)}/documents/${collection}/${encodeURIComponent(docId)}` +
    `?${maskParams.join("&")}`;
  fetchJson(url, {
    method: "patch",
    headers: authHeaders(),
    contentType: "application/json",
    payload: JSON.stringify({ fields }),
  });
}

interface RunQueryResultRow {
  document?: {
    name: string;
    fields?: Record<string, { stringValue?: string }>;
  };
}

/**
 * receivedAt >= since の emails をカテゴリ別に集計する。
 * 巡回のたびにFirestoreから数え直すため、同じメールを再処理しても
 * 二重計上にならない（レポートupsertと合わせて冪等）。
 */
export function countEmailsByCategorySince(projectId: string, since: Date): Record<Category, number> {
  const url = `${BASE_URL}/${databasePath(projectId)}/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "emails" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "receivedAt" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { timestampValue: since.toISOString() },
        },
      },
    },
  };
  const rows = fetchJson(url, {
    method: "post",
    headers: authHeaders(),
    contentType: "application/json",
    payload: JSON.stringify(body),
  });
  if (!Array.isArray(rows)) {
    // 黙って0件扱いにするとreports/daily_*を0件で上書きしてしまうため、
    // 予期しないレスポンスは集計を中断して異常を露見させる
    throw new Error(`Firestore runQuery: 予期しないレスポンス形式です: ${JSON.stringify(rows).slice(0, 200)}`);
  }

  const counts: Record<Category, number> = { subscription: 0, cancel: 0, inquiry: 0, bug: 0, other: 0 };
  for (const row of rows as RunQueryResultRow[]) {
    const category = row.document?.fields?.category?.stringValue;
    if (category && category in counts) {
      counts[category as Category] += 1;
    }
  }
  return counts;
}
