import type { ComponentType, ReactNode } from "react";
export const BRIDGE_KEY = "__DSH_OPENPENCIL_WORKSPACE_V1__";
export const VIEW_ID = "openpencil";
export const OPEN_ENDPOINT = "/_dsh/openpencil-workspace/open";
export type Grant = Record<string, unknown> & { sourcePath?: string; draftId?: string; liveDraft?: boolean };
export interface EditorRequest { grant: Grant; sessionId: string; automatic?: boolean }
export interface Lifecycle { phase: string; dirty: boolean }
export interface LifecycleController {
  requestClose(): Promise<boolean>;
  awaitExistingSave(): Promise<boolean>;
  captureRecovery(): Promise<boolean>;
  retainServerSessionOnUnmount(): void;
}
export interface EditorProps {
  grant: Grant; sessionId: string; colorScheme: string; locale: string;
  allowTakeover: boolean; onLifecycleState(state: Lifecycle): void;
  onLifecycleController(controller: LifecycleController | undefined): void;
  workbenchActions?: ReactNode;
  hideToolbar?: boolean;
}
export interface Runtime {
  Editor: ComponentType<EditorProps>;
  options: { subscribeTheme(fn: () => void): () => void; getColorScheme(): string; subscribeLocale(fn: () => void): () => void; getLocale(): string };
  key(grant: Grant, sessionId: string): string;
  locale(value: string): string;
  successor(current: EditorRequest, next: EditorRequest): boolean;
  preserve(state: Lifecycle, controller: LifecycleController): Promise<string>;
}
export interface WorkspaceHandler {
  open(request: EditorRequest, automatic: boolean): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface Bridge { version: 1; runtime?: Runtime; handler?: WorkspaceHandler }
export function getBridge(): Bridge {
  const target = globalThis as typeof globalThis & { [BRIDGE_KEY]?: Bridge };
  return target[BRIDGE_KEY] ??= { version: 1 };
}
export function isOpPath(path: string): boolean {
  return path.length > 0 && !path.includes("\0") && !/^[a-z][a-z0-9+.-]*:/i.test(path) && path.toLowerCase().endsWith(".op");
}
