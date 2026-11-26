import { describe, it, expect } from "vitest";
import {
  isSidebarToControllerMessage,
  isControllerToSidebarMessage,
} from "./port-protocol";

describe("port-protocol", () => {
  describe("isSidebarToControllerMessage", () => {
    it("returns true for valid sidebar messages", () => {
      expect(isSidebarToControllerMessage({ type: "init", tabId: 1 })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "sendMessage", text: "hi" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "abort" })).toBe(true);
      expect(isSidebarToControllerMessage({ type: "retry" })).toBe(true);
    });

    it("returns false for invalid values", () => {
      expect(isSidebarToControllerMessage(null)).toBe(false);
      expect(isSidebarToControllerMessage(undefined)).toBe(false);
      expect(isSidebarToControllerMessage(42)).toBe(false);
      expect(isSidebarToControllerMessage({})).toBe(false);
      expect(isSidebarToControllerMessage({ type: 123 })).toBe(false);
      expect(isSidebarToControllerMessage({ type: "unknownType" })).toBe(false);
    });
  });

  describe("isControllerToSidebarMessage", () => {
    it("returns true for valid controller messages", () => {
      expect(isControllerToSidebarMessage({ type: "contextLoaded", title: "T", url: "u" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "streamToken", token: "hi" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "streamEnd", fullContent: "done" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "streamStart" })).toBe(true);
      expect(isControllerToSidebarMessage({ type: "configError", reason: "not-configured" })).toBe(true);
    });

    it("returns false for invalid values", () => {
      expect(isControllerToSidebarMessage(null)).toBe(false);
      expect(isControllerToSidebarMessage(undefined)).toBe(false);
      expect(isControllerToSidebarMessage({})).toBe(false);
      expect(isControllerToSidebarMessage({ type: "init" })).toBe(false);
      expect(isControllerToSidebarMessage({ type: "unknownType" })).toBe(false);
    });
  });
});

describe("removed port messages (auto-export, personas, skills)", () => {
  it("no longer accepts auto-export or persona messages", () => {
    expect(isSidebarToControllerMessage({ type: "autoExportEnable", config: {} })).toBe(false);
    expect(isSidebarToControllerMessage({ type: "autoExportDisable", origin: "https://x.com" })).toBe(false);
    expect(isSidebarToControllerMessage({ type: "autoExportStatusRequest", tabId: 5 })).toBe(false);
    expect(isSidebarToControllerMessage({ type: "activatePersona", personaId: "p" })).toBe(false);
    expect(isControllerToSidebarMessage({ type: "autoExportStatus", status: null })).toBe(false);
    expect(isSidebarToControllerMessage({ type: "loadSkill", raw: "# Skill" })).toBe(false);
    expect(isSidebarToControllerMessage({ type: "clearSkill" })).toBe(false);
    expect(isControllerToSidebarMessage({ type: "skillLoaded", name: "Dave", description: "d", activation: null })).toBe(false);
    expect(isControllerToSidebarMessage({ type: "personaModeReady" })).toBe(false);
  });

  it("no longer accepts any skill-library message", () => {
    for (const msg of [{ type: "getLibrary" }, { type: "activateSkill", skillId: "s" }, { type: "deactivate" }]) {
      expect(isSidebarToControllerMessage(msg)).toBe(false);
    }
    for (const msg of [
      { type: "libraryState", library: { skills: [], active: { kind: "none" } } },
      { type: "activationChanged", active: { kind: "none" }, names: [] },
      { type: "skillError", errors: ["x"] },
      { type: "skillCleared" },
    ]) {
      expect(isControllerToSidebarMessage(msg)).toBe(false);
    }
  });

  it("accepts the renamed free-chat ready message", () => {
    expect(isControllerToSidebarMessage({ type: "freeChatReady" })).toBe(true);
  });
});
