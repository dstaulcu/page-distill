import { LOG_PREFIX } from "./branding";
import { describe, it, expect, vi } from "vitest";
import { createLogger, noopLogger } from "./logger";

function makeMockConsole() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("SF-8 createLogger", () => {
  it("does not call the underlying console when disabled", () => {
    const mockConsole = makeMockConsole();
    const logger = createLogger({ getEnabled: () => false, console: mockConsole });

    logger.debug("a");
    logger.warn("b");
    logger.error("c");

    expect(mockConsole.debug).not.toHaveBeenCalled();
    expect(mockConsole.warn).not.toHaveBeenCalled();
    expect(mockConsole.error).not.toHaveBeenCalled();
  });

  it("routes each level to the matching console method when enabled", () => {
    const mockConsole = makeMockConsole();
    const logger = createLogger({ getEnabled: () => true, console: mockConsole });

    logger.debug("a");
    logger.warn("b");
    logger.error("c");

    expect(mockConsole.debug).toHaveBeenCalledTimes(1);
    expect(mockConsole.warn).toHaveBeenCalledTimes(1);
    expect(mockConsole.error).toHaveBeenCalledTimes(1);
  });

  it("prefixes every call with the brand log prefix", () => {
    const mockConsole = makeMockConsole();
    const logger = createLogger({ getEnabled: () => true, console: mockConsole });

    logger.debug("hello", { extra: 1 });

    expect(mockConsole.debug).toHaveBeenCalledWith(LOG_PREFIX, "hello", { extra: 1 });
  });

  it("re-evaluates getEnabled on every call rather than caching it at creation", () => {
    const mockConsole = makeMockConsole();
    let enabled = false;
    const logger = createLogger({ getEnabled: () => enabled, console: mockConsole });

    logger.debug("first");
    expect(mockConsole.debug).not.toHaveBeenCalled();

    enabled = true;
    logger.debug("second");
    expect(mockConsole.debug).toHaveBeenCalledTimes(1);
    expect(mockConsole.debug).toHaveBeenCalledWith(LOG_PREFIX, "second");
  });

  it("defaults to the global console when none is injected", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const logger = createLogger({ getEnabled: () => true });
      logger.debug("via global console");
      expect(debugSpy).toHaveBeenCalledWith(LOG_PREFIX, "via global console");
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe("SF-8 noopLogger", () => {
  it("never throws and produces no console output regardless of arguments", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => {
        noopLogger.debug("x");
        noopLogger.warn("y");
        noopLogger.error("z");
      }).not.toThrow();
      expect(debugSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
