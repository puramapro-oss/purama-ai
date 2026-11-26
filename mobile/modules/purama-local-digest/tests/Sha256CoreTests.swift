import Foundation

private enum TestFailure: Error { case mismatch(String), accepted }

@main
struct Sha256CoreTests {
  static let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  static let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  static let binary = "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72"
  static let millionA = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"

  static func main() throws {
    var checks = 0
    func equal<T: Equatable>(_ expected: T, _ actual: T) throws {
      checks += 1
      guard expected == actual else { throw TestFailure.mismatch("expected=\(expected) actual=\(actual)") }
    }
    func refuses(_ expected: Sha256CoreError, _ action: () throws -> Void) throws {
      checks += 1
      do { try action() }
      catch let error as Sha256CoreError {
        switch (expected, error) {
        case (.closed, .closed), (.invalidBlock, .invalidBlock), (.unavailable, .unavailable): return
        default: throw TestFailure.mismatch("unexpected SHA-256 error")
        }
      }
      throw TestFailure.accepted
    }
    func update(_ digest: Sha256Core, _ bytes: [UInt8]) throws {
      try bytes.withUnsafeBytes { try digest.update($0) }
    }

    try equal(262144, Sha256Core.maximumBlockBytes)
    try equal(empty, Sha256Core().digestHex())
    let single = Sha256Core(); try update(single, Array("abc".utf8))
    try equal(abc, single.digestHex())
    try refuses(.closed) { try update(single, [120]) }
    try refuses(.closed) { _ = try single.digestHex() }
    single.destroy(); single.destroy()

    let split = Sha256Core()
    try update(split, [97]); try update(split, []); try update(split, [98]); try update(split, [99])
    try equal(abc, split.digestHex())

    let sentinels: [UInt8] = [99, 0, 128, 255, 98]
    let view = Sha256Core()
    try sentinels.withUnsafeBytes { buffer in
      try view.update(UnsafeRawBufferPointer(rebasing: buffer[1..<4]))
    }
    try equal(binary, view.digestHex())

    var source: [UInt8] = [97, 98]
    let consumed = Sha256Core(); try update(consumed, source)
    source[0] = 122; source[1] = 122
    try update(consumed, [99]); try equal(abc, consumed.digestHex())

    let block = [UInt8](repeating: 97, count: Sha256Core.maximumBlockBytes)
    let boundary = Sha256Core(); try update(boundary, block)
    try equal("dd3dde87623d9a6b354c68c943d189c89c63652d945e7bbdf0986cae91a49521", boundary.digestHex())
    let overBoundary = Sha256Core(); try update(overBoundary, block); try update(overBoundary, [98])
    try equal("351d840ecf1d340d9e09a9e54972c02563cb0f271369967e59cbaeed0bd30d0e", overBoundary.digestHex())

    let rejected = Sha256Core()
    try refuses(.invalidBlock) { try update(rejected, [UInt8](repeating: 0, count: Sha256Core.maximumBlockBytes + 1)) }
    try update(rejected, Array("abc".utf8)); try equal(abc, rejected.digestHex())

    let million = [UInt8](repeating: 97, count: 1_000_000)
    for chunk in [1, 63, 64, 65, 4093, Sha256Core.maximumBlockBytes] {
      let digest = Sha256Core()
      try million.withUnsafeBytes { buffer in
        for offset in stride(from: 0, to: buffer.count, by: chunk) {
          try digest.update(UnsafeRawBufferPointer(rebasing: buffer[offset..<min(offset + chunk, buffer.count)]))
        }
      }
      try equal(millionA, digest.digestHex())
    }

    let first = Sha256Core(), second = Sha256Core()
    try update(first, [97]); try update(second, [0])
    try update(first, [98, 99]); try update(second, [128, 255])
    try equal(abc, first.digestHex()); try equal(binary, second.digestHex())

    let abandoned = Sha256Core(); try update(abandoned, [97, 98])
    abandoned.destroy(); abandoned.destroy()
    try refuses(.closed) { try update(abandoned, [99]) }
    try refuses(.closed) { _ = try abandoned.digestHex() }
    print("PASS Swift SHA-256 core: \(checks) assertions")
  }
}
