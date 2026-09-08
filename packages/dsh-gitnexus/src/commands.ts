import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export interface NativeCommand {
    name: string
    title: string
    description: string
    parameters: ToolDefinition['parameters']
}

const repo = {
    type: 'string' as const,
    description: 'Indexed repository name or path. Omit to use the current workspace root.',
}

// Defaults are descriptive annotations, not runtime argument validation.
// Numeric bounds stay in descriptions because the DSH schema subset omits them.
// The executor maps query.query/content to search_query/include_content.
export const NATIVE_COMMANDS: readonly NativeCommand[] = [
    {
        name: 'list_repos',
        title: 'GitNexus List Repositories',
        description: 'List indexed repositories and index metadata. Follow pagination.nextOffset while pagination.hasMore is true; one page is not the entire registry.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'integer', description: 'Repositories per page: 1–200; default 50.', default: 50 },
                offset: { type: 'integer', description: 'Nonnegative number to skip; use pagination.nextOffset for the next page.', default: 0 },
            },
            required: [],
            additionalProperties: false,
        },
    },
    {
        name: 'query',
        title: 'GitNexus Search Execution Flows',
        description: 'Find execution flows and symbols by concept or keywords, then inspect a result with context. Results are ranked and bounded; no matches do not prove code is absent.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language concept or keywords to search.' },
                limit: { type: 'integer', description: 'Maximum processes: 1–100; default 5.', default: 5 },
                max_symbols: { type: 'integer', description: 'Maximum symbols per process: 1–200; default 10.', default: 10 },
                content: { type: 'boolean', description: 'Include symbol source code.', default: false },
                repo,
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'context',
        title: 'GitNexus Inspect Symbol',
        description: 'Inspect a symbol’s callers, callees and execution flows. Supply name or uid; use file_path to disambiguate. A lower-bound result omits references; inspect boundaries and verify source. Truncated candidates are not all matches.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Symbol name; required unless uid is supplied.' },
                uid: { type: 'string', description: 'Exact symbol UID from a previous result, avoiding name ambiguity.' },
                file_path: { type: 'string', description: 'Source file path to disambiguate the name.' },
                include_content: { type: 'boolean', description: 'Include symbol source code.', default: false },
                repo,
            },
            required: [],
            additionalProperties: false,
        },
    },
    {
        name: 'impact',
        title: 'GitNexus Analyze Impact',
        description: 'Trace upstream dependents or downstream dependencies before changing code. Supply target or target_uid. UNKNOWN is unresolved, not safe; lower-bound, partial or truncated results need source checks and further inspection. Review direct callers and warn before HIGH or CRITICAL changes.',
        parameters: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'Symbol or file name; required unless target_uid is supplied.' },
                target_uid: { type: 'string', description: 'Exact symbol UID from a previous result.' },
                file_path: { type: 'string', description: 'Source file path to disambiguate the target.' },
                direction: { type: 'string', enum: ['upstream', 'downstream'], description: 'upstream finds dependents; downstream finds dependencies.' },
                maxDepth: { type: 'integer', description: 'Relationship depth: 1–32; default 3.', default: 3 },
                includeTests: { type: 'boolean', description: 'Include test files in the traversal.', default: false },
                minConfidence: { type: 'number', description: 'Minimum edge confidence: 0–1; default 0.', default: 0 },
                limit: { type: 'integer', description: 'Symbols per depth level: 1–10000; default 100.', default: 100 },
                offset: { type: 'integer', description: 'Nonnegative number of symbols to skip per depth level.', default: 0 },
                summaryOnly: { type: 'boolean', description: 'Return risk and counts without the byDepth symbol listing.', default: false },
                repo,
            },
            required: ['direction'],
            additionalProperties: false,
        },
    },
    {
        name: 'detect_changes',
        title: 'GitNexus Analyze Changes',
        description: 'Map Git diff hunks to symbols and affected execution flows. A partial result has unknown risk; truncated listings and lower-bound counts are not a clean review. Inspect affected code and rerun incomplete analysis.',
        parameters: {
            type: 'object',
            properties: {
                scope: { type: 'string', enum: ['unstaged', 'staged', 'all', 'compare'], description: 'Diff selection.', default: 'unstaged' },
                base_ref: { type: 'string', description: 'Branch or commit to compare against for compare scope.' },
                worktree: { type: 'string', description: 'Absolute linked Git worktree path when the edited worktree differs from the server workspace.' },
                repo,
            },
            required: [],
            additionalProperties: false,
        },
    },
    {
        name: 'rename',
        title: 'GitNexus Rename Symbol',
        description: 'Preview a coordinated symbol rename using graph references and text matches. Supply symbol_name or symbol_uid. Review ambiguous or truncated candidates and lower-confidence text matches. dry_run defaults to true; false writes files and requires authorization. Analyze changes afterward.',
        parameters: {
            type: 'object',
            properties: {
                symbol_name: { type: 'string', description: 'Current symbol name; required unless symbol_uid is supplied.' },
                symbol_uid: { type: 'string', description: 'Exact symbol UID from a previous result.' },
                new_name: { type: 'string', description: 'Replacement symbol name.' },
                file_path: { type: 'string', description: 'Source file path to disambiguate the name.' },
                dry_run: { type: 'boolean', description: 'Preview only. Set false only when authorized to apply the rename.', default: true },
                repo,
            },
            required: ['new_name'],
            additionalProperties: false,
        },
    },
    {
        name: 'cypher',
        title: 'GitNexus Query Graph',
        description: 'Run a structural Cypher query against the index. Use CodeRelation edges with a type property (such as CALLS or IMPORTS), bind values with params, and bound results with LIMIT. Empty results are not proof of no runtime dependencies.',
        parameters: {
            type: 'object',
            properties: {
                statement: { type: 'string', description: 'Cypher statement to execute.' },
                params: { type: 'object', description: 'Named JSON values for statement placeholders such as $name.', additionalProperties: true },
                repo,
            },
            required: ['statement'],
            additionalProperties: false,
        },
    },
    {
        name: 'api_impact',
        title: 'GitNexus Analyze API Impact',
        description: 'Inspect route consumers, response-field usage, middleware and flows before editing a handler. Supply route or file; method narrows HTTP verbs. Multiple matches return a routes array. Low-confidence field mismatches are approximate; missing consumers do not prove safety.',
        parameters: {
            type: 'object',
            properties: {
                route: { type: 'string', description: 'Route path; required unless file is supplied.' },
                file: { type: 'string', description: 'Handler file path, as an alternative to route.' },
                method: { type: 'string', description: 'HTTP verb such as GET or POST; omit to inspect all matched methods.' },
                repo,
            },
            required: [],
            additionalProperties: false,
        },
    },
]
