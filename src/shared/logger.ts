/**
 * Debug logger (SF-8) — gated console output for understanding what the
 * extension is doing at runtime. Every factory takes an optional `logger`
 * (defaulting to `noopLogger`), so this is purely additive to existing code.
 */

import { LOG_PREFIX } from "./branding";

export interface Logger {
  readonly debug: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
  readonly error: (...args: unknown[]) => void;
}

export interface CreateLoggerOptions {
  readonly getEnabled: () => boolean;
  readonly console?: Pick<Console, "debug" | "warn" | "error">;
}

const PREFIX = LOG_PREFIX;

export function createLogger(opts: CreateLoggerOptions): Logger {
  const target = opts.console ?? console;
  const emit = (fn: (...args: unknown[]) => void, args: unknown[]): void => {
    if (opts.getEnabled()) fn(PREFIX, ...args);
  };
  return {
    debug: (...args) => emit(target.debug.bind(target), args),
    warn: (...args) => emit(target.warn.bind(target), args),
    error: (...args) => emit(target.error.bind(target), args),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};
