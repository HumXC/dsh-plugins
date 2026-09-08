import assert from "node:assert/strict";
import test from "node:test";
import { gitNexusSummary } from "../lib/tool-summary.js";

const summarize = (name, data, args = {}) => gitNexusSummary(name, args, JSON.stringify(data), false, true);

test("native and raw names have individual Chinese titles and running targets", () => {
    const titles = { list_repos: "仓库列表", query: "搜索代码图谱", context: "符号上下文", impact: "影响分析", detect_changes: "变更检查", rename: "重命名预览", cypher: "查询图谱", api_impact: "API影响分析" };
    for (const [name, title] of Object.entries(titles)) {
        for (const tool of [name, "gitnexus_" + name]) {
            const result = gitNexusSummary(tool, { target: "run" }, "", false, false);
            assert.equal(result.title, title);
            assert.equal(result.summary, "run · 执行中");
            assert.equal(result.warning, false);
        }
    }
    assert.equal(summarize("rename", {}, { dry_run: false }).title, "重命名");
});

test("repository page length is not the registry total", () => {
    const page = { repositories: [{ name: "a" }, { name: "b" }], pagination: { total: 52, returned: 2, offset: 50, hasMore: false } };
    assert.equal(summarize("list_repos", page).summary, "本页 2 个仓库，共 52 个");
    assert.match(summarize("list_repos", { ...page, pagination: { total: 52, hasMore: true } }).summary, /还有下一页/);
    assert.equal(summarize("list_repos", { repositories: [] }).summary, "本页 0 个仓库");
});

test("impact preserves evidenced counts, high risk and epistemic warnings", () => {
    for (const risk of ["UNKNOWN", "HIGH", "CRITICAL"]) {
        const result = summarize("impact", { risk, impactedCount: 0, epistemic: "lower-bound", partial: true, truncated: true }, { target: "run" });
        assert.match(result.summary, /run/);
        assert.match(result.summary, new RegExp(risk));
        assert.match(result.summary, /影响 0 个符号/);
        for (const warning of ["partial", "truncated", "lower-bound"]) assert.ok(result.summary.includes(warning));
        assert.equal(result.warning, true);
    }
    const missing = summarize("impact", { impactedCount: null });
    assert.equal(missing.warning, true);
    assert.doesNotMatch(missing.summary, /LOW|影响 0/);
    assert.equal(summarize("impact", { risk: "LOW", impactedCount: 3 }).warning, false);
});

test("change counts come from summary, not capped symbol arrays", () => {
    const result = summarize("detect_changes", { summary: { changed_count: 1200, affected_count: 7, risk_level: "unknown" }, changed_symbols: [], partial: true, truncated: true });
    assert.match(result.summary, /变更 1200 个符号/);
    assert.match(result.summary, /影响 7 个流程/);
    assert.match(result.summary, /UNKNOWN/);
    assert.match(result.summary, /partial/);
    assert.match(result.summary, /truncated/);
    assert.equal(result.warning, true);
});

test("JSON with MCP guidance and canonical/content envelopes stays read-only", () => {
    const data = { risk: "UNKNOWN", impactedCount: 2, epistemic: "lower-bound" };
    const text = JSON.stringify(data) + "\n\n---\nInspect callers before editing.";
    const args = Object.freeze({ target: "run" });
    for (const output of [text, JSON.stringify({ text, data }), JSON.stringify({ content: [{ type: "text", text }] })]) {
        const original = output;
        const result = gitNexusSummary("impact", args, output, false, true);
        assert.match(result.summary, /影响 2 个符号/);
        assert.match(result.summary, /lower-bound/);
        assert.equal(result.warning, true);
        assert.equal(output, original);
    }
});

test("failed and embedded-error outputs cannot show stale success", () => {
    const output = JSON.stringify({ repositories: [{ name: "old" }], pagination: { total: 1 } });
    const failed = gitNexusSummary("list_repos", {}, output, true, true);
    assert.match(failed.summary, /执行失败/);
    assert.doesNotMatch(failed.summary, /仓库|共 1/);
    assert.equal(failed.warning, true);
    for (const data of [{ error: "index unavailable" }, { isError: true, content: [{ type: "text", text: output }] }]) {
        assert.match(summarize("list_repos", data).summary, /执行失败/);
    }
});

test("malformed, partial and invalid counts never fabricate success", () => {
    for (const output of ["", "{", '{"impactedCount": 42', "null", '"text"', "not JSON"]) {
        const result = gitNexusSummary("impact", undefined, output, false, true);
        assert.equal(result.warning, true);
        assert.match(result.summary, /无法解析/);
        assert.doesNotMatch(result.summary, /影响 \d|LOW/);
    }
    for (const impactedCount of [-1, 1.5, "3", null]) {
        assert.doesNotMatch(summarize("impact", { risk: "LOW", impactedCount }).summary, /影响/);
    }
    assert.equal(summarize("context", { partial: false, truncated: false, epistemic: "exact" }).warning, false);
});

test("settled results without counts have no filler or dangling separator", () => {
    assert.equal(summarize("context", { status: "found" }, { name: "run" }).summary, "run");
    assert.equal(summarize("query", { processes: [] }).summary, "");
    assert.equal(summarize("cypher", { rows: [] }, { statement: "MATCH (n) RETURN n" }).summary, "MATCH (n) RETURN n");
});
