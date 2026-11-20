package expo.modules.puramaaccessibilitywatch

import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject

class WatchProtocolTest {
  private class Harness {
    var now = 1000L; var wall = 1000L
    val packets = mutableListOf<JSONObject>(); val receipts = mutableListOf<JSONObject>()
    var result: Result<String>? = null
    val phone = PhoneWatchProtocol({ now }, { wall })
    init { phone.sendWire = { p, complete -> packets.add(p); complete(null) }; phone.message = { receipts.add(it) } }
    fun begin(request: String = "request-1") { phone.authorize("device-1", listOf("speech")); phone.begin(WatchWire.obj("version" to 1, "type" to "one-watch-handshake", "requestId" to request).toString()) { result = it } }
    fun connected() { begin(); val s = phone.binding!!; phone.receive(s.packet("accepted", "challenge" to s.challenge)) }
    fun send(id: String = "delivery-1", eventId: String = "event-1", source: String = "microphone", remaining: Long = 5000, submittedAt: Long? = null) {
      val s = phone.binding!!
      val e = WatchWire.obj("version" to 1, "eventId" to eventId, "source" to source, "kind" to "speech", "observedAt" to wall, "expiresAt" to wall + 5000, "assessment" to "provisional")
      phone.submit(WatchWire.obj("version" to 1, "type" to "one-watch-send", "requestId" to s.requestId, "envelope" to WatchWire.obj("version" to 1, "type" to "one-awareness-delivery", "sessionId" to s.sessionId, "deviceId" to s.deviceId, "deliveryId" to id, "event" to e, "remainingTtlMs" to remaining)).toString(), submittedAt) {}
    }
    fun resolve() { phone.binding?.let { phone.receive(it.packet("resolve", "deliveryId" to "delivery-1", "nonce" to "fresh-nonce")) } }
  }
  private fun refused(action: () -> Unit) { try { action() } catch (_: Exception) { return }; fail("Expected refusal") }
  @Test fun permissionRequired() { val h = Harness(); refused { h.phone.begin("{}") {} }; assertTrue(h.packets.isEmpty()) }
  @Test fun authorizationExpires() { val h = Harness(); h.phone.authorize("device-1", listOf("speech")); h.now += 60_000; refused { h.phone.begin(WatchWire.obj("version" to 1, "type" to "one-watch-handshake", "requestId" to "r").toString()) {} } }
  @Test fun enqueueIsNotConsent() { val h = Harness(); h.begin(); assertNull(h.result); assertEquals(1, h.packets.size) }
  @Test fun incorrectChallenge() { val h = Harness(); h.begin(); val s = h.phone.binding!!; h.phone.receive(s.packet("accepted", "challenge" to "wrong")); assertNull(h.result) }
  @Test fun acceptedPacketCreatesOneBinding() { val h = Harness(); h.connected(); val r = JSONObject(h.result!!.getOrThrow()); assertEquals("one-watch-ready", r.getString("type")); assertEquals("wear-os", r.getJSONObject("binding").getString("platform")); assertEquals("confirmed", h.packets.last().getString("t")) }
  @Test fun dispatchDoesNotFabricateReceipt() { val h = Harness(); h.connected(); h.send(); assertTrue(h.receipts.isEmpty()); assertEquals("offer", h.packets.last().getString("t")) }
  @Test fun resolveSubtractsQueueTime() { val h = Harness(); h.connected(); h.send(); h.now += 1500; h.wall += 1500; h.resolve(); assertEquals(3500L, h.packets.last().getLong("remainingTtlMs")) }
  @Test fun exactDeadlineCannotDeliver() { val h = Harness(); h.connected(); h.send(); h.now += 5000; val count = h.packets.size; h.resolve(); assertEquals(count, h.packets.size) }
  @Test fun cancelledResolution() { val h = Harness(); h.connected(); h.send(); h.phone.cancel("request-1", "delivery-1"); val count = h.packets.size; h.resolve(); assertEquals(count, h.packets.size) }
  @Test fun deliveryAndEventReplay() { val h = Harness(); h.connected(); h.send(); refused { h.send() }; refused { h.send("another", "event-1") } }
  @Test fun simulationsRefused() { val h = Harness(); h.connected(); refused { h.send(source = "simulation") } }
  @Test fun closeBeforeOpen() { val h = Harness(); h.phone.close("request-1"); refused { h.begin() }; assertNull(h.phone.binding) }
  @Test fun closeInvalidatesPendingHandshake() { val h = Harness(); h.begin(); val s = h.phone.binding!!; h.phone.close("request-1"); assertTrue(h.result!!.isFailure); h.phone.receive(s.packet("accepted", "challenge" to s.challenge)); assertNull(h.phone.binding) }
  @Test fun handshakeDeadline() { val h = Harness(); h.begin(); h.now += 59_999; h.phone.tick(); assertNull(h.result); h.now++; h.phone.tick(); assertTrue(h.result!!.isFailure) }
  @Test fun clockRollback() { val h = Harness(); h.connected(); h.now = 999; refused { h.send() }; assertNull(h.phone.binding) }
  @Test fun boundedReplayMemory() { val h = Harness(); h.connected(); repeat(128) { h.send("delivery-$it", "event-$it") }; refused { h.send("overflow", "overflow") } }
  @Test fun roundTripBudget() { assertEquals(2500L, WatchWire.resolvedBudget(4000, 1500, 5000)); assertNull(WatchWire.resolvedBudget(5000, 5000, 5000)); assertNull(WatchWire.resolvedBudget(6000, 1, 5000)); assertNull(WatchWire.resolvedBudget(5000, -1, 5000)) }
  @Test fun booleansAreNotVersions() { assertNull(WatchWire.number(true)) }
  @Test fun expoQueueSubtractsElapsedBeforeStorage() { val h = Harness(); h.connected(); h.now = 1800; h.wall = 1800; h.send(remaining = 1000, submittedAt = 1000); h.resolve(); assertEquals(200L, h.packets.last().getLong("remainingTtlMs")) }
  @Test fun exhaustedQueueAndFutureClockRefused() { val h = Harness(); h.connected(); h.now = 2000; refused { h.send(remaining = 1000, submittedAt = 1000) }; refused { h.send(submittedAt = 2001) } }
  @Test fun cancellationBeforeSubmitCannotResurrectDelivery() { val h = Harness(); h.connected(); h.phone.cancel("request-1", "delivery-1"); refused { h.send() }; assertTrue(h.packets.none { it.opt("t") == "offer" }) }
  @Test fun earlyCancellationCapacityFailsClosed() { val h = Harness(); h.connected(); repeat(129) { h.phone.cancel("request-1", "cancel-$it") }; assertNull(h.phone.binding) }
  @Test fun lateFailureFromACannotCloseB() {
    val h = Harness(); h.connected(); var delayed: ((Throwable?) -> Unit)? = null
    h.phone.sendWire = { p, done -> h.packets.add(p); if (p.opt("t") == "offer") delayed = done else done(null) }
    h.send(); h.phone.close("request-1"); h.now++; h.begin("request-2"); val s = h.phone.binding!!; h.phone.receive(s.packet("accepted", "challenge" to s.challenge))
    delayed?.invoke(WatchFailure("link-lost")); assertEquals(s.sessionId, h.phone.binding?.sessionId)
  }
  @Test fun lostPeerOrCloseExpiresAtSixSeconds() { val h = Harness(); h.connected(); h.now += 5999; h.phone.tick(); assertNotNull(h.phone.binding); h.now++; h.phone.tick(); assertNull(h.phone.binding) }
  @Test fun freshNonceResponseExtendsLease() {
    val h = Harness(); h.connected(); val s = h.phone.binding!!; h.now = 3000; h.phone.tick(); val nonce = h.packets.last().getString("nonce")
    h.now = 3500; h.phone.receive(s.packet("pong", "nonce" to nonce)); h.now = 7000; h.phone.tick(); assertNotNull(h.phone.binding)
    h.now = 9500; h.phone.tick(); assertNull(h.phone.binding)
  }
  @Test fun wrongLateReplayedPongAndPeerPingDoNotExtendLease() {
    for (variant in listOf("wrong", "late", "ping", "replay")) {
      val h = Harness(); h.connected(); val s = h.phone.binding!!; h.now = 3000; h.phone.tick(); val nonce = h.packets.last().getString("nonce")
      if (variant == "replay") { h.now = 3100; h.phone.receive(s.packet("pong", "nonce" to nonce)); h.now = 5000; h.phone.tick(); h.now = 6000 } else h.now = if (variant == "late") 5000 else 3500
      h.phone.receive(s.packet(if (variant == "ping") "ping" else "pong", "nonce" to if (variant == "wrong") "wrong" else nonce))
      h.now = if (variant == "replay") 9100 else 7000; h.phone.tick(); assertNull(h.phone.binding)
    }
  }
  @Test fun closeBeforeHelloIsSessionScopedAndExpires() {
    val memory = WatchSessionRevocations(); val a = WatchBinding("a", "s1", "d", "c", setOf("speech"))
    memory.record(a.packet("close"), 1000); assertFalse(memory.allows(a.packet("hello"), 1001))
    assertTrue(memory.allows(WatchBinding("a", "s2", "d", "c", setOf("speech")).packet("hello"), 1001)); assertTrue(memory.allows(a.packet("hello"), 121000))
  }
  @Test fun boundedSessionRevocationsFailClosed() {
    val memory = WatchSessionRevocations(); repeat(129) { memory.record(WatchWire.obj("requestId" to "r$it", "sessionId" to "s", "deviceId" to "d"), 1000) }
    val novel = WatchWire.obj("requestId" to "new", "sessionId" to "s", "deviceId" to "d")
    assertFalse(memory.allows(novel, 1001)); assertTrue(memory.allows(novel, 121000))
  }
}
