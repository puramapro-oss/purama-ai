package expo.modules.puramalocaldigest

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.jni.TypedArrayKind
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedObject
import expo.modules.kotlin.typedarray.TypedArray

class Sha256Digest(appContext: AppContext) : SharedObject(appContext) {
  val core = Sha256Core()

  override fun sharedObjectDidRelease() {
    core.destroy()
  }
}

class PuramaLocalDigestModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PuramaLocalDigest")

    Class(Sha256Digest::class) {
      Constructor { Sha256Digest(appContext) }

      Function("update") { digest: Sha256Digest, bytes: TypedArray ->
        if (bytes.kind != TypedArrayKind.Uint8Array || bytes.byteLength !in 0..Sha256Core.MAX_BLOCK_BYTES) {
          throw IllegalArgumentException("SHA-256 input must be a Uint8Array of at most 262144 bytes")
        }
        // SDK 54 already applies byteOffset and byteLength to this direct buffer.
        digest.core.update(bytes.toDirectBuffer())
      }

      Function("digestHex") { digest: Sha256Digest -> digest.core.digestHex() }
      Function("destroy") { digest: Sha256Digest -> digest.core.destroy() }
    }
  }
}
