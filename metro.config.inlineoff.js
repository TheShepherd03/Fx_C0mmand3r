// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Keep roots consistent with __dirname (important when the project is reached
// through a junction/symlink, e.g. the C:\tc short-path used for Windows builds).
config.projectRoot = __dirname;
config.watchFolders = Array.from(new Set([__dirname, ...(config.watchFolders || [])]));

// Disable Metro's production `inlineRequires` optimization. With React 19 +
// React Native 0.81 New Architecture, inlining `require()` calls reorders module
// initialization so the Fabric renderer captures React's ReactSharedInternals
// before the dispatcher is wired, leaving hooks' dispatcher (H) null in the
// production bundle -> "Cannot read property 'useSyncExternalStore' of null" on
// launch. Dev bundles don't inline, which is why it only crashed in release.
const _prevGetTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (entryPoints, options, getDeps) => {
  const base = _prevGetTransformOptions
    ? await _prevGetTransformOptions(entryPoints, options, getDeps)
    : {};
  return {
    ...base,
    transform: {
      ...(base.transform || {}),
      experimentalImportSupport: false,
      inlineRequires: false,
    },
  };
};

module.exports = config;
