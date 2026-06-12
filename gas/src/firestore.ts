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

/** documents:batchGet に1回で渡すドキュメント数の上限（ペイロード・レスポンス抑制） */
const BATCH_GET_CHUNK = 100;

interface BatchGetResultRow {
  found?: { name: string };
  missing?: string;
}

/**
 * 渡したdocIdのうちFirestoreに存在するものを返す。
 * 1件ずつGETせずbatchGetでまとめて確認し、HTTPリクエスト数を
 * メッセージ件数からチャンク数（最大でも数回）に抑える。
 */
export function getExistingDocIds(
  projectId: string,
  collection: string,
  docIds: string[],
): Record<string, true> {
  const existing: Record<string, true> = {};
  const namePrefix = `${databasePath(projectId)}/documents/${collection}/`;
  for (let i = 0; i < docIds.length; i += BATCH_GET_CHUNK) {
    const chunk = docIds.slice(i, i + BATCH_GET_CHUNK);
    const rows = fetchJson(`${BASE_URL}/${databasePath(projectId)}/documents:batchGet`, {
      method: "post",
      headers: authHeaders(),
      contentType: "application/json",
      payload: JSON.stringify({ documents: chunk.map((id) => `${namePrefix}${id}`) }),
    });
    if (!Array.isArray(rows)) {
      // 黙って「全件未存在」と解釈すると既存docへ再upsertして
      // draftStatusを巻き戻すため、中断して異常を露見させる
      throw new Error(`Firestore batchGet: 予期しないレスポンス形式です: ${JSON.stringify(rows).slice(0, 200)}`);
    }
    for (const row of rows as BatchGetResultRow[]) {
      const name = row.found?.name;
      if (name) {
        existing[name.slice(name.lastIndexOf("/") + 1)] = true;
      }
    }
  }
  return existing;
}

export interface WriteOp {
  docId: string;
  data: DocumentData;
}

/** documents:commit に1回で渡す書き込み数の上限（APIの上限は500） */
const COMMIT_CHUNK = 100;

/**
 * 複数ドキュメントを documents:commit で一括upsertする。
 * 1件ずつPATCHすると件数ぶん同期HTTPが走り6分制限を圧迫するため、
 * チャンク単位の1リクエストにまとめる。updateMaskの意味論は
 * upsertDocumentと同じ（列挙したフィールドだけ更新・なければ作成）。
 */
export function commitUpsertDocuments(
  projectId: string,
  collection: string,
  writes: WriteOp[],
): void {
  if (writes.length === 0) {
    return;
  }
  const namePrefix = `${databasePath(projectId)}/documents/${collection}/`;
  for (let i = 0; i < writes.length; i += COMMIT_CHUNK) {
    const chunk = writes.slice(i, i + COMMIT_CHUNK);
    const body = {
      writes: chunk.map((write) => {
        const fields: Record<string, FirestoreValue> = {};
        const fieldPaths: string[] = [];
        for (const key of Object.keys(write.data)) {
          fields[key] = toFirestoreValue(write.data[key]);
          fieldPaths.push(key);
        }
        return {
          update: { name: `${namePrefix}${write.docId}`, fields },
          updateMask: { fieldPaths },
        };
      }),
    };
    fetchJson(`${BASE_URL}/${databasePath(projectId)}/documents:commit`, {
      method: "post",
      headers: authHeaders(),
      contentType: "application/json",
      payload: JSON.stringify(body),
    });
  }
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
