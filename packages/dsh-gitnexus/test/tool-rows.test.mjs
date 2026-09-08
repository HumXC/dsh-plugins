import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import React from "react";
import { loadToolRows, DisclosureRow } from "./fixtures/client-primitives.mjs";
const GitNexusToolRow = (await loadToolRows()).get("gitnexus_impact");

const require = createRequire(import.meta.url);
const { act, create } = require("react-test-renderer");
const props = { callId: "nested-call", toolName: "gitnexus_impact", openFile() {} };
const argsRaw = JSON.stringify({ target: "run" });
const result = (text, extra = {}) => ({ kind: "tool-result", call: { argsRaw }, content: [{ type: "text", text }], isError: false, ...extra });
const head = renderer => renderer.root.findByProps({ className: "gitnexus-tool-head" });
const row = renderer => renderer.root.findByProps({ className: "gitnexus-tool-row" });
const summary = renderer => renderer.root.findByProps({ className: "gitnexus-tool-summary" }).children.join("");

function render(block, extra = {}) {
    let renderer;
    act(() => { renderer = create(React.createElement(GitNexusToolRow, { ...props, block, ...extra })); });
    return renderer;
}

test("nested result without meta expands exact full output and inspect action", () => {
    const output = JSON.stringify({ risk: "LOW", impactedCount: 1, detail: "long evidence ".repeat(1000) }) + "\n\n---\nKeep this warning verbatim.";
    let inspected = 0;
    const renderer = render(result(output), { inspect: () => { inspected += 1; } });
    try {
        assert.equal(row(renderer).props["data-state"], "settled");
        assert.equal(head(renderer).props.role, "button");
        assert.equal(renderer.root.findByType(DisclosureRow).props.expandOnRowClick, true);
        assert.equal(head(renderer).props["aria-expanded"], false);
        assert.equal(renderer.root.findAllByProps({ className: "gitnexus-tool-text" }).length, 0);
        act(() => head(renderer).props.onClick());
        assert.equal(head(renderer).props["aria-expanded"], true);
        assert.deepEqual(renderer.root.findAllByProps({ className: "gitnexus-tool-text" }).map(text => text.children.join("")), [argsRaw, output]);
        assert.deepEqual(renderer.root.findAllByProps({ className: "gitnexus-tool-label" }).map(text => text.children.join("")), ["输入", "输出"]);
        const inspect = renderer.root.findAllByType("button").find(button => button.children.includes("查看轨迹"));
        act(() => inspect.props.onClick());
        assert.equal(inspected, 1);
        assert.equal(head(renderer).props["aria-expanded"], true);
        act(() => head(renderer).props.onClick());
        assert.equal(head(renderer).props["aria-expanded"], false);
        assert.equal(renderer.root.findAllByProps({ className: "gitnexus-tool-text" }).length, 0);
    } finally { act(() => renderer.unmount()); }
});

test("running to settled retains expansion and replaces running summary", () => {
    const renderer = render({ argsRaw });
    try {
        assert.equal(row(renderer).props["data-state"], "running");
        assert.match(summary(renderer), /run.*执行中/);
        act(() => head(renderer).props.onClick());
        const output = JSON.stringify({ risk: "HIGH", impactedCount: 7 });
        act(() => renderer.update(React.createElement(GitNexusToolRow, { ...props, block: result(output) })));
        assert.equal(row(renderer).props["data-state"], "settled");
        assert.equal(head(renderer).props["aria-expanded"], true);
        assert.doesNotMatch(summary(renderer), /执行中/);
        assert.match(summary(renderer), /HIGH.*影响 7/);
        assert.deepEqual(renderer.root.findByProps({ className: "gitnexus-tool-warning" }).children, ["⚠"]);
    } finally { act(() => renderer.unmount()); }
});

test("error badge and original error replace stale success evidence", () => {
    const output = "index unavailable";
    const renderer = render(result(output, { isError: true }));
    try {
        assert.equal(row(renderer).props["data-state"], "error");
        assert.match(summary(renderer), /执行失败/);
        assert.deepEqual(renderer.root.findByProps({ className: "gitnexus-tool-warning" }).children, ["失败"]);
        act(() => head(renderer).props.onClick());
        assert.equal(renderer.root.findAllByProps({ className: "gitnexus-tool-text" })[1].children.join(""), output);
    } finally { act(() => renderer.unmount()); }
});

test("null-call replay and null JSON arguments render without metadata", () => {
    for (const call of [null, { argsRaw: "null" }]) {
        const renderer = render(result(JSON.stringify({ risk: "UNKNOWN", impactedCount: null }), { call }));
        try {
            assert.equal(row(renderer).props["data-state"], "settled");
            assert.match(summary(renderer), /UNKNOWN/);
            act(() => head(renderer).props.onClick());
            assert.equal(renderer.root.findAllByProps({ className: "gitnexus-tool-text" })[0].children.join(""), call ? "null" : "（调用参数不在当前记录中）");
        } finally { act(() => renderer.unmount()); }
    }
});
