import React from "react";
import * as jsxRuntime from "react/jsx-runtime";

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
