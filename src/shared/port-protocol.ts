/**
 * Port protocol types for the long-lived connection between sidebar and background.
 *
 * The sidebar connects to the background via browser.runtime.connect("chat")
 * and exchanges typed messages for streaming updates, session management,
 * and context-tab management.
 */

// ─── Sidebar → Controller Messages ──────────────────────────────────────────

export type SidebarToControllerMessage =
  | { readonly type: "init"; readonly tabId: number; readonly url?: string }
  | { readonly type: "summarize" }
  | { readonly type: "sendMessage"; readonly text: string }
  | { readonly type: "abort" }
  | { readonly type: "retry" }
  | { readonly type: "addContextTab"; readonly tabId: number }
  | { readonly type: "removeContextTab"; readonly tabId: number }
  | { readonly type: "getOpenTabs" };

// ─── Controller → Sidebar Messages ──────────────────────────────────────────

export type ControllerToSidebarMessage =
  | { readonly type: "contextLoaded"; readonly title: string; readonly url: string; readonly confidence: "high" | "medium" | "low"; readonly hasSavedPattern: boolean; readonly wordCount: number }
  | { readonly type: "contextError"; readonly reason: string; readonly canRetry: boolean }
  | { readonly type: "conversationRestored"; readonly messages: ReadonlyArray<PortConversationMessage> }
  | { readonly type: "streamStart"; readonly historyTruncated?: boolean; readonly contextTruncated?: boolean }
  | { readonly type: "streamToken"; readonly token: string }
  | { readonly type: "streamEnd"; readonly fullContent: string; readonly model?: string }
  | { readonly type: "streamError"; readonly reason: string; readonly partialContent: string; readonly canRetry: boolean }
  | { readonly type: "configError"; readonly reason: string }
  | { readonly type: "freeChatReady"; readonly messages?: ReadonlyArray<PortConversationMessage> }
  | { readonly type: "contextTabAdded"; readonly tabId: number; readonly url: string; readonly title: string; readonly confidence: "high" | "medium" | "low" | null }
  | { readonly type: "contextTabFailed"; readonly tabId: number; readonly url: string; readonly title: string; readonly reason: string }
  | { readonly type: "contextTabRemoved"; readonly tabId: number }
  | { readonly type: "openTabs"; readonly tabs: ReadonlyArray<{ readonly tabId: number; readonly title: string; readonly url: string }> };

// ─── Supporting Types ────────────────────────────────────────────────────────

export interface PortConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly isPartial?: boolean;
  // The AI model that produced this message (assistant messages only) — CF-2.8.
  readonly model?: string;
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

/**
 * Validates that a value is a valid SidebarToControllerMessage.
 */
export function isSidebarToControllerMessage(value: unknown): value is SidebarToControllerMessage {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    return false;
  }
  const validTypes: ReadonlyArray<string> = [
    "init",
    "summarize",
    "sendMessage",
    "abort",
    "retry",
    "addContextTab",
    "removeContextTab",
    "getOpenTabs",
  ];
  return validTypes.includes(obj.type);
}

/**
 * Validates that a value is a valid ControllerToSidebarMessage.
 */
export function isControllerToSidebarMessage(value: unknown): value is ControllerToSidebarMessage {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    return false;
  }
  const validTypes: ReadonlyArray<string> = [
    "contextLoaded",
    "contextError",
    "conversationRestored",
    "streamStart",
    "streamToken",
    "streamEnd",
    "streamError",
    "configError",
    "freeChatReady",
    "contextTabAdded",
    "contextTabFailed",
    "contextTabRemoved",
    "openTabs",
  ];
  return validTypes.includes(obj.type);
}
