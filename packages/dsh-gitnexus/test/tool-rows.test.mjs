import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import React from "react";
import { loadToolRows, DisclosureRow, createDisclosureHarness, toolCallProps } from "./fixtures/client-primitives.mjs";
const GitNexusToolRow = (await loadToolRows()).get("gitnexus_impact");

const require = createRequire(import.meta.url);
const { act, create } = require("react-test-renderer");
const disclosure = createDisclosureHarness();
const props = { useDisclosure: disclosure.useDisclosure };
const argsRaw = JSON.stringify({ target: "run" });
const preparing = () => ({ phase: "preparing", callId: "nested-call", name: "gitnexus_impact", turn: 1, step: 1, time: 1, subCalls: [] });
const start = () => ({ ...preparing(), phase: "start", argsRaw });
const result = (text, extra = {}) => ({ kind: "tool-result", seq: 2, time: 2, callId: "nested-call", callTime: 1, call: { name: "gitnexus_impact", argsRaw }, content: [{ type: "text", text }], isError: false, subCalls: [], ...extra });
const head = renderer => renderer.root.findByProps({ className: "gitnexus-tool-head" });
const row = renderer => renderer.root.findByProps({ className: "gitnexus-tool-row" });
const summary = renderer => renderer.root.findByProps({ className: "gitnexus-tool-summary" }).children.join("");

function render(block, extra = {}) {
    let renderer;
    act(() => { renderer = create(React.createElement(GitNexusToolRow, toolCallProps(block, { ...props, ...extra }))); });
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
    const renderer = render(start());
    try {
        assert.equal(row(renderer).props["data-state"], "running");
        assert.match(summary(renderer), /run.*执行中/);
        act(() => head(renderer).props.onClick());
        const output = JSON.stringify({ risk: "HIGH", impactedCount: 7 });
        act(() => renderer.update(React.createElement(GitNexusToolRow, toolCallProps(result(output), props))));
        assert.equal(row(renderer).props["data-state"], "settled");
        assert.equal(head(renderer).props["aria-expanded"], true);
        assert.doesNotMatch(summary(renderer), /执行中/);
        assert.match(summary(renderer), /HIGH.*影响 7/);
        assert.equal(renderer.root.findAllByProps({ className: "gitnexus-tool-warning" }).length, 0);
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

test("preparing without call arguments transitions through start and result without remounting", () => {
    const renderer = render(preparing());
    try {
        assert.equal(row(renderer).props["data-state"], "preparing");
        assert.equal(summary(renderer), "准备中");
        act(() => head(renderer).props.onClick());
        assert.deepEqual(renderer.root.findAllByProps({ className: "gitnexus-tool-text" }).map(node => node.children.join("")), ["（准备调用参数）"]);
        act(() => renderer.update(React.createElement(GitNexusToolRow, toolCallProps(start(), props))));
        assert.equal(row(renderer).props["data-state"], "running");
        assert.match(summary(renderer), /run.*执行中/);
        assert.equal(head(renderer).props["aria-expanded"], true);
        assert.deepEqual(renderer.root.findAllByProps({ className: "gitnexus-tool-text" }).map(node => node.children.join("")), [argsRaw]);
        const output = JSON.stringify({ risk: "LOW", impactedCount: 2 });
        act(() => renderer.update(React.createElement(GitNexusToolRow, toolCallProps(result(output), props))));
        assert.equal(row(renderer).props["data-state"], "settled");
        assert.match(summary(renderer), /LOW.*影响 2/);
        assert.equal(head(renderer).props["aria-expanded"], true);
        assert.deepEqual(renderer.root.findAllByProps({ className: "gitnexus-tool-text" }).map(node => node.children.join("")), [argsRaw, output]);
    } finally { act(() => renderer.unmount()); }
});

test("enclosing Turn collapse resets every phase, and reopening does not restore expansion", () => {
    for (const block of [preparing(), start(), result("recorded result")]) {
        const turn = createDisclosureHarness();
        const rowProps = toolCallProps(block, { useDisclosure: turn.useDisclosure });
        const renderer = render(block, rowProps);
        try {
            act(() => head(renderer).props.onClick());
            assert.equal(head(renderer).props["aria-expanded"], true);
            act(() => renderer.update(React.createElement(GitNexusToolRow, { ...rowProps })));
            assert.equal(head(renderer).props["aria-expanded"], true, "ordinary rerenders preserve disclosure");
            act(() => turn.collapseTurn());
            assert.equal(head(renderer).props["aria-expanded"], false);
            assert.equal(renderer.root.findAllByProps({ className: "gitnexus-tool-text" }).length, 0);
            act(() => renderer.update(React.createElement(GitNexusToolRow, { ...rowProps })));
            assert.equal(head(renderer).props["aria-expanded"], false);
            act(() => head(renderer).props.onClick());
            assert.equal(head(renderer).props["aria-expanded"], true);
            act(() => turn.collapseTurn());
            assert.equal(head(renderer).props["aria-expanded"], false, "subsequent collapses also reset");
        } finally { act(() => renderer.unmount()); }
        assert.equal(turn.subscriberCount(), 0);
    }
});

test("rows sharing a Turn have independent disclosure state and a shared collapse reset", () => {
    const turn = createDisclosureHarness();
    let renderer;
    act(() => { renderer = create(React.createElement(React.Fragment, null,
        ...["first-call", "second-call"].map(callId => React.createElement(GitNexusToolRow, {
            key: callId, ...toolCallProps(result("result", { callId }), { useDisclosure: turn.useDisclosure }),
        })))); });
    try {
        const heads = () => renderer.root.findAllByProps({ className: "gitnexus-tool-head" });
        act(() => heads()[0].props.onClick());
        assert.deepEqual(heads().map(node => node.props["aria-expanded"]), [true, false]);
        act(() => heads()[1].props.onClick());
        assert.deepEqual(heads().map(node => node.props["aria-expanded"]), [true, true]);
        act(() => turn.collapseTurn());
        assert.deepEqual(heads().map(node => node.props["aria-expanded"]), [false, false]);
        act(() => heads()[1].props.onClick());
        assert.deepEqual(heads().map(node => node.props["aria-expanded"]), [false, true]);
    } finally { act(() => renderer.unmount()); }
    assert.equal(turn.subscriberCount(), 0);
});
