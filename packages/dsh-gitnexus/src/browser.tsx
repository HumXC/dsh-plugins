import type { Context } from "@deepseek-ai/cordis";
export type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
export type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerGitNexusToolRows, GITNEXUS_TOOL_CSS } from "./tool-rows.js";
import { workspaceDisplayName, workspaceDisplayMessage } from "./workspace-display.js";

interface WorkspaceStatus {
  state: "unindexed" | "analyzing" | "ready" | "stale" | "failed" | "cancelled" | "unavailable";
  workspace: {
    name: string;
    path: string;
  };
  gateway: string;
  repo?: {
    name: string;
    indexedAt?: string;
    lastCommit?: string;
  };
  analysis?: {
    status: string;
    jobId?: string;
    phase?: string;
    progress?: number;
    message?: string;
    error?: string;
  };
  reason?: string;
  canRebuild?: boolean;
}

const colors = {
  canvas: "var(--background, #0f1117)",
  panel: "var(--card, #171922)",
  text: "var(--foreground, #ececf1)",
  muted: "var(--muted-foreground, #9ca3af)",
  border: "var(--border, #303340)",
  accent: "var(--primary, #7c6ff0)",
  accentText: "var(--primary-foreground, #ffffff)",
  warning: "#d9a441",
  danger: "#df6464",
};

function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceStatus>;
  const validState =
    candidate.state === "unindexed" ||
    candidate.state === "analyzing" ||
    candidate.state === "ready" ||
    candidate.state === "stale" ||
    candidate.state === "failed" ||
    candidate.state === "cancelled" ||
    candidate.state === "unavailable";
  if (
    !validState ||
    !candidate.workspace ||
    typeof candidate.workspace.name !== "string" ||
    typeof candidate.workspace.path !== "string" ||
    typeof candidate.gateway !== "string" ||
    (candidate.reason !== undefined && typeof candidate.reason !== "string") ||
    (candidate.canRebuild !== undefined && typeof candidate.canRebuild !== "boolean")
  ) {
    return false;
  }
  return candidate.state !== "unavailable" ||
    (typeof candidate.reason === "string" && typeof candidate.canRebuild === "boolean");
}

function isCapability(value: unknown): value is { gateway: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "gateway" in value &&
    typeof value.gateway === "string" &&
    value.gateway.startsWith("/gitnexus/session/")
  );
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      return parsed.error;
    }
  } catch {
    // The HTTP status remains the useful fallback when a proxy returns non-JSON.
  }
  return text.trim() || `HTTP ${response.status}`;
}

const buttonStyle = (primary = false): React.CSSProperties => ({
  appearance: "none",
  border: `1px solid ${primary ? colors.accent : colors.border}`,
  borderRadius: 8,
  background: primary ? colors.accent : "transparent",
  color: primary ? colors.accentText : colors.text,
  padding: "8px 14px",
  font: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});

