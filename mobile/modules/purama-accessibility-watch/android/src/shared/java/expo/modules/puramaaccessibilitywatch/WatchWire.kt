package expo.modules.puramaaccessibilitywatch

import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
import kotlin.math.floor
import kotlin.math.min

internal object WatchWire {
  const val MAX = 60_000L
  const val CAPACITY = 128
  const val PATH = "/purama/accessibility/v1"
  const val CAPABILITY = "purama_accessibility_watch_v1"
  fun resolvedBudget(remaining: Long, elapsed: Long, eventLifetime: Long): Long? =
    if (remaining !in 1..MAX || remaining > eventLifetime || elapsed !in 0..4999 || remaining - elapsed < 1) null else remaining - elapsed
  val kinds = listOf("doorbell", "speech", "siren", "vehicle-sound", "horn", "knock", "telephone-ring", "vehicle", "sensor-unavailable")
  val labels = listOf("Sonnette possible. À vérifier.", "Une voix est possible. Aucun propos n’est transcrit.", "Sirène possible. Direction inconnue.",
    "Bruit de véhicule possible. Position et distance inconnues.", "Klaxon possible. Aucun véhicule localisé.", "Coups possibles. Origine inconnue.",
    "Sonnerie de téléphone possible. Aucun appel identifié.", "Véhicule possible dans l’image. Aucune sécurité de passage évaluée.",
    "Observation indisponible. L’absence d’alerte ne signifie pas absence de danger.").let { kinds.zip(it).toMap() }
  fun id(v: Any?): String? = (v as? String)?.takeIf { it.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$")) }
  fun number(v: Any?): Long? {
    val n = (v as? Number)?.toDouble() ?: return null
    return n.takeIf { it.isFinite() && floor(it) == it && it >= 0 && it <= 8_640_000_000_000_000.0 - MAX }?.toLong()
  }
  fun fields(p: JSONObject, vararg keys: String) = p.keys().asSequence().toSet() == keys.toSet()
  fun parse(raw: String): JSONObject? = if (raw.toByteArray(Charsets.UTF_8).size > 4096) null else try { JSONObject(raw) } catch (_: Exception) { null }
  fun strings(v: Any?): List<String>? {
    val a = v as? JSONArray ?: return null
    if (a.length() == 0 || a.length() > kinds.size) return null
    val result = (0 until a.length()).map { a.opt(it) as? String ?: return null }
    return result.takeIf { it.toSet().size == it.size && it.all(kinds::contains) }
  }
  fun obj(vararg fields: Pair<String, Any?>): JSONObject = JSONObject().apply { fields.forEach { put(it.first, it.second) } }
  fun event(value: Any?, allowed: Set<String>, wall: Long? = null): JSONObject? {
    val e = value as? JSONObject ?: return null
    if (!fields(e, "version", "eventId", "source", "kind", "observedAt", "expiresAt", "assessment") || number(e.opt("version")) != 1L
      || id(e.opt("eventId")) == null || e.opt("assessment") != "provisional") return null
    val observed = number(e.opt("observedAt")) ?: return null
    val expires = number(e.opt("expiresAt")) ?: return null
    val kind = e.opt("kind") as? String ?: return null
    val source = e.opt("source") as? String ?: return null
    if (kind !in allowed || expires <= observed || expires - observed > MAX || wall != null && (observed > wall || expires <= wall)) return null
    if (!(source == "microphone" && kind in kinds.take(7) || source == "camera" && kind == "vehicle" || source == "system" && kind == "sensor-unavailable")) return null
    return e
  }
}
internal data class WatchBinding(val requestId: String, val sessionId: String, val deviceId: String, val challenge: String, val allowed: Set<String>) {
  fun packet(type: String, vararg extra: Pair<String, Any?>): JSONObject = WatchWire.obj("v" to 1, "t" to type, "requestId" to requestId, "sessionId" to sessionId, "deviceId" to deviceId, *extra)
  fun matches(p: JSONObject) = WatchWire.number(p.opt("v")) == 1L && p.opt("requestId") == requestId && p.opt("sessionId") == sessionId && p.opt("deviceId") == deviceId
}
internal class WatchFailure(val reason: String) : Exception(reason)

/** Bounded, session-scoped tombstones for reordered close/hello messages. */
internal class WatchSessionRevocations {
  private val closed = mutableMapOf<String, Long>()
  private var blockedUntil = 0L
  private fun key(p: JSONObject): String? {
    val request = WatchWire.id(p.opt("requestId")) ?: return null
    val session = WatchWire.id(p.opt("sessionId")) ?: return null
    val device = WatchWire.id(p.opt("deviceId")) ?: return null
    return "$request|$session|$device"
  }
  fun record(p: JSONObject, now: Long) {
    if (now < 0 || now > Long.MAX_VALUE - 2 * WatchWire.MAX) return
    val key = key(p) ?: return
    closed.entries.removeAll { it.value <= now }
    if (key in closed || closed.size < WatchWire.CAPACITY) closed[key] = now + 2 * WatchWire.MAX
    else blockedUntil = maxOf(blockedUntil, now + 2 * WatchWire.MAX)
  }
  fun allows(p: JSONObject, now: Long): Boolean {
    if (now < 0 || now < blockedUntil) return false
    val key = key(p) ?: return false
    closed.entries.removeAll { it.value <= now }
    return key !in closed
  }
}

/** Serialized on the Android main looper. The clock includes device sleep. */
internal class PhoneWatchProtocol(var clock: () -> Long, var wall: () -> Long) {
  data class Delivery(val event: JSONObject, val deadline: Long, val forgetAt: Long, var stage: Int = -1, var cancelled: Boolean = false)
  var sendWire: (JSONObject, (Throwable?) -> Unit) -> Unit = { _, done -> done(WatchFailure("link-lost")) }
  var message: (JSONObject) -> Unit = {}
  var status: (JSONObject) -> Unit = {}
  var binding: WatchBinding? = null; private set
  private var permission: Pair<String, Set<String>>? = null
  private var permissionDeadline = 0L
  private var ready: ((Result<String>) -> Unit)? = null
  private var pairingDeadline = 0L
  private var peerSeen = 0L
  private var probe: Pair<String, Long>? = null
  private var lastProbe = 0L
  private var lastClock = 0L
  private var blockedUntil = 0L
  private val deliveries = mutableMapOf<String, Delivery>()
  private val cancelled = mutableMapOf<String, Long>()
  private val closed = mutableMapOf<String, Long>()
  private fun time(): Long {
    val now = clock()
    if (now < lastClock || now < 0 || now > Long.MAX_VALUE - 2 * WatchWire.MAX) { end("invalid-message"); throw WatchFailure("invalid-message") }
    lastClock = now; return now
  }
  fun authorize(device: String, kinds: List<String>) {
    if (binding != null || WatchWire.id(device) == null || kinds.isEmpty() || kinds.size > WatchWire.kinds.size || kinds.toSet().size != kinds.size || !kinds.all(WatchWire.kinds::contains)) throw WatchFailure("not-authorized")
    permission = device to kinds.toSet()
    permissionDeadline = time() + WatchWire.MAX
  }
  fun begin(raw: String, complete: (Result<String>) -> Unit) {
    val now = time(); closed.entries.removeAll { it.value <= now }
    val p = WatchWire.parse(raw) ?: throw WatchFailure("invalid-message")
    val request = WatchWire.id(p.opt("requestId")) ?: throw WatchFailure("invalid-message")
    val authorized = permission ?: throw WatchFailure("not-authorized")
    if (!WatchWire.fields(p, "version", "type", "requestId") || WatchWire.number(p.opt("version")) != 1L || p.opt("type") != "one-watch-handshake"
      || binding != null || request in closed || now < blockedUntil || now >= permissionDeadline) throw WatchFailure("not-authorized")
    permission = null
    val s = WatchBinding(request, UUID.randomUUID().toString(), authorized.first, UUID.randomUUID().toString(), authorized.second)
    binding = s; ready = complete; pairingDeadline = now + WatchWire.MAX
    val code = java.security.SecureRandom().nextInt(1_000_000).toString().padStart(6, '0')
    status(WatchWire.obj("state" to "awaiting-watch", "requestId" to request, "deviceId" to s.deviceId, "pairingCode" to code))
    sendWire(s.packet("hello", "challenge" to s.challenge, "code" to code, "allowedKinds" to JSONArray(s.allowed.sorted()))) { error -> if (error != null && binding?.sessionId == s.sessionId) end("link-lost") }
  }
  fun submit(raw: String, submittedAt: Long? = null, complete: (Throwable?) -> Unit) {
    val now = time(); val s = binding ?: throw WatchFailure("not-authorized")
    val submitted = submittedAt ?: now
    if (submitted < 0 || submitted > now) throw WatchFailure("invalid-message")
    val p = WatchWire.parse(raw) ?: throw WatchFailure("invalid-message")
    val e = p.optJSONObject("envelope") ?: throw WatchFailure("invalid-message")
    val id = WatchWire.id(e.opt("deliveryId")) ?: throw WatchFailure("invalid-message")
    val event = WatchWire.event(e.opt("event"), s.allowed, wall()) ?: throw WatchFailure("invalid-message")
    val budget = WatchWire.number(e.opt("remainingTtlMs")) ?: throw WatchFailure("invalid-message")
    if (ready != null || !WatchWire.fields(p, "version", "type", "requestId", "envelope") || WatchWire.number(p.opt("version")) != 1L || p.opt("type") != "one-watch-send" || p.opt("requestId") != s.requestId
      || !WatchWire.fields(e, "version", "type", "sessionId", "deviceId", "deliveryId", "event", "remainingTtlMs") || WatchWire.number(e.opt("version")) != 1L || e.opt("type") != "one-awareness-delivery"
      || e.opt("sessionId") != s.sessionId || e.opt("deviceId") != s.deviceId || budget !in 1..WatchWire.MAX) throw WatchFailure("invalid-message")
    deliveries.entries.removeAll { it.value.forgetAt <= now }
    cancelled.entries.removeAll { it.value <= now }
    if (id in cancelled) throw WatchFailure("closed")
    if (deliveries.size >= WatchWire.CAPACITY || id in deliveries || deliveries.values.any { it.event.opt("eventId") == event.opt("eventId") }) throw WatchFailure("capacity")
    val ttl = min(budget - (now - submitted), event.getLong("expiresAt") - wall())
    if (ttl < 1) throw WatchFailure("timeout")
    deliveries[id] = Delivery(event, now + ttl, now + ttl + WatchWire.MAX)
    sendWire(s.packet("offer", "deliveryId" to id, "eventId" to event.getString("eventId"))) { error -> if (error != null && binding?.sessionId == s.sessionId) cancel(s.requestId, id); complete(error) }
  }
  fun receive(p: JSONObject) {
    val now = try { time() } catch (_: Exception) { return }; val s = binding ?: return
    if (!s.matches(p)) return
    val type = p.optString("t")
    if (type == "accepted" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "challenge") && p.opt("challenge") == s.challenge && now < pairingDeadline) {
      val done = ready ?: return; ready = null; peerSeen = now
      sendWire(s.packet("confirmed")) { error -> if (error != null && binding?.sessionId == s.sessionId) end("link-lost") }
      if (binding?.sessionId != s.sessionId) { done(Result.failure(WatchFailure("link-lost"))); return }
      done(Result.success(WatchWire.obj("version" to 1, "type" to "one-watch-ready", "requestId" to s.requestId,
        "binding" to WatchWire.obj("version" to 1, "sessionId" to s.sessionId, "deviceId" to s.deviceId, "platform" to "wear-os")).toString()))
      status(WatchWire.obj("state" to "connected", "requestId" to s.requestId, "deviceId" to s.deviceId)); return
    }
    if (type == "close" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId")) { end(if (ready == null) "closed" else "watch-declined"); return }
    if (ready != null) return
    if (type == "ping" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "nonce")) {
      val nonce = WatchWire.id(p.opt("nonce")) ?: return; sendWire(s.packet("pong", "nonce" to nonce)) {}; return
    }
    if (type == "pong" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "nonce")) {
      val pending = probe ?: return
      if (p.opt("nonce") == pending.first && now >= pending.second && now - pending.second < 2000) { probe = null; peerSeen = now }; return
    }
    if (type == "resolve" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "deliveryId", "nonce")) {
      val id = WatchWire.id(p.opt("deliveryId")) ?: return; val nonce = WatchWire.id(p.opt("nonce")) ?: return
      val d = deliveries[id] ?: return; val left = min(d.deadline - now, d.event.getLong("expiresAt") - wall())
      if (!d.cancelled && left >= 1) sendWire(s.packet("event", "deliveryId" to id, "nonce" to nonce, "event" to d.event, "remainingTtlMs" to left)) {}
      return
    }
    if (type == "receipt" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "receipt")) {
      val r = p.optJSONObject("receipt") ?: return; val id = WatchWire.id(r.opt("deliveryId")) ?: return; val d = deliveries[id] ?: return
      val rank = listOf("received", "displayed", "acknowledged").indexOf(r.optString("stage"))
      if (!WatchWire.fields(r, "version", "type", "sessionId", "deviceId", "deliveryId", "eventId", "stage") || WatchWire.number(r.opt("version")) != 1L || r.opt("type") != "one-awareness-receipt"
        || r.opt("sessionId") != s.sessionId || r.opt("deviceId") != s.deviceId || r.opt("eventId") != d.event.opt("eventId") || d.cancelled || now >= d.deadline || wall() >= d.event.getLong("expiresAt") || rank < 0 || rank <= d.stage) return
      d.stage = rank; message(WatchWire.obj("version" to 1, "type" to "one-watch-receipt", "requestId" to s.requestId, "receipt" to r))
    }
  }
  fun tick() {
    val now = time()
    if (ready != null && now >= pairingDeadline) end("timeout")
    else if (binding != null && ready == null) {
      if (now - peerSeen >= 6000) end("link-lost")
      else if (now - lastProbe >= 2000) {
        lastProbe = now; val nonce = UUID.randomUUID().toString(); probe = nonce to now
        binding?.let { sendWire(it.packet("ping", "nonce" to nonce)) {} }
      }
    }
  }
  fun cancel(request: String, id: String) {
    val now = try { time() } catch (_: Exception) { return }
    val s = binding?.takeIf { it.requestId == request } ?: return
    if (WatchWire.id(id) == null) return
    cancelled.entries.removeAll { it.value <= now }
    if (id !in cancelled && cancelled.size >= WatchWire.CAPACITY) { end("capacity"); return }
    // Expo work can be reordered. Remember cancellation even before submit.
    cancelled[id] = now + 2 * WatchWire.MAX
    deliveries[id]?.cancelled = true
    sendWire(s.packet("cancel", "deliveryId" to id)) {}
  }
  fun close(request: String) {
    val now = clock(); closed.entries.removeAll { it.value <= now }
    if (closed.size < WatchWire.CAPACITY) closed[request] = now + WatchWire.MAX else blockedUntil = maxOf(blockedUntil, now + WatchWire.MAX)
    if (binding?.requestId == request) end("closed")
  }
  fun end(reason: String, revoked: Boolean = false) {
    permission = null; val s = binding ?: return
    binding = null; val done = ready; ready = null; probe = null; lastProbe = 0; deliveries.clear(); cancelled.clear()
    if (closed.size < WatchWire.CAPACITY) closed[s.requestId] = clock() + WatchWire.MAX else blockedUntil = maxOf(blockedUntil, clock() + WatchWire.MAX)
    sendWire(s.packet("close")) {}
    done?.invoke(Result.failure(WatchFailure(reason)))
    message(WatchWire.obj("version" to 1, "type" to if (revoked) "one-watch-revoked" else "one-watch-disconnected", "requestId" to s.requestId))
    status(WatchWire.obj("state" to if (revoked) "revoked" else "disconnected", "requestId" to s.requestId, "reason" to reason))
  }
}
