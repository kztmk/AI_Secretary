export type Category = 'subscription' | 'cancel' | 'inquiry' | 'bug' | 'other';

/**
 * キーワードマッチによる分類ルール。先頭のルールほど優先される。
 * bug を cancel/subscription より先に置くのは「解約画面でエラーが出る」
 * のような複合メールを不具合として拾うため。
 * 英字キーワードは必ず小文字で定義する（判定対象をtoLowerCase()した上で
 * キーワード側は変換せず比較するため）。
 * 将来Claude分類に昇格する際はこのモジュールごと差し替える（仕様書セクション15）。
 */
const RULES: ReadonlyArray<{
  category: Category;
  keywords: ReadonlyArray<string>;
}> = [
  {
    category: 'bug',
    keywords: [
      '不具合',
      'バグ',
      'エラー',
      '動かない',
      '表示されない',
      'ログインできない',
      'bug',
      'crash',
      'broken',
    ],
  },
  {
    category: 'cancel',
    keywords: ['解約', '退会', 'キャンセル', 'unsubscribe', 'cancel'],
  },
  {
    category: 'subscription',
    keywords: [
      '新規登録',
      '登録完了',
      '入会',
      'ご契約',
      'subscribed',
      'sign up',
      'signup',
    ],
  },
  {
    category: 'inquiry',
    keywords: [
      '問い合わせ',
      'お問合せ',
      '質問',
      'ご相談',
      '教えてください',
      'inquiry',
      'question',
    ],
  },
];

/** 分類キーワードは冒頭に現れるのが通例のため、本文は先頭のみ判定する */
const CLASSIFY_BODY_MAX_LENGTH = 10000;

export function classify(subject: string, body: string): Category {
  // 巨大な本文（自動送信ログ等）全体のtoLowerCase()によるメモリ圧迫を避ける。
  // 取りこぼしても "other"（下書き生成対象外）に落ちるだけで安全
  const text =
    `${subject}\n${body.slice(0, CLASSIFY_BODY_MAX_LENGTH)}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      return rule.category;
    }
  }
  return 'other';
}
