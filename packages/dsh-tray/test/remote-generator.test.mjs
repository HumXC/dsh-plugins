import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceAnalyzer, FaceModelEmitter } from "@deepseek-ai/dsh-typert-generator";

test("patched official generator recognizes npm Protocol provenance but rejects lookalike decorators", async t => {
    const root = await mkdtemp(join(tmpdir(), "dsh-tray-generator-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "packages/probe");
    await mkdir(join(directory, "src"), { recursive: true });
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
    await writeFile(join(root, "tsconfig.host.json"), JSON.stringify({ files: [], references: [{ path: "./packages/probe/tsconfig.json" }] }));
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "probe", type: "module", exports: { ".": { types: "./lib/index.d.ts", default: "./lib/index.js" } } }));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, types: ["node"], rootDir: "src", outDir: "lib" }, include: ["src/**/*.ts"] }));
    const imports = `import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
`;
    const service = `/** @typert service probe */
export class Probe extends TypertRemoteService {
    constructor(ctx: Context) { super(ctx, "probe"); }
    @Remote({ mode: "stream" })
    async *watch(request: string, signal: AbortSignal): AsyncIterable<string> {
        if (!signal.aborted) yield request;
    }
}
`;
    const source = join(directory, "src/index.ts");
    await writeFile(source, imports + service);
    const analyze = () => new WorkspaceAnalyzer({ root, faces: ["host"], packages: ["probe"], checkDiagnostics: true }).analyze().faces[0];
    const face = analyze();
    assert.equal(face.packages[0].invocations.length, 1);
    assert.ok(new FaceModelEmitter(face).emit("probe").remote);
    await writeFile(join(directory, "src/lookalike.ts"), `export function Remote(_options: { mode: "stream" }) {
    return function (_method: unknown, _context: ClassMethodDecoratorContext): void {};
}
`);
    await writeFile(source, imports.replace("Remote, TypertRemoteService", "TypertRemoteService") + `import { Remote } from "./lookalike.js";
` + service);
    assert.equal(analyze().packages[0].invocations.length, 0);
});
