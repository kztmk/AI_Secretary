export interface Config {
  /** FirebaseプロジェクトID（Firestore REST APIのパスに使用） */
  projectId: string;
  /** 処理済みメールに付けるGmailラベル名 */
  processedLabel: string;
  /** 1回の巡回で処理するスレッド数の上限（GASの6分制限対策） */
  maxThreadsPerRun: number;
  /** Gmail検索の対象期間（newer_than:の値） */
  searchWindow: string;
}

/**
 * 設定はScript Properties（GASエディタ > プロジェクトの設定 >
 * スクリプト プロパティ）で管理する。GAS実行環境に.envは存在せず、
 * コードへのハードコードはclasp pushでソースごと公開されるため避ける。
 */
export function getConfig(): Config {
  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty("FIREBASE_PROJECT_ID");
  if (!projectId) {
    throw new Error(
      "Script Property FIREBASE_PROJECT_ID が未設定です。" +
        "GASエディタの「プロジェクトの設定 > スクリプト プロパティ」で設定してください。",
    );
  }
  return {
    projectId,
    processedLabel: props.getProperty("PROCESSED_LABEL") ?? "secretary-processed",
    maxThreadsPerRun: readPositiveInt(props, "MAX_THREADS_PER_RUN", 50),
    searchWindow: props.getProperty("SEARCH_WINDOW") ?? "3d",
  };
}

/** 不正値（数値以外・0以下・小数）は警告を残して既定値にフォールバックする */
function readPositiveInt(
  props: GoogleAppsScript.Properties.Properties,
  key: string,
  fallback: number,
): number {
  const raw = props.getProperty(key);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    Logger.log(`Script Property ${key} の値 "${raw}" は正の整数ではないため、既定値 ${fallback} を使います`);
    return fallback;
  }
  return parsed;
}
