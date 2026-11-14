const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const xcode = require('xcode');
const root = path.resolve(__dirname, '..');
const entries = fs.readdirSync(path.join(root, 'ios'));
const projectName = entries.find(name => name.endsWith('.xcodeproj'));
const workspaceName = entries.find(name => name.endsWith('.xcworkspace'));
if (!projectName || !workspaceName) throw new Error('Generated phone project or CocoaPods workspace missing');
const p = xcode.project(path.join(root, 'ios', projectName, 'project.pbxproj')); p.parseSync();
const phone = p.getFirstTarget().firstTarget.name.replaceAll('"', '');
function build(args) {
  const result = spawnSync('xcodebuild', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
build(['-project', 'ios/' + projectName, '-target', 'PuramaAccessibilityWatch', '-configuration', 'Debug', '-sdk', 'watchsimulator',
  'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', '-jobs', '2', 'build']);
build(['-workspace', 'ios/' + workspaceName, '-scheme', phone, '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator',
  '-derivedDataPath', path.join(process.env.RUNNER_TEMP || '/tmp', 'purama-watch-ios-derived'), 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', '-jobs', '2', 'build']);
const result = { status: 'PASS', phoneTarget: phone, watchTarget: 'PuramaAccessibilityWatch', signed: false,
  scope: 'Native simulator compilation; no device pairing, delivery, display, human acknowledgement or haptic perception qualified' };
fs.writeFileSync(path.join(root, 'qa/watch-native/apple-build.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
