const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// onnxruntime-react-native is a native module — Metro resolves it normally.
// In Expo Go the native binding is absent and the module throws at runtime;
// that error is caught inside ONNXInference.loadModels.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
