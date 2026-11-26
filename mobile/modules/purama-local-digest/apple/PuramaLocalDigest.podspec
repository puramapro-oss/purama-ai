Pod::Spec.new do |s|
  s.name = 'PuramaLocalDigest'
  s.version = '0.1.0'
  s.summary = 'Bounded incremental SHA-256 for the existing PURAMA local pack verifier'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'PURAMA'
  s.homepage = 'https://github.com/puramapro-oss/purama-ai'
  s.source = { :git => 'https://github.com/puramapro-oss/purama-ai.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
