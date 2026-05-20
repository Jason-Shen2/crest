import { defineConfig } from "vitest/config";
import path from "path";

// Slim vitest config — bypasses the shared electron.vite.config (which
// pulls in @tailwindcss/vite and currently fails to load due to an
// oxc-resolver version mismatch in this dev environment).  Used for
// ad-hoc runs of pure-logic tests (resolver, engine, parser) that
// don't need the renderer config.  NOT for component tests that
// require Tailwind.
//
// Usage: `npx vitest run --config vitest.slim.config.ts <path>`.

export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "frontend"),
        },
    },
    test: {
        include: ["frontend/**/*.test.ts"],
        environment: "node",
    },
});
