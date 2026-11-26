import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    // Entry-point tests dynamically import large modules; under full-suite load the
    // first one can exceed the 5s default without anything being wrong.
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@shared": new URL("./src/shared", import.meta.url).pathname,
      "@background": new URL("./src/background", import.meta.url).pathname,
      "@content": new URL("./src/content", import.meta.url).pathname,
      "@sidebar": new URL("./src/sidebar", import.meta.url).pathname,
      "@options": new URL("./src/options", import.meta.url).pathname,
    },
  },
});
