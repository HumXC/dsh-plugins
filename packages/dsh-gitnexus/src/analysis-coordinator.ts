import { canonicalWorkspacePath } from "./repository.js";

export type AnalysisStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkspaceAnalysisState {
  root: string;
  status: AnalysisStatus;
  jobId?: string;
  phase?: string;
  progress?: number;
  message?: string;
  error?: string | undefined;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BeginAnalysisResult {
  started: boolean;
  state: WorkspaceAnalysisState;
}

type AnalysisListener = (
  state: Readonly<WorkspaceAnalysisState>,
) => void;

type AnalysisProgress = Pick<
  WorkspaceAnalysisState,
  "phase" | "progress" | "message"
>;

const activeStatuses = new Set<AnalysisStatus>(["starting", "running"]);

function snapshot(state: WorkspaceAnalysisState): WorkspaceAnalysisState {
  return { ...state };
}

export class AnalysisCoordinator {
  private readonly states = new Map<string, WorkspaceAnalysisState>();
  private readonly listeners = new Set<AnalysisListener>();

  begin(root: string, now = Date.now()): BeginAnalysisResult {
    const key = canonicalWorkspacePath(root);
    const current = this.states.get(key);
    if (current !== undefined && activeStatuses.has(current.status)) {
      return { started: false, state: snapshot(current) };
    }

    const state: WorkspaceAnalysisState = {
      root: key,
      status: "starting",
      startedAt: now,
      updatedAt: now,
    };
    this.states.set(key, state);
    this.emit(state);
    return { started: true, state: snapshot(state) };
  }

  bindJob(root: string, jobId: string, now = Date.now()): void {
    const state = this.requireActive(root);
    state.status = "running";
    state.jobId = jobId;
    state.updatedAt = now;
    this.emit(state);
  }

  update(
    root: string,
    progress: Partial<AnalysisProgress>,
    now = Date.now(),
  ): void {
    const state = this.requireActive(root);
    if (progress.phase !== undefined) state.phase = progress.phase;
    if (progress.progress !== undefined) state.progress = progress.progress;
    if (progress.message !== undefined) state.message = progress.message;
    state.updatedAt = now;
    this.emit(state);
  }

  finish(
    root: string,
    status: Extract<AnalysisStatus, "completed" | "failed" | "cancelled">,
    error?: string,
    now = Date.now(),
  ): void {
    const key = canonicalWorkspacePath(root);
    const current = this.states.get(key);
    if (current === undefined || !activeStatuses.has(current.status)) return;
    current.status = status;
    current.error = error;
    current.updatedAt = now;
    current.completedAt = now;
    this.emit(current);
  }

  state(root: string): WorkspaceAnalysisState | undefined {
    const current = this.states.get(canonicalWorkspacePath(root));
    return current === undefined ? undefined : snapshot(current);
  }

  isRebuilding(root: string): boolean {
    const current = this.states.get(canonicalWorkspacePath(root));
    return current !== undefined && activeStatuses.has(current.status);
  }

  clear(root: string): void {
    this.states.delete(canonicalWorkspacePath(root));
  }

  onChange(listener: AnalysisListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireActive(root: string): WorkspaceAnalysisState {
    const key = canonicalWorkspacePath(root);
    const state = this.states.get(key);
    if (state === undefined || !activeStatuses.has(state.status)) {
      throw new Error(`dsh-gitnexus: no active analysis for ${key}`);
    }
    return state;
  }

  private emit(state: WorkspaceAnalysisState): void {
    const value = snapshot(state);
    for (const listener of this.listeners) listener(value);
  }
}
