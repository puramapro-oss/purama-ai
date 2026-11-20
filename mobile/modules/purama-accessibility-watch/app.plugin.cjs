const fs = require('node:fs');
const path = require('node:path');
const { withXcodeProject, withSettingsGradle, withDangerousMod } = require('expo/config-plugins');

const WATCH_TARGET = 'PuramaAccessibilityWatch';
const IOS_ID = 'dev.purama.purama-ai';
const ANDROID_ID = 'dev.purama.purama_ai';
const clean = value => String(value ?? '').replace(/^"|"$/g, '');

function addWatchTarget(project) {
  const objects = project.hash.project.objects;
  // node-xcode skips dependency insertion when an Expo template has no existing
  // dependency/proxy sections. Create those sections before adding our target.
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const existing = Object.entries(objects.PBXNativeTarget ?? {}).filter(([id, target]) => !id.endsWith('_comment') && clean(target.name) === WATCH_TARGET);
  if (existing.length > 1) throw new Error('Duplicate PURAMA watch targets');
  if (existing.length === 1) {
    const target = existing[0][1];
    const configurations = objects.XCConfigurationList[target.buildConfigurationList]?.buildConfigurations ?? [];
    if (!configurations.length || configurations.some(({ value }) => String(objects.XCBuildConfiguration[value]?.buildSettings?.PURAMA_WATCH_PROTOCOL) !== '1')) throw new Error('Existing watch target is not owned by this plugin');
    const phone = project.getFirstTarget();
    if (!phone.firstTarget.dependencies.some(dep => objects.PBXTargetDependency[dep.value]?.target === existing[0][0])) project.addTargetDependency(phone.uuid, [existing[0][0]]);
    return { id: existing[0][0], name: WATCH_TARGET };
  }
  const phone = project.getFirstTarget();
  if (!phone?.uuid) throw new Error('Missing existing PURAMA phone target');
  // A modern single-target SwiftUI watch app. addTarget also adds a dependency
  // from the existing iOS app; no separate phone application is created.
  const target = project.addTarget(WATCH_TARGET, 'application', WATCH_TARGET, IOS_ID + '.accessibility-watch');
  const group = project.addPbxGroup([], WATCH_TARGET, undefined, '"<group>"');
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  objects.PBXGroup[mainGroup].children.push({ value: group.uuid, comment: WATCH_TARGET });
  const sourcePhase = project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid).buildPhase;
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  for (const relative of ['../watch/watchos/PuramaAccessibilityWatchApp.swift', '../modules/purama-accessibility-watch/apple/WatchWire.swift']) {
    const ref = project.generateUuid(), build = project.generateUuid(), name = path.basename(relative);
    objects.PBXFileReference[ref] = { isa: 'PBXFileReference', lastKnownFileType: 'sourcecode.swift', name: JSON.stringify(name), path: JSON.stringify(relative), sourceTree: 'SOURCE_ROOT' };
    objects.PBXFileReference[ref + '_comment'] = name;
    objects.PBXBuildFile[build] = { isa: 'PBXBuildFile', fileRef: ref, fileRef_comment: name };
    objects.PBXBuildFile[build + '_comment'] = name + ' in Sources';
    sourcePhase.files.push({ value: build, comment: name + ' in Sources' });
    group.pbxGroup.children.push({ value: ref, comment: name });
  }
  const list = objects.XCConfigurationList[target.pbxNativeTarget.buildConfigurationList];
  for (const { value } of list.buildConfigurations) {
    Object.assign(objects.XCBuildConfiguration[value].buildSettings, {
      PURAMA_WATCH_PROTOCOL: '1', SDKROOT: 'watchos', SUPPORTED_PLATFORMS: '"watchos watchsimulator"',
      TARGETED_DEVICE_FAMILY: '4', WATCHOS_DEPLOYMENT_TARGET: '10.0', SWIFT_VERSION: '5.0',
      INFOPLIST_FILE: '"../watch/watchos/Info.plist"', GENERATE_INFOPLIST_FILE: 'NO',
      PRODUCT_BUNDLE_IDENTIFIER: JSON.stringify(IOS_ID + '.accessibility-watch'), PRODUCT_NAME: JSON.stringify(WATCH_TARGET),
      SKIP_INSTALL: 'YES', CODE_SIGN_STYLE: 'Automatic',
    });
  }
  const embed = project.addBuildPhase([], 'PBXCopyFilesBuildPhase', 'Embed PURAMA Watch Content', phone.uuid, 'watch2_app', '"$(CONTENTS_FOLDER_PATH)/Watch"').buildPhase;
  const copy = project.generateUuid();
  objects.PBXBuildFile[copy] = { isa: 'PBXBuildFile', fileRef: target.pbxNativeTarget.productReference, fileRef_comment: WATCH_TARGET + '.app', settings: { ATTRIBUTES: ['CodeSignOnCopy', 'RemoveHeadersOnCopy'] } };
  objects.PBXBuildFile[copy + '_comment'] = WATCH_TARGET + '.app in Embed PURAMA Watch Content';
  embed.files.push({ value: copy, comment: WATCH_TARGET + '.app in Embed PURAMA Watch Content' });
  return { id: target.uuid, name: WATCH_TARGET };
}
function addWearSettings(contents) {
  const start = '// PURAMA accessibility watch — begin';
  const end = '// PURAMA accessibility watch — end';
  const snippet = `${start}\ninclude ':puramaAccessibilityWatch'\nproject(':puramaAccessibilityWatch').projectDir = new File(rootProject.projectDir, '../watch/wear')\n${end}`;
  if (contents.includes(start) !== contents.includes(end)) throw new Error('Incomplete PURAMA Wear settings block');
  if (contents.includes(start)) return contents.slice(0, contents.indexOf(start)) + snippet + contents.slice(contents.indexOf(end) + end.length);
  if (contents.includes("':puramaAccessibilityWatch'")) throw new Error('Unowned Wear target already exists');
  return contents + '\n' + snippet + '\n';
}
module.exports = function withPuramaAccessibilityWatch(config) {
  if (config.ios?.bundleIdentifier !== IOS_ID || config.android?.package !== ANDROID_ID) throw new Error('Watch integration must retain the existing PURAMA phone identities');
  config = withSettingsGradle(config, mod => {
    if (mod.modResults.language !== 'groovy') throw new Error('Unsupported Android settings format');
    mod.modResults.contents = addWearSettings(mod.modResults.contents);
    return mod;
  });
  config = withXcodeProject(config, mod => { addWatchTarget(mod.modResults); return mod; });
  // Sources remain in mobile/watch and the local module. Prebuild may regenerate
  // ios/android without erasing source files or overwriting another conversation.
  config = withDangerousMod(config, ['ios', async mod => {
    for (const relative of ['watch/watchos/Info.plist', 'watch/watchos/PuramaAccessibilityWatchApp.swift', 'modules/purama-accessibility-watch/apple/WatchWire.swift']) {
      if (!fs.existsSync(path.join(mod.modRequest.projectRoot, relative))) throw new Error('Missing watch source: ' + relative);
    }
    return mod;
  }]);
  return config;
};
module.exports.addWatchTarget = addWatchTarget;
module.exports.addWearSettings = addWearSettings;
