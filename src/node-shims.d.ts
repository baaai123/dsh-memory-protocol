/**
 * Minimal ambient typings for the Node.js builtins the bootstrap spawn path
 * uses. The package deliberately carries no @types/node dependency, so this
 * file declares only the exact surface `src/index.ts` touches. Declaration-
 * only: nothing here is emitted to lib/ or shipped at runtime.
 */

declare module 'node:child_process' {
  export interface SpawnOptions {
    detached?: boolean
    stdio?: string | Array<string | number | null | undefined>
    env?: Record<string, string | undefined>
    cwd?: string
  }
  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): unknown
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string
}

declare const process: {
  env: Record<string, string | undefined>
  execPath: string
}
