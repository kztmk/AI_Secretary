export type Category = "subscription" | "cancel" | "inquiry" | "bug" | "other";

/**
 * キーワードマッチによる分類ルール。先頭のルールほど優先される。
 * bug を cancel/subscription より先に置くのは「解約画面でエラーが出る」
 * のような複合メールを不具合として拾うため。
 * 将来Claude分類に昇格する際はこのモジュールごと差し替える（仕様書セクション15）。
 */
const RULES: ReadonlyArray<{ category: Category; keywords: ReadonlyArray<string> }> = [
  {
    category: "bug",
    keywords: ["不具合", "バグ", "エラー", "動かない", "表示されない", "ログインできない", "bug", "crash", "broken"],
  },
  {
    category: "cancel",
    keywords: ["解約", "退会", "キャンセル", "unsubscribe", "cancel"],
  },
  {
    category: "subscription",
    keywords: ["新規登録", "登録完了", "入会", "ご契約", "subscribed", "sign up", "signup"],
  },
  {
    category: "inquiry",
    keywords: ["問い合わせ", "お問合せ", "質問", "ご相談", "教えてください", "inquiry", "question"],
  },
];

export function classify(subject: string, body: string): Category {
  const text = `${subject}\n${body}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      return rule.category;
    }
  }
  return "other";
}
