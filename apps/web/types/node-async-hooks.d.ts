// The one Node API functions/_middleware.ts uses, which the Workers runtime
// provides under the nodejs_compat flag (wrangler.toml). Declared here for
// tsconfig.functions.json, rather than pulling @types/node's Node globals into
// Workers code. Not under functions/: every file there becomes a route.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
