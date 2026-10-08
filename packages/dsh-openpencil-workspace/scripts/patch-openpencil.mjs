#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
export const VERSION = "0.1.0-rc.13";
export const HASHES = {
  "lib/client.js": "8a6b82deb330afbae48ea8ec33dab7654df7addc55efa9a472bfb730c49c7b92",
  "lib/index.js": "0fee85db10640521273b2ad9881ecdaf0052680f6faafccc03a7e61e97c50e83",
};
export const hash = (text) => createHash("sha256").update(text).digest("hex");
function once(text, anchor, insertion) {
  const first = text.indexOf(anchor);
  if (first < 0 || text.indexOf(anchor, first + anchor.length) >= 0) throw new Error("Unsupported OpenPencil patch anchor: " + anchor);
  return text.slice(0, first) + insertion + text.slice(first + anchor.length);
}
// Keep the original prompt branch exact so unknown official bundles are rejected.
export const recoveryClientAnchor = `const recoveryCopy = editorRecoveryCopy(localeRef.current);
\t\t\t\t\tconst message = launch.recovery.sourceChangedSinceCapture ? recoveryCopy.conflict(launch.recovery.sourceName) : recoveryCopy.available(launch.recovery.sourceName);
\t\t\t\t\tif (window.confirm(message)) {
\t\t\t\t\t\tdocumentJson = await restoreManagedEditorRecovery(launch, launch.recovery);
\t\t\t\t\t\trestoredRecoveryRef.current = true;
\t\t\t\t\t}`;
export const recoveryClientReplacement = `const recoveredDocument = await workspaceResolveRecovery(launch, launch.recovery, localeRef.current);
\t\t\t\t\tif (recoveredDocument !== void 0) {
\t\t\t\t\t\tdocumentJson = recoveredDocument;
\t\t\t\t\t\trestoredRecoveryRef.current = true;
\t\t\t\t\t}`;
export const recoveryPromptSource = `async function workspaceResolveRecovery(launch, recovery, locale) {
  const copy = editorRecoveryCopy(locale);
  const message = recovery.sourceChangedSinceCapture ? copy.conflict(recovery.sourceName) : copy.available(recovery.sourceName);
  if (window.confirm(message)) return restoreManagedEditorRecovery(launch, recovery);
  const discardMessage = locale === "zh-CN"
    ? "要保留磁盘上的源文件，并永久放弃 " + recovery.sourceName + " 的未保存恢复稿吗？\\n\\n确定：清除恢复稿，源文件保持不变。\\n取消：保留恢复稿，下次打开仍会提示。"
    : "Keep the file on disk and permanently discard the unsaved recovery draft for " + recovery.sourceName + "?\\n\\nOK: clear the recovery draft without changing the source file.\\nCancel: keep the draft and ask again next time.";
  if (window.confirm(discardMessage)) await discardManagedEditorRecovery(launch, recovery);
}
`;
function patchToolbarClient(text) {
  text = once(text, "onLifecycleController, workbenchActions, allowTakeover = true }) {", "onLifecycleController, workbenchActions, hideToolbar = false, allowTakeover = true }) {");
  return once(text, "style: panelStyles.toolbar,", 'style: hideToolbar ? { display: "none" } : panelStyles.toolbar,');
}
export function patch(file, text) {
  if (hash(text) !== HASHES[file]) throw new Error("Unsupported OpenPencil bundle hash: " + file);
  if (file === "lib/client.js") {
    text = patchToolbarClient(text);
    text = once(text, 'style: hideToolbar ? { display: "none" } : panelStyles.toolbar,', 'className: "dsh-openpencil-workspace-toolbar", style: hideToolbar ? { display: "none" } : panelStyles.toolbar,');
    text = once(text, recoveryClientAnchor, recoveryClientReplacement);
    return once(text, "function mountEditorWorkbenchHost(options) {", recoveryPromptSource + templateClient());
  }
  if (file === "lib/index.js") {
    text = "import { createDocumentSnapshotFromText as workspaceSnapshot, projectDocumentGrant as workspaceProject } from './renderer.js';\n" + text;
    return once(text, "    const editorHost = new EditorHostController(accessKey);",
      "    const editorHost = new EditorHostController(accessKey);\n" +
      "    ctx.provide('openpencilWorkspaceHost', { version: 1, async grantForDocument(path, text) {\n" +
      "      const document = await workspaceSnapshot(text);\n" +
      "      const editor = editorHost.grantFor(path, document.sha256);\n" +
      "      if (!editor || !controller.routeAvailable) throw new Error('OpenPencil editor routes are unavailable');\n" +
      "      return workspaceProject({ path, document }, controller, editor).$dshOpenPencil;\n" +
      "    } });");
  }
  throw new Error("Unexpected patch file");
}
function templateClient() {
  return 	templateClientText;
}
const templateClientText = `function mountEditorWorkbenchHost(options) {
  // dsh-openpencil-workspace v1: no sidebar root or dock is ever mounted.
  const workspaceBridge = globalThis.__DSH_OPENPENCIL_WORKSPACE_V1__ ??= { version: 1 };
  workspaceBridge.runtime = {
    Editor: ManagedOpenPencilEditor, options, key: editorWorkbenchEditorKey,
    locale: editorLocaleFromDsh, successor: isPublishedSuccessorOfLiveDraft,
    preserve: preserveEditorBeforeWorkbenchDispose
  };
  globalThis.dispatchEvent?.(new Event('dsh-openpencil-workspace:runtime'));
  let workspaceDisposed = false;
  return {
    open(request) {
      if (workspaceDisposed) return Promise.resolve(false);
      if (!workspaceBridge.handler) return Promise.reject(new Error('Enable dsh-openpencil-workspace to open the editor'));
      return workspaceBridge.handler.open(request, false);
    },
    openIfIdle(request) {
      if (workspaceDisposed) return Promise.resolve(false);
      return workspaceBridge.handler?.open(request, true) ?? Promise.resolve(false);
    },
    async dispose() {
      if (workspaceDisposed) return;
      workspaceDisposed = true;
      await workspaceBridge.handler?.dispose();
    }
  };
`;
async function atomicWrite(path, text) {
  const temp = path + ".workspace-" + randomUUID();
  await writeFile(temp, text, { flag: "wx" }); await rename(temp, path);
}
/** Validates both bundles before mutation; refuses unknown versions and edited backups. */
export async function manage(command, root) {
  if (!["check", "apply", "restore"].includes(command)) throw new Error("Use check, apply, or restore");
  root = resolve(root);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "@zseven-w/dsh-openpencil" || pkg.version !== VERSION) throw new Error("Unsupported OpenPencil version; expected " + VERSION);
  const backupRoot = join(root, ".dsh-openpencil-workspace-backup");
  const plans = [];
  for (const file of Object.keys(HASHES)) {
    const path = join(root, file), current = await readFile(path, "utf8");
    let original;
    if (hash(current) === HASHES[file]) original = current;
    else {
      original = await readFile(join(backupRoot, file.replaceAll("/", "_")), "utf8");
      if (hash(original) !== HASHES[file]) throw new Error("Refusing modified bundle or backup: " + file);
      const accepted = [patch(file, original)];
      if (file === "lib/client.js") {
        // Accept only byte-exact earlier workspace patches when upgrading.
        accepted.push(once(patchToolbarClient(original), "function mountEditorWorkbenchHost(options) {", templateClientText));
        accepted.push(once(original, "function mountEditorWorkbenchHost(options) {", templateClientText));
        let titled = once(original, "onLifecycleController, workbenchActions, allowTakeover = true }) {", "onLifecycleController, workbenchActions, workbenchTitle, allowTakeover = true }) {");
        titled = once(titled, "title: documentGrant.path,\n\t\t\t\t\tchildren: title", "title: documentGrant.path,\n\t\t\t\t\tchildren: workbenchTitle ?? title");
        accepted.push(once(titled, "function mountEditorWorkbenchHost(options) {", templateClientText.replace("  workspaceBridge.runtime = {\n", "  workspaceBridge.runtime = {\n    titleSlot: true,\n")));
      }
      if (!accepted.includes(current)) throw new Error("Refusing modified bundle or backup: " + file);
    }
    const patched = patch(file, original);
    plans.push({ file, path, current, original, patched, state: current === patched ? "patched" : current === original ? "original" : "outdated" });
  }
  if (command !== "check") {
    if (command === "apply") {
      await mkdir(backupRoot, { recursive: true });
      for (const item of plans) {
        const backup = join(backupRoot, item.file.replaceAll("/", "_"));
        try { await writeFile(backup, item.original, { flag: "wx" }); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (hash(await readFile(backup, "utf8")) !== HASHES[item.file]) throw new Error("Refusing modified backup");
        }
      }
    }
    const written = [];
    try {
      for (const item of plans) {
        if (await readFile(item.path, "utf8") !== item.current) throw new Error("Bundle changed during patch: " + item.file);
        const next = command === "apply" ? item.patched : item.original;
        if (next !== item.current) { await atomicWrite(item.path, next); written.push(item); }
      }
    } catch (error) {
      for (const item of written.reverse()) await atomicWrite(item.path, item.current);
      throw error;
    }
  }
  return { root, version: VERSION, command, files: plans.map(({file,state}) => ({file, state: command === "check" ? state : command === "apply" ? "patched" : "original"})) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[3]) throw new Error("Usage: node scripts/patch-openpencil.mjs check|apply|restore /absolute/path/to/@zseven-w/dsh-openpencil");
    console.log(JSON.stringify(await manage(process.argv[2], process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
