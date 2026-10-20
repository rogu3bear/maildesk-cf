/** Executed on esbuild's actual module graph, before artifacts can qualify. */
export function assertWorkerImportBoundary(inputs: string[], entrypoint: string): void {
  for (const raw of inputs) {
    const path = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (/^(?:scripts|tests|tools|var)\//.test(path) || path.startsWith("node:") ||
        /\/(?:scripts|host-tooling)\//.test(path) || path.endsWith("/legacy-reply-http.ts") ||
        (/^workers\/[^/]+\/src\/index\.ts$/.test(path) && path !== entrypoint)) {
      throw new Error(`forbidden runtime import in ${entrypoint}: ${path}`);
    }
  }
}
