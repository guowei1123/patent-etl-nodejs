export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Next.js uses this conditional require to exclude Node modules from the Edge bundle.
    return require('./instrumentation.node').registerNode()
  }
}
