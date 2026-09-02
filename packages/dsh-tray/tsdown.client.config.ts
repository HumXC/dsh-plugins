import { defineConfig } from "tsdown";

const moduleId = "dsh-tray";

export default defineConfig({
  entry: { client: "src/client.ts" },
  outDir: "lib",
  clean: false,
  platform: "node",
  target: "es2022",
  format: "cjs",
  dts: false,
  sourcemap: false,
  deps: {
    neverBundle: true,
  },
  checks: {
    legacyCjs: false,
  },
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(moduleId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  footer: "return module.exports; } });",
  outExtensions: () => ({ js: ".js" }),
});
