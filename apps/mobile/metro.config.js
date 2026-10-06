// The vitals desk's reading rules are ONE file shared with the web bay
// (packages/contracts/src/vitals-entry.ts). The app is not in the pnpm workspace, so Metro is told
// to watch that folder; the file is pure TypeScript with no imports, so nothing else is needed.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../../packages/contracts/src")];
// Babel's runtime helpers are resolved from the importing FILE's folder; the shared file sits
// outside this project, so the app's own node_modules is named as a place to look.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
module.exports = config;
