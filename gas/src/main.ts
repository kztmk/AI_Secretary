import { runPoll } from "./gmail";

/**
 * 1日4回の時間ベーストリガーに登録するエントリポイント。
 *
 * トリガーに登録する関数は必ずこのファイルからexportすること。
 * @gas-plugin/unplugin がexport関数をtree-shakingから保護し、
 * dist/Code.js にトップレベル関数として残す（exportしない関数は
 * バンドルに畳み込まれ、GASのトリガー設定画面に現れない）。
 */
export function pollGmail(): void {
  runPoll();
}
