import CommonCrypto
import Foundation

enum Sha256CoreError: Error {
  case closed
  case invalidBlock
  case unavailable
}

/** Platform crypto only. Input memory is borrowed only for the synchronous call. */
final class Sha256Core {
  static let maximumBlockBytes = 256 * 1024
  private let lock = NSLock()
  private var context = CC_SHA256_CTX()
  private var active = false

  init() {
    active = CC_SHA256_Init(&context) == 1
  }

  func update(_ bytes: UnsafeRawBufferPointer) throws {
    lock.lock()
    defer { lock.unlock() }
    guard active else { throw Sha256CoreError.closed }
    guard bytes.count <= Self.maximumBlockBytes else { throw Sha256CoreError.invalidBlock }
    if bytes.isEmpty { return }
    guard CC_SHA256_Update(&context, bytes.baseAddress, CC_LONG(bytes.count)) == 1 else {
      destroyLocked()
      throw Sha256CoreError.unavailable
    }
  }

  func digestHex() throws -> String {
    lock.lock()
    defer { lock.unlock() }
    guard active else { throw Sha256CoreError.closed }
    defer { destroyLocked() }
    var result = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    let status = result.withUnsafeMutableBufferPointer { buffer in
      CC_SHA256_Final(buffer.baseAddress, &context)
    }
    guard status == 1 else { throw Sha256CoreError.unavailable }
    let alphabet = Array("0123456789abcdef".utf8)
    var text = [UInt8]()
    text.reserveCapacity(64)
    for byte in result {
      text.append(alphabet[Int(byte >> 4)])
      text.append(alphabet[Int(byte & 15)])
    }
    return String(decoding: text, as: UTF8.self)
  }

  func destroy() {
    lock.lock()
    defer { lock.unlock() }
    destroyLocked()
  }

  private func destroyLocked() {
    active = false
    context = CC_SHA256_CTX()
  }

  deinit { destroy() }
}
