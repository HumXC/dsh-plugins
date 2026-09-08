import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { WorkspaceAnalyzer, FaceModelEmitter } from "@deepseek-ai/dsh-typert-generator";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = new WorkspaceAnalyzer({
    root: resolve(packageRoot, "../.."),
    hostConfig: "packages/dsh-tray/tsconfig.typert.json",
    faces: ["host"],
    packages: ["dsh-tray"],
    checkDiagnostics: true,
}).analyze();
const face = workspace.faces.find(face => face.face === "host");
if (!face) throw new Error("Typert did not discover the tray Host face");
const artifact = new FaceModelEmitter(face).emit("dsh-tray");
if (!artifact.remote) throw new Error("Typert did not generate a tray Remote contract");
const output = resolve(packageRoot, "lib");
await mkdir(output, { recursive: true });
await Promise.all([
    writeFile(resolve(output, "typert.host.js"), artifact.js),
    writeFile(resolve(output, "typert.host.d.ts"), artifact.dts),
    writeFile(resolve(output, "typert.remote-client.js"), artifact.remote.js),
    writeFile(resolve(output, "typert.remote-client.d.ts"), artifact.remote.dts),
    writeFile(resolve(output, "typert.remote-client.d.ts.map"), artifact.remote.dtsMap),
]);
