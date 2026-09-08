type Summary = { title: string; summary: string; warning: boolean };
type RecordValue = Record<string, unknown>;

const titles: Record<string, string> = {
    list_repos: "仓库列表",
    query: "搜索代码图谱",
    context: "符号上下文",
    impact: "影响分析",
    detect_changes: "变更检查",
    rename: "重命名预览",
    cypher: "查询图谱",
    api_impact: "API影响分析",
};

function record(value: unknown): RecordValue {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as RecordValue : {};
}

function short(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 100) : "";
}

function count(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Only accept complete JSON, optionally followed by the MCP guidance separator.
function parse(text: string): unknown {
    const candidates = [text.trim(), (text.split(/\r?\n---(?:\r?\n|$)/, 1)[0] ?? "").trim()];
    for (const candidate of candidates) {
        try { return JSON.parse(candidate); } catch { /* Streaming or non-JSON output. */ }
    }
    return undefined;
}

function unpack(value: unknown, depth = 0): unknown {
    if (depth > 8) return undefined;
    if (typeof value === "string") return unpack(parse(value), depth + 1);
    const item = record(value);
    if (item.data !== undefined) return unpack(item.data, depth + 1);
    if (item.structuredContent !== undefined) return unpack(item.structuredContent, depth + 1);
    if (Array.isArray(item.content)) {
        for (const block of item.content) {
            const result = unpack(record(block).text, depth + 1);
            if (result !== undefined) return result;
        }
    }
    if (typeof item.text === "string") return unpack(item.text, depth + 1);
    return value;
}

/** Derive presentation only; never rewrite or replace the caller's raw evidence. */
export function gitNexusSummary(
    toolName: string,
    args: unknown,
    output: string,
    failed: boolean,
    settled: boolean,
): Summary {
    const name = toolName.replace(/^gitnexus_/, "");
    const input = record(args);
    const title = name === "rename" && input.dry_run === false ? "重命名" : titles[name] ?? toolName;
    const target = short(input.target ?? input.target_uid ?? input.name ?? input.uid
        ?? input.symbol_name ?? input.symbol_uid ?? input.query ?? input.search_query
        ?? input.route ?? input.file ?? input.statement ?? input.repo);
    const prefix = target ? target + " · " : "";
    if (failed) return { title, summary: prefix + "执行失败，请查看原文", warning: true };
    if (!settled) return { title, summary: prefix + "执行中", warning: false };

    const parsed = parse(output);
    const value = unpack(parsed);
    const data = record(value);
    const notes = new Set<string>();
    let error = false;
    // Inspect nested completeness metadata, including canonical/MCP text envelopes.
    function inspect(item: unknown, depth = 0): void {
        if (depth > 16) { notes.add("结果层级过深，完整性未确认"); return; }
        if (Array.isArray(item)) { for (const child of item) inspect(child, depth + 1); return; }
        for (const [key, child] of Object.entries(record(item))) {
            if ((key === "isError" && child === true) || (key === "error" && Boolean(child))) error = true;
            if (key === "partial" && child === true) notes.add("partial：结果不完整");
            if (key === "truncated" && child === true) notes.add("truncated：结果已截断");
            if ((key === "epistemic" || key === "riskEpistemic") && child === "lower-bound") notes.add("lower-bound：仅为下界");
            if ((key === "risk" || key === "risk_level") && typeof child === "string") {
                const risk = child.toUpperCase();
                if (risk === "UNKNOWN") notes.add("UNKNOWN：风险未确定");
                if (risk === "HIGH" || risk === "CRITICAL") notes.add("风险 " + risk);
            }
            if (key === "text" && typeof child === "string") {
                texts.push(child);
                inspect(parse(child), depth + 1);
            }
            else if (child && typeof child === "object") inspect(child, depth + 1);
        }
    }
    const texts = [output];
    inspect(parsed);
    // Warnings can also occur in guidance appended after the structured payload.
    const prose = texts.map(text => text.split(/\r?\n---(?:\r?\n|$)/).slice(1).join(" ")
        || (parse(text) === undefined ? text : "")).join(" ");
    if (/\bUNKNOWN\b/.test(prose)) notes.add("UNKNOWN：风险未确定");
    if (/\bpartial\s*[:=]\s*true\b/i.test(prose)) notes.add("partial：结果不完整");
    if (/\btruncated\s*[:=]\s*true\b/i.test(prose)) notes.add("truncated：结果已截断");
    if (/\blower[- ]bound\b/i.test(prose)) notes.add("lower-bound：仅为下界");
    if (error || /^\s*(?:error|failed|执行失败|错误)\b/i.test(output)) {
        return { title, summary: prefix + "执行失败，请查看原文", warning: true };
    }
    const parts: string[] = [];
    if (name === "list_repos" && Array.isArray(data.repositories)) {
        const page = record(data.pagination);
        parts.push("本页 " + data.repositories.length + " 个仓库" + (count(page.total) ? "，共 " + page.total + " 个" : ""));
        if (page.hasMore === true) parts.push("还有下一页");
    } else if (name === "impact") {
        const risk = short(data.risk).toUpperCase();
        parts.push(risk ? "风险 " + risk : "风险未提供");
        if (!risk) notes.add("风险未评估");
        if (count(data.impactedCount)) parts.push("影响 " + data.impactedCount + " 个符号");
    } else if (name === "detect_changes") {
        const summary = record(data.summary);
        if (count(summary.changed_count)) parts.push("变更 " + summary.changed_count + " 个符号");
        if (count(summary.affected_count)) parts.push("影响 " + summary.affected_count + " 个流程");
        const risk = short(summary.risk_level).toUpperCase();
        if (risk) parts.push("风险 " + risk);
    } else if (name === "rename" && short(input.new_name)) {
        parts.push("→ " + short(input.new_name));
    }
    if (value === undefined || value === null || typeof value !== "object") {
        parts.length = 0;
        notes.add("无法解析结果，请查看原文");
    }
    return { title, summary: [target, ...new Set([...parts, ...notes])].filter(Boolean).join(" · "), warning: notes.size > 0 };
}
