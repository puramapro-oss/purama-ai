const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
// The native replica and the server use one portable SMARANA wire contract.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../shared")];

module.exports = withNativeWind(config, { input: "./global.css" });
