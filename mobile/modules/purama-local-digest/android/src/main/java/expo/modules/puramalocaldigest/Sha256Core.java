package expo.modules.puramalocaldigest;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Platform crypto only. No file paths, worker jobs, or retained input buffers. */
public final class Sha256Core {
  public static final int MAX_BLOCK_BYTES = 256 * 1024;
  private static final char[] HEX = "0123456789abcdef".toCharArray();
  private MessageDigest digest;

  public Sha256Core() {
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("SHA-256 is unavailable", error);
    }
  }

  public synchronized void update(ByteBuffer bytes) {
    ensureOpen();
    if (bytes == null || bytes.remaining() > MAX_BLOCK_BYTES) {
      throw new IllegalArgumentException("SHA-256 input must be at most 262144 bytes");
    }
    // The duplicate bounds the input to the caller's view without moving its position.
    // MessageDigest consumes it before returning; no reference is retained here.
    digest.update(bytes.duplicate());
  }

  public synchronized String digestHex() {
    ensureOpen();
    try {
      byte[] result = digest.digest();
      if (result.length != 32) throw new IllegalStateException("Invalid SHA-256 result");
      char[] text = new char[64];
      for (int index = 0; index < result.length; index++) {
        int value = result[index] & 0xff;
        text[index * 2] = HEX[value >>> 4];
        text[index * 2 + 1] = HEX[value & 15];
      }
      return new String(text);
    } finally {
      // MessageDigest resets on digest(); our public context must stay closed.
      digest = null;
    }
  }

  public synchronized void destroy() {
    // Drop the provider context, including when finalization was never reached.
    digest = null;
  }

  private void ensureOpen() {
    if (digest == null) throw new IllegalStateException("SHA-256 context is closed");
  }
}
