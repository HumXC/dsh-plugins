import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);

test("client declarations expose real, checked host contracts", () => {
  const config = fileURLToPath(new URL("./tsconfig.contracts.json", import.meta.url));
  const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", config], { encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
});

test("shared host contracts remain peers with matching development declarations", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.devDependencies["@deepseek-ai/dsh-client-runtime"], undefined);
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    assert.equal(manifest.dependencies[name], undefined, `${name} must not be a private runtime dependency`);
    assert.equal(manifest.devDependencies[name], version.replace(/^\^/, ""), `${name} needs matching development declarations`);
  }
  for (const name of manifest.dsh.client.inject) {
    assert.ok(name.startsWith("@deepseek-ai/dsh-client-ui-"));
    assert.equal(manifest.peerDependenciesMeta[name]?.optional, true);
  }
});

test("browser factory externalizes shared UI instead of bundling host implementations", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /window\.__ModuleLoader__\.load\(/);
  const dependencies = [...source.matchAll(/require\("([^"\n]+)"\)/g)].map(([, name]) => name);
  assert.deepEqual([...new Set(dependencies)].sort(), [
    "@deepseek-ai/dsh-client-ui-primitives", "react", "react/jsx-runtime",
  ]);
  assert.doesNotMatch(source, /class SlotRegistry|class SlotCore|dsh-client-runtime/);
});
