import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The Hardhat FHE mock imports the relayer SDK's Node build, which reads WASM with `fs`.
// In the browser the same symbols come from the SDK's web build instead.
const relayerWeb = fileURLToPath(new URL("./node_modules/@zama-fhe/relayer-sdk/lib/web.js", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@zama-fhe\/relayer-sdk\/node$/, replacement: relayerWeb }],
  },
  optimizeDeps: {
    // Pre-bundling would move the SDK away from its WASM files and break their relative URLs.
    exclude: ["@zama-fhe/relayer-sdk", "@fhevm/mock-utils"],
  },
  build: {
    target: "es2022",
  },
});
