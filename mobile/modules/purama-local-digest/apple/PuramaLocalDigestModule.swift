import ExpoModulesCore

final class Sha256Digest: SharedObject {
  let core = Sha256Core()

  override func sharedObjectDidRelease() {
    core.destroy()
  }
}

public final class PuramaLocalDigestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PuramaLocalDigest")

    Class(Sha256Digest.self) {
      Constructor { Sha256Digest() }

      Function("update") { (digest: Sha256Digest, bytes: TypedArray) in
        guard bytes.kind == .Uint8Array, (0...Sha256Core.maximumBlockBytes).contains(bytes.byteLength) else {
          throw Sha256CoreError.invalidBlock
        }
        // SDK 54 already applies byteOffset to rawPointer. Do not apply it again.
        try digest.core.update(UnsafeRawBufferPointer(start: bytes.rawPointer, count: bytes.byteLength))
      }

      Function("digestHex") { (digest: Sha256Digest) in try digest.core.digestHex() }
      Function("destroy") { (digest: Sha256Digest) in digest.core.destroy() }
    }
  }
}
