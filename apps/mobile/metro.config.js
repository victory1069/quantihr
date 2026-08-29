// Metro in an npm workspace: it must watch the repo root so changes in
// packages/shared trigger a rebuild, and resolve from both the app's and the
// root's node_modules since npm hoists most packages upward.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// Without this, two copies of react can be resolved through the workspace link.
config.resolver.disableHierarchicalLookup = true

/**
 * `@quanti/shared` is consumed as TypeScript source and imports with explicit
 * `.js` extensions, which is what Node's ESM resolver requires and what the API
 * depends on. Metro resolves relative paths literally, so `./domain/index.js`
 * fails against `index.ts`.
 *
 * Rather than stripping the extensions — which would break the API at runtime —
 * try the extensionless form first and fall back to the original. A real `.js`
 * file still resolves, because the extensionless attempt finds it too.
 */
/**
 * Version-skew shim between @expo/metro-config and react-native.
 *
 * Expo SDK 57 bundles react-native 0.86.x, whose package exposes a
 * `rn-get-polyfills` entry point. npm hoisted 0.87.1 here instead, and 0.87
 * removed that file — the polyfill list now lives in `@react-native/js-polyfills`,
 * which ships with react-native itself. `@expo/metro-config` still reaches for
 * the old path, so bundling dies before it emits a single module.
 *
 * `getPolyfills` is a config field we own, so overriding it here means the stale
 * lookup is never called. This reproduces the upstream behaviour exactly,
 * including returning nothing for a nullish platform.
 *
 * Remove this once @expo/metro-config targets react-native 0.87, or once
 * react-native is pinned to the SDK's bundled 0.86.x.
 */
const jsPolyfills = require('@react-native/js-polyfills')
config.serializer.getPolyfills = ({ platform }) => (platform ? jsPolyfills() : [])

const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest

  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform)
    } catch {
      // Fall through to the literal name below.
    }
  }

  return resolve(context, moduleName, platform)
}

module.exports = config
