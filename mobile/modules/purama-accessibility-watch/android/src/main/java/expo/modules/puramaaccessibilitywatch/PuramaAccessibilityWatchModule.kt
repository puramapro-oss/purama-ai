package expo.modules.puramaaccessibilitywatch

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.CapabilityClient
import com.facebook.react.common.LifecycleState
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import org.json.JSONObject
import java.util.UUID

class PuramaAccessibilityWatchModule : Module(), MessageClient.OnMessageReceivedListener {
  private val main = Handler(Looper.getMainLooper())
  private val engine = PhoneWatchProtocol(SystemClock::elapsedRealtime, System::currentTimeMillis)
  private val devices = mutableMapOf<String, String>()
  private var selectedNode: String? = null
  @Volatile private var foreground = false
  @Volatile private var destroyed = false
  private var listening = false
  private var ticking = false
  private var abortDiscovery: ((String) -> Unit)? = null
  private val context get() = appContext.reactContext ?: throw WatchFailure("native-unavailable")
  private val ticker = object : Runnable {
    override fun run() {
      ticking = false
      if (destroyed || !foreground || engine.binding == null) return
      try { engine.tick() } catch (_: Exception) { engine.end("invalid-message") }
      updateTicker()
    }
  }
  private fun updateTicker() {
    if (destroyed || !foreground || engine.binding == null) { main.removeCallbacks(ticker); ticking = false }
    else if (!ticking) { ticking = true; main.postDelayed(ticker, 250) }
  }
  /** Capture the physical node and bind every asynchronous callback to this packet's
   * complete session. A late failure from A can never close a new session B. */
  private fun sendPacket(packet: JSONObject, done: (Throwable?) -> Unit) {
    val ctx = appContext.reactContext
    val node = selectedNode
    if (ctx == null || node == null) { done(WatchFailure("link-lost")); return }
    val closing = packet.opt("t") == "close"
    fun currentScope() = !destroyed && foreground && selectedNode == node && engine.binding?.matches(packet) == true
    if (!closing && !currentScope()) { done(WatchFailure("closed")); return }
    var finished = false
    var timeout: Runnable? = null
    fun finish(error: Throwable?) {
      if (finished) return
      finished = true; timeout?.let { main.removeCallbacks(it) }; done(error)
      if (error != null && currentScope()) engine.end("link-lost")
    }
    timeout = Runnable { finish(WatchFailure("timeout")) }; main.postDelayed(timeout!!, 5000)
    // Nearby is an availability restriction, not a promise of Bluetooth-only
    // transport. Google Play services choose the Data Layer network path.
    Wearable.getNodeClient(ctx).connectedNodes.addOnSuccessListener { peers ->
      if (finished) return@addOnSuccessListener
      if (!closing && !currentScope()) { finish(WatchFailure("closed")); return@addOnSuccessListener }
      if (peers.none { it.id == node && it.isNearby }) { finish(WatchFailure("link-lost")); return@addOnSuccessListener }
      Wearable.getMessageClient(ctx).sendMessage(node, WatchWire.PATH, packet.toString().toByteArray(Charsets.UTF_8))
        .addOnSuccessListener { finish(null) }.addOnFailureListener { finish(it) }
    }.addOnFailureListener { finish(it) }
  }
  private fun discover(promise: Promise) {
    if (!foreground || destroyed) throw WatchFailure("foreground-required")
    if (engine.binding != null || abortDiscovery != null) throw WatchFailure("not-authorized")
    val ctx = context
    var finished = false
    var timeout: Runnable? = null
    fun failure(reason: String, error: Throwable? = null) {
      if (finished) return
      finished = true; timeout?.let { main.removeCallbacks(it) }; abortDiscovery = null
      promise.reject("E_WATCH", reason, error)
    }
    abortDiscovery = { failure(it) }
    timeout = Runnable { failure("timeout") }; main.postDelayed(timeout!!, 5000)
    Wearable.getMessageClient(ctx).addListener(this).addOnSuccessListener listenerAdded@ {
      if (finished || destroyed || !foreground) {
        if (!listening) Wearable.getMessageClient(ctx).removeListener(this)
        failure("foreground-required"); return@listenerAdded
      }
      listening = true
      Wearable.getCapabilityClient(ctx).getCapability(WatchWire.CAPABILITY, CapabilityClient.FILTER_REACHABLE).addOnSuccessListener capabilityReady@ { capability ->
        if (finished) return@capabilityReady
        if (destroyed || !foreground || engine.binding != null) { failure("closed"); return@capabilityReady }
        devices.clear()
        val result = capability.nodes.filter { it.isNearby }.take(8).map { node ->
          val id = UUID.randomUUID().toString(); devices[id] = node.id
          mapOf("deviceId" to id, "name" to node.displayName.take(80), "platform" to "wear-os")
        }
        finished = true; timeout?.let { main.removeCallbacks(it) }; abortDiscovery = null; promise.resolve(result)
      }.addOnFailureListener { failure("no-device", it) }
    }.addOnFailureListener { failure("native-unavailable", it) }
  }
  override fun definition() = ModuleDefinition {
    Name("PuramaAccessibilityWatch")
    Events("onWatchMessage", "onWatchStatus")
    OnCreate {
      foreground = appContext.hostingRuntimeContext.reactContext?.lifecycleState == LifecycleState.RESUMED
      engine.message = { if (!destroyed) sendEvent("onWatchMessage", mapOf("message" to it.toString())) }
      engine.status = { if (!destroyed) sendEvent("onWatchStatus", mapOf("message" to it.toString())); updateTicker() }
      engine.sendWire = ::sendPacket
    }
    OnDestroy {
      destroyed = true; foreground = false
      val ctx = appContext.reactContext
      main.post { abortDiscovery?.invoke("closed"); engine.end("closed", true); updateTicker(); if (ctx != null && listening) Wearable.getMessageClient(ctx).removeListener(this@PuramaAccessibilityWatchModule); listening = false; devices.clear(); selectedNode = null }
    }
    OnActivityEntersForeground { foreground = true }
    OnActivityEntersBackground { foreground = false; main.post { abortDiscovery?.invoke("foreground-required"); engine.end("foreground-required", true); updateTicker() } }
    Function("challenge") { UUID.randomUUID().toString() }
    Function("monotonicTime") { SystemClock.elapsedRealtime().toDouble() }
    AsyncFunction("discover") { promise: Promise -> onMain(promise) { discover(promise) } }
    AsyncFunction("authorize") { raw: String, promise: Promise -> onMain(promise) {
      val p = WatchWire.parse(raw) ?: throw WatchFailure("invalid-message")
      val device = WatchWire.id(p.opt("deviceId")) ?: throw WatchFailure("not-authorized")
      val kinds = WatchWire.strings(p.opt("allowedKinds")) ?: throw WatchFailure("not-authorized")
      if (!foreground || !WatchWire.fields(p, "deviceId", "allowedKinds")) throw WatchFailure("foreground-required")
      val node = devices[device] ?: throw WatchFailure("no-device")
      engine.authorize(device, kinds); selectedNode = node; promise.resolve(null)
    } }
    AsyncFunction("clearAuthorization") { promise: Promise -> onMain(promise) { abortDiscovery?.invoke("closed"); engine.end("closed", true); promise.resolve(null) } }
    AsyncFunction("open") { raw: String, promise: Promise -> onMain(promise) {
      if (!foreground || !listening) throw WatchFailure("foreground-required")
      engine.begin(raw) { result -> result.onSuccess { promise.resolve(it) }.onFailure { promise.reject("E_WATCH", it.message, it) } }
    } }
    AsyncFunction("send") { raw: String, submittedAt: Double, promise: Promise -> onMain(promise) {
      if (!foreground) throw WatchFailure("foreground-required")
      if (!submittedAt.isFinite() || submittedAt < 0 || kotlin.math.floor(submittedAt) != submittedAt || submittedAt > 9_007_199_254_740_991.0) throw WatchFailure("invalid-message")
      engine.submit(raw, submittedAt.toLong()) { error -> if (error == null) promise.resolve(null) else promise.reject("E_WATCH", "link-lost", error) }
    } }
    AsyncFunction("cancel") { request: String, delivery: String, promise: Promise -> onMain(promise) { engine.cancel(request, delivery); promise.resolve(null) } }
    AsyncFunction("close") { request: String, promise: Promise -> onMain(promise) { engine.close(request); promise.resolve(null) } }
  }
  private fun onMain(promise: Promise, action: () -> Unit) { main.post { try { if (destroyed) throw WatchFailure("native-unavailable"); action() } catch (error: Exception) { promise.reject("E_WATCH", error.message, error) } } }
  override fun onMessageReceived(event: MessageEvent) {
    if (event.path != WatchWire.PATH || event.data.size > 4096) return
    val p = WatchWire.parse(event.data.toString(Charsets.UTF_8)) ?: return
    main.post { if (!destroyed && foreground && event.sourceNodeId == selectedNode) engine.receive(p) }
  }
}