function StateCard(props: {
  title: string;
  description: string;
  path?: string;
  tone?: "normal" | "warning" | "danger";
  children?: React.ReactNode;
}): React.ReactElement {
  const toneColor =
    props.tone === "danger"
      ? colors.danger
      : props.tone === "warning"
        ? colors.warning
        : colors.accent;
  return (
    <div
      style={{
        width: "min(560px, calc(100% - 32px))",
        border: `1px solid ${colors.border}`,
        borderTop: `3px solid ${toneColor}`,
        borderRadius: 12,
        background: colors.panel,
        padding: 24,
        boxSizing: "border-box",
        boxShadow: "0 16px 44px rgb(0 0 0 / 18%)",
      }}
    >
      <h2 style={{ margin: 0, color: colors.text, fontSize: 18 }}>
        {props.title}
      </h2>
      <p style={{ margin: "10px 0 0", color: colors.muted, lineHeight: 1.55 }}>
        {workspaceDisplayMessage(props.description, props.path)}
      </p>
      {props.path ? (
        <code
          style={{
            display: "block",
            marginTop: 14,
            padding: "9px 11px",
            borderRadius: 7,
            background: "rgb(0 0 0 / 18%)",
            color: colors.text,
            fontSize: 12,
            overflowWrap: "anywhere",
          }}
        >
          {workspaceDisplayName(props.path)}
        </code>
      ) : null}
      {props.children ? (
        <div
          style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

function GitNexusView({ sessionId }: ConvViewProps): React.ReactElement {
  const [gateway, setGateway] = useState<string>();
  const [status, setStatus] = useState<WorkspaceStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showExistingGraph, setShowExistingGraph] = useState(false);
  const [confirmReanalysis, setConfirmReanalysis] = useState(false);
  const activeSessionId = useRef(sessionId);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const previousStatus = useRef<WorkspaceStatus>();
  activeSessionId.current = sessionId;

  useEffect(() => {
    const previous = previousStatus.current;
    if (
      previous?.state === "analyzing" &&
      (status?.state === "ready" || status?.state === "stale")
    ) {
      setPreviewGeneration((generation) => generation + 1);
    }
    previousStatus.current = status;
  }, [status]);

  const connect = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch("/gitnexus/session/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      if (!isCapability(value)) {
        throw new Error("GitNexus session response is invalid");
      }
      if (!signal?.aborted && activeSessionId.current === sessionId) {
        setGateway(value.gateway);
        setError(undefined);
      }
    },
    [sessionId],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!gateway) return;
      const response = await fetch(`${gateway}/dsh/status`, {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      if (!isWorkspaceStatus(value)) {
        throw new Error("GitNexus workspace status response is invalid");
      }
      if (!signal?.aborted && activeSessionId.current === sessionId) {
        setStatus(value);
        setError(undefined);
      }
    },
    [gateway, sessionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setGateway(undefined);
    setStatus(undefined);
    setError(undefined);
    void connect(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => controller.abort();
  }, [connect]);

  useEffect(() => {
    if (!gateway) return undefined;
    const controller = new AbortController();
    void refresh(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => controller.abort();
  }, [gateway, refresh]);

  useEffect(() => {
    if (status?.state !== "analyzing") return undefined;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      void refresh(controller.signal).catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    }, 1_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh, status?.state]);

  const analyze = useCallback(async () => {
    if (!gateway) return;
    setConfirmReanalysis(false);
    setError(undefined);
    setBusy(true);
    try {
      const response = await fetch(`${gateway}/dsh/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: Boolean(status?.repo) }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setShowExistingGraph(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [gateway, refresh, status?.repo]);

  const cancel = useCallback(async () => {
    const jobId = status?.analysis?.jobId;
    if (!gateway || !jobId) return;
    setBusy(true);
    try {
      const response = await fetch(
        `${gateway}/dsh/analysis/${encodeURIComponent(jobId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [gateway, refresh, status?.analysis?.jobId]);

  const graphUrl = useMemo(() => {
    if (!gateway || !status?.repo) return undefined;
    const backend = `${window.location.origin}${gateway}`;
    const query = new URLSearchParams({
      server: backend,
      project: status.repo.name,
    });
    return `${gateway}/?${query.toString()}`;
  }, [gateway, status?.repo]);

  const shellStyle: React.CSSProperties = {
    height: "100%",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: colors.canvas,
    color: colors.text,
  };

  if (!status && !error) {
    return (
      <div className="dsh-gitnexus-view"
        style={{
          ...shellStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div role="status" aria-live="polite" style={{ color: colors.muted }}>
          正在连接 GitNexus…
        </div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="dsh-gitnexus-view"
        style={{
          ...shellStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StateCard title="无法打开 GitNexus" description={error} tone="danger">
          <button
            type="button"
            style={buttonStyle(true)}
            onClick={() => {
              setError(undefined);
              void connect().catch((reason: unknown) => {
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              });
            }}
          >
            重试
          </button>
        </StateCard>
      </div>
    );
  }
  if (!status) return <div className="dsh-gitnexus-view" style={shellStyle} />;

  if (status.state === "unavailable") {
    return (
      <div
        className="dsh-gitnexus-view"
        style={{
          ...shellStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StateCard
          title="GitNexus 不可用"
          description={error ?? status.reason ?? "无法验证 GitNexus 数据库状态。"}
          path={status.workspace.path}
          tone="danger"
        >
          {status.canRebuild ? (
            <button
              type="button"
              style={buttonStyle(true)}
              disabled={busy}
              onClick={() => void analyze()}
            >
              {busy ? "正在启动…" : "重建索引"}
            </button>
          ) : (
            <button
              type="button"
              style={buttonStyle(false)}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void refresh()
                  .catch((reason: unknown) => {
                    setError(reason instanceof Error ? reason.message : String(reason));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "正在检查…" : "重试"}
            </button>
          )}
        </StateCard>
      </div>
    );
  }

  if (status.state === "unindexed") {
    return (
      <div className="dsh-gitnexus-view"
        style={{
          ...shellStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StateCard
          title="当前工作区尚未分析"
          description="建立 GitNexus 索引后即可浏览代码关系图。插件只会分析下面这个 DSH 工作区。"
          path={status.workspace.path}
        >
          <button
            type="button"
            style={buttonStyle(true)}
            disabled={busy}
            onClick={() => void analyze()}
          >
            {busy ? "正在启动…" : "分析当前工作区"}
          </button>
        </StateCard>
      </div>
    );
  }

  if (status.state === "analyzing") {
    const progress = status.analysis?.progress ?? 0;
    return (
      <div className="dsh-gitnexus-view"
        style={{
          ...shellStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StateCard
          title="正在分析当前工作区"
          description={
            status.analysis?.message ??
            "GitNexus 正在建立代码图谱。关闭页面不会中止任务。"
          }
          path={status.workspace.path}
        >
          <div style={{ width: "100%" }} aria-live="polite">
            <div
              role="progressbar"
              aria-label="GitNexus 分析进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              style={{
                height: 8,
                borderRadius: 999,
                overflow: "hidden",
                background: "rgb(255 255 255 / 10%)",
              }}
            >
              <div
                style={{
                  width: `${Math.max(2, Math.min(100, progress))}%`,
                  height: "100%",
                  background: colors.accent,
                  transition: "width 180ms ease",
                }}
              />
            </div>
            <div style={{ marginTop: 8, color: colors.muted, fontSize: 12 }}>
              {status.analysis?.phase ?? "starting"} · {progress}%
            </div>
          </div>
          {status.analysis?.jobId ? (
            <button
              type="button"
              style={buttonStyle(false)}
              disabled={busy}
              onClick={() => void cancel()}
            >
              取消分析
            </button>
          ) : null}
        </StateCard>
      </div>
    );
  }

  if (
    (status.state === "failed" || status.state === "cancelled") &&
    !(showExistingGraph && graphUrl) &&
    !confirmReanalysis
  ) {
    return (
      <div className="dsh-gitnexus-view"
        style={{
          ...shellStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StateCard
          title={
            status.state === "cancelled"
              ? "GitNexus 分析已取消"
              : "GitNexus 分析失败"
          }
          description={
            status.analysis?.error ??
            error ??
            (status.state === "cancelled"
              ? "当前工作区的索引未发生切换，可以重新开始分析。"
              : "分析未能完成，请重试。")
          }
          path={status.workspace.path}
          tone={status.state === "cancelled" ? "warning" : "danger"}
        >
          <button
            type="button"
            style={buttonStyle(true)}
            disabled={busy}
            onClick={() => {
              if (status.repo) setConfirmReanalysis(true);
              else void analyze();
            }}
          >
            {status.repo ? "重新分析当前工作区" : "分析当前工作区"}
          </button>
          {graphUrl ? (
            <button
              type="button"
              style={buttonStyle(false)}
              onClick={() => setShowExistingGraph(true)}
            >
              打开现有图谱
            </button>
          ) : null}
        </StateCard>
      </div>
    );
  }

  return (
    <div className="dsh-gitnexus-view" style={shellStyle}>
      {confirmReanalysis ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StateCard
            title="确认重新分析当前工作区"
            description="重新分析期间，当前工作区的 GitNexus 工具和自动图谱增强会暂停；其他工作区不受影响。"
            path={status.workspace.path}
            tone="warning"
          >
            <button
              type="button"
              style={buttonStyle(true)}
              disabled={busy}
              onClick={() => void analyze()}
            >
              {busy ? "正在启动…" : "确认重新分析"}
            </button>
            <button
              type="button"
              style={buttonStyle(false)}
              disabled={busy}
              onClick={() => setConfirmReanalysis(false)}
            >
              取消
            </button>
          </StateCard>
        </div>
      ) : graphUrl ? (
        <iframe
          key={previewGeneration}
          title={`GitNexus：${status.workspace.name}`}
          src={graphUrl}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          style={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            border: 0,
            background: colors.canvas,
          }}
        />
      ) : null}
    </div>
  );
}

const GITNEXUS_CSS_ID = "dsh-gitnexus/preview.css";
const GITNEXUS_CSS = `
.dsh-gitnexus-view {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
}
[data-conversation-scroll]:has(.dsh-gitnexus-view) > [data-composer-seat]:not(:has([data-approval-key], [data-question-key], [data-plan-review-key])) {
  display: none;
}
`;

export const inject = ["slots"];

type GitNexusClientContext = Pick<Context, "effect" | "slots">;

export function apply(ctx: GitNexusClientContext): void {
  registerGitNexusToolRows(ctx);
  ctx.effect(() => {
    // Delivered by the host's structured index-injection channel, not a probe.
    const config = (globalThis as typeof globalThis & {
      __DSH_GITNEXUS_CONFIG__?: { webUi: boolean };
    }).__DSH_GITNEXUS_CONFIG__;
    const disposeRegistration = config?.webUi === true
      ? ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            { name: "conversation.view", id: "gitnexus", label: "GitNexus", order: 20 },
            GitNexusView,
          ),
        )
      : undefined;

    let style: HTMLStyleElement | undefined;
    if (typeof document !== "undefined") {
      style = document.createElement("style");
      style.dataset.plugin = "dsh-gitnexus";
      style.dataset.pluginCss = GITNEXUS_CSS_ID;
      style.textContent = GITNEXUS_CSS + GITNEXUS_TOOL_CSS;
      document.head.appendChild(style);
    }
    return () => {
      disposeRegistration?.();
      style?.remove();
    };
  }, "dsh-gitnexus: register configured conversation view");
}
