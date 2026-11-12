const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const xcode = require('xcode');
const { addWatchTarget, addWearSettings } = require('../modules/purama-accessibility-watch/app.plugin.cjs');
const root = path.resolve(__dirname, '..');
const projectName = fs.readdirSync(path.join(root, 'ios')).find(name => name.endsWith('.xcodeproj'));
assert.ok(projectName, 'Existing phone Xcode project generated');
const project = xcode.project(path.join(root, 'ios', projectName, 'project.pbxproj')); project.parseSync();
const objects = project.hash.project.objects;
const targets = Object.entries(objects.PBXNativeTarget).filter(([id]) => !id.endsWith('_comment'));
const watch = targets.filter(([, value]) => value.name.replaceAll('"', '') === 'PuramaAccessibilityWatch');
assert.equal(watch.length, 1, 'One watch target');
const [watchId, target] = watch[0];
const config = objects.XCConfigurationList[target.buildConfigurationList].buildConfigurations;
for (const { value } of config) {
  const build = objects.XCBuildConfiguration[value].buildSettings;
  assert.equal(build.SDKROOT, 'watchos'); assert.equal(String(build.PURAMA_WATCH_PROTOCOL), '1');
  assert.equal(build.PRODUCT_BUNDLE_IDENTIFIER.replaceAll('"', ''), 'dev.purama.purama-ai.accessibility-watch');
}
const sourcePhase = target.buildPhases.map(p => objects.PBXSourcesBuildPhase?.[p.value]).find(Boolean);
const sources = sourcePhase.files.map(file => objects.PBXFileReference[objects.PBXBuildFile[file.value].fileRef].path.replaceAll('"', ''));
assert.equal(sources.length, 2); for (const source of sources) assert.ok(fs.existsSync(path.resolve(root, 'ios', source)), source);
const phone = project.getFirstTarget(); assert.notEqual(phone.uuid, watchId);
assert.ok(phone.firstTarget.dependencies.some(dep => objects.PBXTargetDependency[dep.value].target === watchId), 'Existing phone depends on watch');
const copy = phone.firstTarget.buildPhases.map(p => objects.PBXCopyFilesBuildPhase?.[p.value]).find(p => p?.name?.includes('Embed PURAMA Watch'));
assert.ok(copy?.files.some(file => objects.PBXBuildFile[file.value].fileRef === target.productReference), 'Watch embedded in phone');
const before = project.writeSync(); addWatchTarget(project); assert.equal(project.writeSync(), before, 'iOS plugin is idempotent');
const settings = fs.readFileSync(path.join(root, 'android/settings.gradle'), 'utf8'); assert.equal(addWearSettings(settings), settings, 'Wear plugin is idempotent');
const inputs = ['app.json', 'package.json', 'package-lock.json', 'modules/purama-accessibility-watch/app.plugin.cjs',
  'modules/purama-accessibility-watch/expo-module.config.json', 'modules/purama-accessibility-watch/apple/WatchWire.swift',
  'modules/purama-accessibility-watch/apple/PuramaAccessibilityWatchModule.swift', 'modules/purama-accessibility-watch/apple/PuramaAccessibilityWatch.podspec',
  'modules/purama-accessibility-watch/android/build.gradle', 'modules/purama-accessibility-watch/android/src/main/java/expo/modules/puramaaccessibilitywatch/WatchWire.kt',
  'modules/purama-accessibility-watch/android/src/main/java/expo/modules/puramaaccessibilitywatch/PuramaAccessibilityWatchModule.kt',
  'watch/watchos/PuramaAccessibilityWatchApp.swift', 'watch/watchos/Info.plist', 'watch/wear/build.gradle', 'watch/wear/src/main/AndroidManifest.xml',
  'watch/wear/src/main/java/dev/purama/accessibilitywatch/WatchActivity.kt', 'watch/wear/src/main/res/values/wear.xml'];
const sourceSha256 = Object.fromEntries(inputs.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
const result = { status: 'PASS', scope: 'Generated native projects, not compiled binaries', generatedAt: new Date().toISOString(),
  phoneTarget: phone.firstTarget.name, watchTarget: target.name, sources, androidWearTarget: ':puramaAccessibilityWatch', sourceSha256 };
fs.mkdirSync(path.join(root, 'qa/watch-native'), { recursive: true });
fs.writeFileSync(path.join(root, 'qa/watch-native/prebuild.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
