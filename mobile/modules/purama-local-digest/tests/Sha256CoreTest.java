package expo.modules.puramalocaldigest;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Standalone tests: javac + java, without adding a test dependency to the app. */
public final class Sha256CoreTest {
  private static final String EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  private static final String ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  private static final String BINARY = "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72";
  private static final String MILLION_A = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
  private static int checks;

  private static void equal(Object expected, Object actual) {
    checks++;
    if (!expected.equals(actual)) throw new AssertionError("expected=" + expected + " actual=" + actual);
  }

  private static void refuses(Class<? extends Throwable> expected, Runnable action) {
    checks++;
    try { action.run(); }
    catch (Throwable error) {
      if (expected.isInstance(error)) return;
      throw new AssertionError("unexpected error type", error);
    }
    throw new AssertionError("operation was accepted");
  }

  private static ByteBuffer utf8(String text) {
    return ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8));
  }

  public static void main(String[] args) {
    equal(262144, Sha256Core.MAX_BLOCK_BYTES);
    equal(EMPTY, new Sha256Core().digestHex());

    Sha256Core single = new Sha256Core();
    single.update(utf8("abc"));
    equal(ABC, single.digestHex());
    refuses(IllegalStateException.class, () -> single.update(utf8("x")));
    refuses(IllegalStateException.class, single::digestHex);
    single.destroy(); single.destroy();

    Sha256Core split = new Sha256Core();
    split.update(utf8("a")); split.update(ByteBuffer.allocate(0));
    split.update(utf8("b")); split.update(utf8("c"));
    equal(ABC, split.digestHex());

    byte[] sentinels = {99, 0, (byte) 128, (byte) 255, 98};
    ByteBuffer view = ByteBuffer.wrap(sentinels, 1, 3).asReadOnlyBuffer();
    Sha256Core binary = new Sha256Core(); binary.update(view);
    equal(1, view.position()); equal(4, view.limit());
    equal(BINARY, binary.digestHex());

    ByteBuffer direct = ByteBuffer.allocateDirect(5);
    direct.put(sentinels); direct.position(1); direct.limit(4);
    Sha256Core directDigest = new Sha256Core(); directDigest.update(direct.slice());
    equal(BINARY, directDigest.digestHex());

    byte[] source = {'a', 'b'};
    Sha256Core consumed = new Sha256Core(); consumed.update(ByteBuffer.wrap(source));
    Arrays.fill(source, (byte) 'z'); consumed.update(utf8("c"));
    equal(ABC, consumed.digestHex());

    byte[] block = new byte[Sha256Core.MAX_BLOCK_BYTES]; Arrays.fill(block, (byte) 'a');
    Sha256Core boundary = new Sha256Core(); boundary.update(ByteBuffer.wrap(block));
    equal("dd3dde87623d9a6b354c68c943d189c89c63652d945e7bbdf0986cae91a49521", boundary.digestHex());
    Sha256Core overBoundary = new Sha256Core(); overBoundary.update(ByteBuffer.wrap(block)); overBoundary.update(utf8("b"));
    equal("351d840ecf1d340d9e09a9e54972c02563cb0f271369967e59cbaeed0bd30d0e", overBoundary.digestHex());

    Sha256Core rejected = new Sha256Core();
    refuses(IllegalArgumentException.class, () -> rejected.update(ByteBuffer.allocate(Sha256Core.MAX_BLOCK_BYTES + 1)));
    refuses(IllegalArgumentException.class, () -> rejected.update(null));
    rejected.update(utf8("abc")); equal(ABC, rejected.digestHex());

    byte[] million = new byte[1_000_000]; Arrays.fill(million, (byte) 'a');
    for (int chunk : new int[] {1, 63, 64, 65, 4093, Sha256Core.MAX_BLOCK_BYTES}) {
      Sha256Core digest = new Sha256Core();
      for (int offset = 0; offset < million.length; offset += chunk) {
        digest.update(ByteBuffer.wrap(million, offset, Math.min(chunk, million.length - offset)));
      }
      equal(MILLION_A, digest.digestHex());
    }

    Sha256Core first = new Sha256Core(), second = new Sha256Core();
    first.update(utf8("a")); second.update(ByteBuffer.wrap(new byte[] {0}));
    first.update(utf8("bc")); second.update(ByteBuffer.wrap(new byte[] {(byte) 128, (byte) 255}));
    equal(ABC, first.digestHex()); equal(BINARY, second.digestHex());

    Sha256Core abandoned = new Sha256Core(); abandoned.update(utf8("ab"));
    abandoned.destroy(); abandoned.destroy();
    refuses(IllegalStateException.class, () -> abandoned.update(utf8("c")));
    refuses(IllegalStateException.class, abandoned::digestHex);
    System.out.println("PASS Java SHA-256 core: " + checks + " assertions");
  }
}
