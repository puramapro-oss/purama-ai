package dev.purama.accessibilitywatch

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.Vibrator
import android.os.VibrationEffect
import android.content.Context
import android.view.View
import android.graphics.Rect
import android.widget.TextView
import android.widget.Button
import android.widget.Switch
import android.widget.LinearLayout
import android.widget.ScrollView
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import expo.modules.puramaaccessibilitywatch.WatchWire
import expo.modules.puramaaccessibilitywatch.WatchBinding
import expo.modules.puramaaccessibilitywatch.WatchSessionRevocations
import org.json.JSONObject
import java.util.UUID

/** Foreground companion. There is deliberately no background listener service,
 * notification relay, workout mode, deferred queue or automatic session resume. */
class WatchActivity : Activity(), MessageClient.OnMessageReceivedListener {
  private data class Pending(val binding: WatchBinding, val code: String, val deadline: Long)
  private data class Waiting(val nonce: String, val started: Long, val eventId: String)
  private data class Item(val id: String, val event: JSONObject, val deadline: Long, val forgetAt: Long, var stage: Int = 0, var cancelled: Boolean = false)
  private val handler = Handler(Looper.getMainLooper())
  private var active = false
  private var boundNode: String? = null
  private var pending: Pending? = null
  private var binding: WatchBinding? = null
  private var confirmed = false
  private var confirmDeadline = 0L
  private var peerSeen = 0L
  private var lastPing = 0L
  private var probe: Pair<String, Long>? = null
  private var generation = 0L
  private val revokedSessions = WatchSessionRevocations()
  private var haptics = false
  private var current = 0
  private var lastClock = 0L
  private var status = "Ouvrez la connexion montre sur le téléphone."
  private val waiting = mutableMapOf<String, Waiting>()
  private val seenDeliveries = mutableMapOf<String, Long>()
  private val seenEvents = mutableMapOf<String, Long>()
  private val items = mutableListOf<Item>()
  private lateinit var body: LinearLayout
  private var expiryLabel: TextView? = null
  private var acknowledgeButton: Button? = null
  private var countLabel: TextView? = null
  private var observationView: TextView? = null
  private val ticker = object : Runnable {
    override fun run() {
      val now = SystemClock.elapsedRealtime()
      if (now < lastClock || pending?.let { now >= it.deadline } == true || binding != null && !confirmed && now >= confirmDeadline) close()
      if (confirmed) {
        if (now - peerSeen >= 6000) close()
        else if (now - lastPing >= 2000) { lastPing = now; val nonce = UUID.randomUUID().toString(); probe = nonce to now; binding?.let { send(it.packet("ping", "nonce" to nonce)) } }
      }
      lastClock = now
      waiting.entries.removeAll { now - it.value.started >= 5000 }
      seenDeliveries.entries.removeAll { it.value <= now }; seenEvents.entries.removeAll { it.value <= now }
      val item = items.getOrNull(current)
      if (item != null && !fresh(item)) { expiryLabel?.text = "Expirée — ne plus agir sur ce signal"; acknowledgeButton?.isEnabled = false }
      if (active) handler.postDelayed(this, 250)
    }
  }
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(22, 24, 22, 24) }
    setContentView(ScrollView(this).apply { addView(body); viewTreeObserver.addOnScrollChangedListener { showReceipt() } }); render()
  }
  override fun onResume() { super.onResume(); active = true; Wearable.getMessageClient(this).addListener(this); handler.post(ticker) }
  override fun onPause() { active = false; close(); handler.removeCallbacks(ticker); Wearable.getMessageClient(this).removeListener(this); super.onPause() }
  override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) showReceipt() }
  private fun text(value: String): TextView = TextView(this).apply { text = value; textSize = 17f; setPadding(0, 8, 0, 8); body.addView(this) }
  private fun button(label: String, action: () -> Unit): Button = Button(this).apply { text = label; isAllCaps = false; minHeight = 52; setOnClickListener { action() }; body.addView(this) }
  private fun render() {
    body.removeAllViews(); expiryLabel = null; acknowledgeButton = null; countLabel = null; observationView = null
    text("PURAMA"); text(status)
    val p = pending
    if (p != null) {
      text("Comparez ce code avec le téléphone :")
      text(p.code).contentDescription = "Code : " + p.code.toCharArray().joinToString(" ")
      text(p.binding.allowed.sorted().mapNotNull { WatchWire.labels[it] }.joinToString("\n"))
      text("Catégories et heures uniquement, sans audio. Le transport peut utiliser le réseau des services Google.")
      body.addView(Switch(this).apply { text = "Vibrations de cette session"; isChecked = haptics; setOnCheckedChangeListener { _, value -> haptics = value } })
      button("Autoriser cette session") { accept() }; button("Refuser") { close() }
    } else if (binding != null) {
      val item = items.getOrNull(current)
      if (item == null) text("Aucune observation reçue.") else {
        observationView = text(WatchWire.labels[item.event.optString("kind")] ?: "Observation à vérifier")
        expiryLabel = text(if (fresh(item)) "Observation provisoire" else "Expirée — ne plus agir sur ce signal")
        acknowledgeButton = button("J’ai compris") { acknowledge() }.apply { isEnabled = fresh(item) && item.stage == 1 }
        button("Observation suivante") { if (items.isNotEmpty()) { current = (current + 1) % items.size; render() } }.isEnabled = items.size > 1
      }
      countLabel = text("${items.size} observation(s) reçue(s)")
      text("Le téléphone reste le recours. Aucun guidage de déplacement.")
      button("Déconnecter") { close() }
      body.post { showReceipt() }
    }
  }
  private fun fresh(item: Item) = active && confirmed && !item.cancelled && SystemClock.elapsedRealtime() < item.deadline
  private fun send(packet: JSONObject) {
    val node = boundNode ?: return
    val token = generation
    val closing = packet.opt("t") == "close"
    fun currentScope() = generation == token && boundNode == node && (binding ?: pending?.binding)?.matches(packet) == true
    fun failed() { if (currentScope()) reset("Liaison perdue. Utilisez le téléphone.") }
    Wearable.getNodeClient(this).connectedNodes.addOnSuccessListener { nodes ->
      if (!closing && !currentScope()) return@addOnSuccessListener
      if (nodes.none { it.id == node && it.isNearby }) { failed(); return@addOnSuccessListener }
      Wearable.getMessageClient(this).sendMessage(node, WatchWire.PATH, packet.toString().toByteArray(Charsets.UTF_8)).addOnFailureListener { failed() }
    }.addOnFailureListener { failed() }
  }
  private fun reset(message: String) {
    (binding ?: pending?.binding)?.let { revokedSessions.record(it.packet("close"), SystemClock.elapsedRealtime()) }
    generation += 1; binding = null; pending = null; confirmed = false; boundNode = null; haptics = false; current = 0; probe = null; lastPing = 0
    waiting.clear(); items.clear(); seenEvents.clear(); seenDeliveries.clear(); status = message; render()
  }
  private fun close() { (binding ?: pending?.binding)?.let { send(it.packet("close")) }; reset("Déconnectée. Utilisez le téléphone.") }
  private fun accept() {
    val p = pending ?: return
    if (!active || SystemClock.elapsedRealtime() >= p.deadline) { close(); return }
    pending = null; binding = p.binding; confirmed = false; confirmDeadline = SystemClock.elapsedRealtime() + 5000
    status = "Confirmation du téléphone en cours…"; render()
    send(p.binding.packet("accepted", "challenge" to p.binding.challenge))
  }
  private fun receipt(item: Item, stage: String) {
    val s = binding ?: return
    if (!fresh(item)) return
    send(s.packet("receipt", "receipt" to WatchWire.obj("version" to 1, "type" to "one-awareness-receipt", "sessionId" to s.sessionId,
      "deviceId" to s.deviceId, "deliveryId" to item.id, "eventId" to item.event.getString("eventId"), "stage" to stage)))
  }
  private fun showReceipt() {
    val item = items.getOrNull(current) ?: return
    val visible = Rect()
    if (!active || !window.decorView.hasWindowFocus() || !body.isShown || observationView?.getGlobalVisibleRect(visible) != true || visible.isEmpty || !fresh(item) || item.stage != 0) return
    item.stage = 1; receipt(item, "displayed"); acknowledgeButton?.isEnabled = true
    if (haptics) { val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator; if (vibrator?.hasVibrator() == true) vibrator.vibrate(VibrationEffect.createOneShot(180, VibrationEffect.DEFAULT_AMPLITUDE)) }
  }
  private fun acknowledge() {
    val item = items.getOrNull(current) ?: return
    if (!fresh(item) || item.stage != 1 || !window.decorView.hasWindowFocus()) return
    item.stage = 2; receipt(item, "acknowledged"); acknowledgeButton?.isEnabled = false
  }
  override fun onMessageReceived(event: MessageEvent) {
    if (!active || event.path != WatchWire.PATH || event.data.size > 4096) return
    val packet = WatchWire.parse(event.data.toString(Charsets.UTF_8)) ?: return
    val arrived = SystemClock.elapsedRealtime()
    handler.post {
      if (!active || SystemClock.elapsedRealtime() - arrived !in 0..4999) return@post
      if (boundNode != null && boundNode != event.sourceNodeId) return@post
      Wearable.getNodeClient(this).connectedNodes.addOnSuccessListener { peers ->
        if (active && SystemClock.elapsedRealtime() - arrived in 0..4999 && peers.any { it.id == event.sourceNodeId && it.isNearby } && (boundNode == null || boundNode == event.sourceNodeId)) receive(packet, event.sourceNodeId)
      }
    }
  }
  private fun receive(p: JSONObject, sourceNode: String) {
    val now = SystemClock.elapsedRealtime(); val type = p.optString("t")
    if (WatchWire.number(p.opt("v")) != 1L) return
    if (type == "close" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId") && WatchWire.id(p.opt("requestId")) != null && WatchWire.id(p.opt("sessionId")) != null && WatchWire.id(p.opt("deviceId")) != null) {
      revokedSessions.record(p, now)
      if ((binding ?: pending?.binding)?.matches(p) == true && sourceNode == boundNode) reset("Session fermée. Utilisez le téléphone.")
      return
    }
    if (type == "hello" && binding == null && pending == null && revokedSessions.allows(p, now) && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "challenge", "code", "allowedKinds")) {
      val request = WatchWire.id(p.opt("requestId")) ?: return; val session = WatchWire.id(p.opt("sessionId")) ?: return
      val device = WatchWire.id(p.opt("deviceId")) ?: return; val challenge = WatchWire.id(p.opt("challenge")) ?: return
      val kinds = WatchWire.strings(p.opt("allowedKinds")) ?: return; val code = p.opt("code") as? String ?: return
      if (!code.matches(Regex("^[0-9]{6}$"))) return
      generation += 1; boundNode = sourceNode; pending = Pending(WatchBinding(request, session, device, challenge, kinds.toSet()), code, now + WatchWire.MAX)
      haptics = false; status = "Demande du téléphone appairé"; render(); return
    }
    val s = binding ?: pending?.binding ?: return
    if (!s.matches(p) || sourceNode != boundNode) return
    if (type == "confirmed" && binding != null && !confirmed && now < confirmDeadline && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId")) {
      confirmed = true; peerSeen = now; lastPing = 0; probe = null; status = "Session autorisée. Application ouverte uniquement."; render(); return
    }
    if (!confirmed) return
    if (type == "ping" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "nonce")) {
      val nonce = WatchWire.id(p.opt("nonce")) ?: return; send(s.packet("pong", "nonce" to nonce)); return
    }
    if (type == "pong" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "nonce")) {
      val pendingProbe = probe ?: return
      if (p.opt("nonce") == pendingProbe.first && now >= pendingProbe.second && now - pendingProbe.second < 2000) { probe = null; peerSeen = now }; return
    }
    if (type == "cancel" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "deliveryId")) {
      val id = WatchWire.id(p.opt("deliveryId")) ?: return
      if (id !in seenDeliveries && seenDeliveries.size >= WatchWire.CAPACITY) { close(); return }
      seenDeliveries[id] = now + 2 * WatchWire.MAX
      waiting.remove(id); items.find { it.id == id }?.cancelled = true; return
    }
    if (type == "offer" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "deliveryId", "eventId")) {
      val id = WatchWire.id(p.opt("deliveryId")) ?: return; val eventId = WatchWire.id(p.opt("eventId")) ?: return
      if (id in seenDeliveries || eventId in seenEvents || seenDeliveries.size >= WatchWire.CAPACITY || seenEvents.size >= WatchWire.CAPACITY || waiting.size >= 16) return
      val nonce = UUID.randomUUID().toString(); seenDeliveries[id] = now + 2 * WatchWire.MAX; seenEvents[eventId] = now + 2 * WatchWire.MAX
      waiting[id] = Waiting(nonce, now, eventId); send(s.packet("resolve", "deliveryId" to id, "nonce" to nonce)); return
    }
    if (type == "event" && WatchWire.fields(p, "v", "t", "requestId", "sessionId", "deviceId", "deliveryId", "nonce", "event", "remainingTtlMs")) {
      val id = WatchWire.id(p.opt("deliveryId")) ?: return; val w = waiting[id] ?: return
      if (p.opt("nonce") != w.nonce) return
      val e = WatchWire.event(p.opt("event"), s.allowed) ?: return
      if (e.opt("eventId") != w.eventId) return
      val remaining = WatchWire.number(p.opt("remainingTtlMs")) ?: return
      waiting.remove(id); val elapsed = now - w.started
      val ttl = WatchWire.resolvedBudget(remaining, elapsed, e.getLong("expiresAt") - e.getLong("observedAt")) ?: return
      // Whole round trip is subtracted from a budget measured at the sender.
      val selectedId = items.getOrNull(current)?.id
      items.removeAll { it.forgetAt <= now }
      if (items.size >= WatchWire.CAPACITY) return
      val item = Item(id, e, now + ttl, now + ttl + WatchWire.MAX); items.add(item)
      current = items.indexOfFirst { it.id == selectedId }.takeIf { it >= 0 } ?: 0
      receipt(item, "received")
      if (items.size == 1 || selectedId == null) render() else countLabel?.text = "${items.size} observation(s) reçue(s)"
    }
  }
}
