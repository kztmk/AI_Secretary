import gasPlugin from "@gas-plugin/unplugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // autoGlobals(デフォルトtrue)でmain.tsのexport関数は保護されるが、
  // トリガー登録関数は消えると気づきにくいため明示もしておく
  plugins: [gasPlugin({ globals: ["pollGmail"] })],
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: () => "Code.js",
    },
    target: "es2019",
    minify: false,
  },
});
