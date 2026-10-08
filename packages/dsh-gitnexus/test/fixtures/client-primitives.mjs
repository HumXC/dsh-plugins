import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

// Bind the actual installed host Hook to a controllable enclosing-Turn reset source.
const runtimeRoot = process.env.DSH_RUNTIME_ROOT ?? join(homedir(), ".npm-packages/lib/node_modules/@deepseek-ai/dsh");
const deployedRequire = createRequire(join(runtimeRoot, "package.json"));
const chatSource = await readFile(deployedRequire.resolve("@deepseek-ai/dsh-client-ui-chat/client"), "utf8");
const hookStart = chatSource.indexOf("//#region lib/types/client/chat/use-disclosure.js");
const hookEnd = chatSource.indexOf("//#endregion", hookStart);
assert.ok(hookStart >= 0 && hookEnd > hookStart, "installed host must expose its disclosure Hook source section");
const { bindDisclosure } = runInNewContext(chatSource.slice(hookStart, hookEnd) + "; ({ bindDisclosure })", { react: React });

export function createDisclosureHarness() {
  let version = 0;
  const listeners = new Set();
  const useDisclosure = bindDisclosure({
    getSnapshot: () => version,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
  return {
    useDisclosure,
    collapseTurn() { version++; for (const listener of listeners) listener(); },
    subscriberCount: () => listeners.size,
  };
}

export function toolCallProps(block, extra = {}) {
  return {
    sessionId: "row-session", callId: block.callId, toolName: "gitnexus_impact",
    phase: block.kind === "tool-result" ? "result" : block.phase, block,
    openFile() {}, loadImage: async () => null,
    useDisclosure: createDisclosureHarness().useDisclosure, ...extra,
  };
}

// Contract stub for the host-owned primitive, not a replacement shipped to Web.
export function DisclosureRow({ icon, title, open, onToggle, collapsedContent, children, rowClassName, titleClassName, expandOnRowClick, keepContentWhenOpen }) {
  return React.createElement("div", null,
    React.createElement("div", {
      className: rowClassName, role: "button", tabIndex: 0,
      "aria-expanded": open, "data-shared-disclosure": true,
      onClick: onToggle,
      onKeyDown(event) {
        if (expandOnRowClick && ["Enter", " "].includes(event.key)) { event.preventDefault(); onToggle(); }
      },
    }, icon, React.createElement("span", { className: titleClassName }, title), (keepContentWhenOpen || !open) && collapsedContent),
    open && children,
  );
}

export async function loadToolRows() {
  const previous = globalThis.window;
  let plugin;
  globalThis.window = { __ModuleLoader__: { load(definition) {
    plugin = definition.factory(id => {
      if (id === "react") return React;
      if (id === "react/jsx-runtime") return jsxRuntime;
      if (id === "@deepseek-ai/dsh-client-ui-primitives") return { DisclosureRow };
      throw new Error("Unexpected browser dependency: " + id);
    });
  } } };
  try {
    await import("../../lib/client.js?row-test=" + Math.random());
    const rows = new Map();
    plugin.apply({
      slots: {
        inject(_slot, factory) { [...factory()]; return () => {}; },
        register(spec, component) { rows.set(spec.key, component); return () => rows.delete(spec.key); },
      },
      effect() {},
    });
    return rows;
  } finally { globalThis.window = previous; }
}
