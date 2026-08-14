/**
 * Protocol bridge: the DSH plugin protocol names its Cordis core
 * `@deepseek-ai/cordis` (an unpublished vendored fork of cordis 4.x).
 * Standalone plugin repositories type against the published upstream
 * `cordis` package, whose 4.0.0-rc API surface is identical — only the
 * package name differs. This ambient declaration lets the plugin
 * typecheck and unit tests resolve `@deepseek-ai/cordis` while the DSH
 * runtime resolves the real package from its own workspace.
 */
declare module '@deepseek-ai/cordis' {
  export * from 'cordis'
}
