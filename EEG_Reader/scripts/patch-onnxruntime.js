/**
 * Patches onnxruntime-react-native/dist/.../binding.js to add a null guard
 * around Module.install() so it works in React Native new architecture where
 * NativeModules.Onnxruntime is null (TurboModules don't populate legacy bridge).
 *
 * Original code in binding.js:
 *   if (typeof globalThis.OrtApi === 'undefined') {
 *     Module.install();   ← crashes when Module is null
 *   }
 *
 * Patched code:
 *   if (typeof globalThis.OrtApi === 'undefined') {
 *     if (Module) { Module.install(); }
 *     else { try { require('react-native').TurboModuleRegistry.getEnforcing('Onnxruntime'); } catch(e){} }
 *   }
 *
 * This runs after every npm install via package.json "postinstall".
 */

const fs   = require('fs');
const path = require('path');

const files = [
  'node_modules/onnxruntime-react-native/dist/commonjs/binding.js',
  'node_modules/onnxruntime-react-native/dist/module/binding.js',
];

const ORIGINAL = `if (typeof globalThis.OrtApi === 'undefined') {\n  Module.install();\n}`;
const PATCHED  = `if (typeof globalThis.OrtApi === 'undefined') {\n  if (Module) {\n    Module.install();\n  } else {\n    try { require('react-native').TurboModuleRegistry.getEnforcing('Onnxruntime'); } catch(e) {}\n  }\n}`;

let anyPatched = false;

for (const rel of files) {
  const full = path.join(__dirname, '..', rel);
  if (!fs.existsSync(full)) {
    console.log(`[patch-onnxruntime] Not found, skipping: ${rel}`);
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');
  if (src.includes(PATCHED)) {
    console.log(`[patch-onnxruntime] Already patched: ${rel}`);
    continue;
  }
  if (!src.includes(ORIGINAL)) {
    console.log(`[patch-onnxruntime] Pattern not found (different version?): ${rel}`);
    continue;
  }
  fs.writeFileSync(full, src.replace(ORIGINAL, PATCHED), 'utf8');
  console.log(`[patch-onnxruntime] Patched: ${rel}`);
  anyPatched = true;
}

if (anyPatched) {
  console.log('[patch-onnxruntime] Done.');
}
