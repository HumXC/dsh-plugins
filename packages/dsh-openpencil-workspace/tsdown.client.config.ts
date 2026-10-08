import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { client: "src/browser.tsx" }, outDir: "lib", clean: false,
  platform: "node", target: "es2022", format: "cjs", dts: false, sourcemap: false,
  deps: { neverBundle: [/^react(?:[/]|$)/, /^react-dom(?:[/]|$)/, /^@deepseek-ai[/]/] }, checks: { legacyCjs: false },
  banner: 'window.__ModuleLoader__.load({ id: "dsh-openpencil-workspace", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  footer: "return module.exports; } });", outExtensions: () => ({ js: ".js" }),
});
