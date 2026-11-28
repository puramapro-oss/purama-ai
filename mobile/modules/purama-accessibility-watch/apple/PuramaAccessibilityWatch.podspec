Pod::Spec.new do |s|
  s.name = 'PuramaAccessibilityWatch'
  s.version = '0.1.0'
  s.summary = 'Explicit native accessibility sessions for the existing PURAMA mobile app'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'PURAMA'
  s.homepage = 'https://github.com/puramapro-oss/purama-ai'
  s.source = { :git => 'https://github.com/puramapro-oss/purama-ai.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WatchConnectivity'
  s.source_files = '*.swift'
end
