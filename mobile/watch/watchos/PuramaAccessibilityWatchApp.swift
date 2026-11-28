import SwiftUI
import WatchKit
import WatchConnectivity

@main
struct PuramaAccessibilityWatchApp: App {
  @StateObject private var model = AccessibilityWatchModel()
  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup {
      WatchContent(model: model)
        .onChange(of: scenePhase) { phase in model.setActive(phase == .active) }
        .onAppear { model.setActive(scenePhase == .active) }
    }
  }
}

private struct WatchContent: View {
  @ObservedObject var model: AccessibilityWatchModel
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text("PURAMA").font(.headline)
        Text(model.status).font(.body)
        if let pending = model.pending {
          Text("Comparez ce code avec le téléphone :").font(.body)
          Text(pending.code).font(.title2).accessibilityLabel("Code : " + pending.code.map(String.init).joined(separator: " "))
          Text(pending.binding.allowed.sorted().compactMap { WatchWire.labels[$0] }.joined(separator: "\n"))
          Toggle("Vibrations de cette session", isOn: $model.haptics)
          Button("Autoriser cette session") { model.accept() }
          Button("Refuser", role: .cancel) { model.close() }
        } else if model.binding != nil {
          if let item = model.selected {
            Text(WatchWire.labels[item.event["kind"] as? String ?? ""] ?? "Observation à vérifier")
              .id(item.id)
              .background(GeometryReader { geometry in
                Color.clear
                  .onAppear { DispatchQueue.main.async { model.display(item.id, frame: geometry.frame(in: .global)) } }
                  .onChange(of: geometry.frame(in: .global)) { frame in model.display(item.id, frame: frame) }
              })
            Text(model.isFresh(item) ? "Observation provisoire" : "Expirée — ne plus agir sur ce signal")
            Button("J’ai compris") { model.acknowledge(item.id) }.disabled(!model.isFresh(item) || item.stage != 1)
            Button("Observation suivante") { model.next() }.disabled(model.items.count < 2)
          } else { Text("Aucune observation reçue.") }
          Text("Le téléphone reste le recours. Aucun guidage de déplacement.").font(.footnote)
          Button("Déconnecter", role: .destructive) { model.close() }
        }
      }.padding()
    }
  }
}

final class AccessibilityWatchModel: NSObject, ObservableObject, WCSessionDelegate {
  struct Pending { let binding: WatchBinding; let code: String; let deadline: Double }
  struct Waiting { let nonce: String; let started: Double; let eventId: String }
  struct Item { let id: String; let event: [String: Any]; let deadline: Double; let forgetAt: Double; var stage = 0; var cancelled = false }
  @Published var pending: Pending?
  @Published var binding: WatchBinding?
  @Published var status = "Ouvrez la connexion montre sur le téléphone."
  @Published var haptics = false
  @Published var items: [Item] = []
  @Published var current = 0
  @Published var now = WatchWire.now()
  private var active = false
  private var waiting: [String: Waiting] = [:]
  private var seenDeliveries: [String: Double] = [:]
  private var seenEvents: [String: Double] = [:]
  private var confirmed = false
  private var confirmDeadline = 0.0
  private var peerSeen = 0.0
  private var lastPing = 0.0
  private var probe: (String, Double)?
  private var generation = 0
  private let revokedSessions = WatchSessionRevocations()
  private var timer: Timer?
  var selected: Item? { items.indices.contains(current) ? items[current] : nil }
  func isFresh(_ item: Item) -> Bool { active && confirmed && !item.cancelled && WatchWire.now() < item.deadline }
  func setActive(_ value: Bool) {
    if active == value { return }; active = value
    if value {
      WCSession.default.delegate = self; WCSession.default.activate()
      timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
    } else { close(); timer?.invalidate(); timer = nil }
  }
  private func send(_ packet: [String: Any]) {
    let token = generation
    guard WCSession.default.activationState == .activated, WCSession.default.isReachable else { reset("Liaison perdue. Utilisez le téléphone."); return }
    WCSession.default.sendMessage(["payload": WatchWire.json(packet)], replyHandler: nil, errorHandler: { [weak self] _ in DispatchQueue.main.async {
      guard let self = self, self.generation == token, let s = self.binding ?? self.pending?.binding, WatchWire.bound(packet, s) else { return }
      self.reset("Liaison perdue. Utilisez le téléphone.")
    } })
  }
  private func reset(_ message: String) {
    if let s = binding ?? pending?.binding { revokedSessions.record(s.message("close"), at: WatchWire.now()) }
    generation += 1; binding = nil; pending = nil; confirmed = false; haptics = false; probe = nil; lastPing = 0
    waiting.removeAll(); items.removeAll(); seenDeliveries.removeAll(); seenEvents.removeAll(); current = 0; status = message
  }
  func close() {
    if let s = binding ?? pending?.binding { send(s.message("close")) }
    reset("Déconnectée. Utilisez le téléphone.")
  }
  func accept() {
    guard active, let p = pending, WatchWire.now() < p.deadline else { close(); return }
    pending = nil; binding = p.binding; confirmed = false; confirmDeadline = WatchWire.now() + 5000
    status = "Confirmation du téléphone en cours…"
    send(p.binding.message("accepted", ["challenge": p.binding.challenge]))
  }
  private func receipt(_ item: Item, _ stage: String) {
    guard let s = binding, isFresh(item) else { return }
    send(s.message("receipt", ["receipt": ["version": 1, "type": "one-awareness-receipt", "sessionId": s.sessionId,
      "deviceId": s.deviceId, "deliveryId": item.id, "eventId": item.event["eventId"]!, "stage": stage]]))
  }
  func display(_ id: String, frame: CGRect) {
    let visible = frame.intersection(WKInterfaceDevice.current().screenBounds)
    guard !visible.isNull, visible.width > 0, visible.height > 0, WKExtension.shared().applicationState == .active,
      active, let i = items.firstIndex(where: { $0.id == id }), i == current, items[i].stage == 0, isFresh(items[i]) else { return }
    items[i].stage = 1; receipt(items[i], "displayed")
    if haptics, WKExtension.shared().applicationState == .active { WKInterfaceDevice.current().play(.notification) }
  }
  func acknowledge(_ id: String) {
    guard let i = items.firstIndex(where: { $0.id == id }), i == current, items[i].stage == 1, isFresh(items[i]) else { return }
    items[i].stage = 2; receipt(items[i], "acknowledged")
  }
  func next() { guard !items.isEmpty else { return }; current = (current + 1) % items.count }
  private func tick() {
    let fresh = WatchWire.now()
    if fresh < now { close(); return }; now = fresh
    if let p = pending, now >= p.deadline { close() }
    if binding != nil, !confirmed, now >= confirmDeadline { close() }
    if let s = binding, confirmed {
      if now - peerSeen >= 6000 { close(); return }
      if now - lastPing >= 2000 { lastPing = now; let nonce = UUID().uuidString; probe = (nonce, now); send(s.message("ping", ["nonce": nonce])) }
    }
    waiting = waiting.filter { now - $0.value.started < 5000 }
    seenDeliveries = seenDeliveries.filter { $0.value > now }
    seenEvents = seenEvents.filter { $0.value > now }
  }
  private func receive(_ p: [String: Any]) {
    guard active, WatchWire.number(p["v"]) == 1, let type = p["t"] as? String else { return }
    let instant = WatchWire.now()
    if type == "close", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId"]),
      WatchWire.id(p["requestId"]) != nil, WatchWire.id(p["sessionId"]) != nil, WatchWire.id(p["deviceId"]) != nil {
      revokedSessions.record(p, at: instant)
      if let s = binding ?? pending?.binding, WatchWire.bound(p, s) { reset("Session fermée. Utilisez le téléphone.") }
      return
    }
    if type == "hello", binding == nil, pending == nil,
      revokedSessions.allows(p, at: instant),
      WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "challenge", "code", "allowedKinds"]),
      let request = WatchWire.id(p["requestId"]), let session = WatchWire.id(p["sessionId"]), let device = WatchWire.id(p["deviceId"]),
      let challenge = WatchWire.id(p["challenge"]), let code = p["code"] as? String, code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil,
      let kinds = p["allowedKinds"] as? [String], !kinds.isEmpty, kinds.count <= WatchWire.kinds.count, Set(kinds).count == kinds.count, kinds.allSatisfy(WatchWire.kinds.contains) {
      pending = Pending(binding: WatchBinding(requestId: request, sessionId: session, deviceId: device, challenge: challenge, allowed: Set(kinds)), code: code, deadline: instant + WatchWire.maximum)
      generation += 1; haptics = false; status = "Demande du téléphone appairé"; return
    }
    guard let s = binding ?? pending?.binding, WatchWire.bound(p, s) else { return }
    if type == "confirmed", binding != nil, !confirmed, instant < confirmDeadline, WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId"]) {
      confirmed = true; peerSeen = instant; lastPing = 0; probe = nil; status = "Session autorisée. Application ouverte uniquement."; return
    }
    guard confirmed else { return }
    if type == "ping", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "nonce"]), let nonce = WatchWire.id(p["nonce"]) {
      send(s.message("pong", ["nonce": nonce])); return
    }
    if type == "pong", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "nonce"]), let pendingProbe = probe,
      p["nonce"] as? String == pendingProbe.0, instant >= pendingProbe.1, instant - pendingProbe.1 < 2000 {
      probe = nil; peerSeen = instant; return
    }
    if type == "cancel", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "deliveryId"]), let id = WatchWire.id(p["deliveryId"]) {
      guard seenDeliveries[id] != nil || seenDeliveries.count < WatchWire.capacity else { close(); return }
      seenDeliveries[id] = instant + 2 * WatchWire.maximum
      waiting[id] = nil
      if let i = items.firstIndex(where: { $0.id == id }) { items[i].cancelled = true }
      return
    }
    if type == "offer", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "deliveryId", "eventId"]),
      let id = WatchWire.id(p["deliveryId"]), let event = WatchWire.id(p["eventId"]), seenDeliveries[id] == nil, seenEvents[event] == nil,
      seenDeliveries.count < WatchWire.capacity, seenEvents.count < WatchWire.capacity, waiting.count < 16 {
      let nonce = UUID().uuidString
      seenDeliveries[id] = instant + 2 * WatchWire.maximum; seenEvents[event] = instant + 2 * WatchWire.maximum
      waiting[id] = Waiting(nonce: nonce, started: instant, eventId: event)
      send(s.message("resolve", ["deliveryId": id, "nonce": nonce])); return
    }
    if type == "event", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "deliveryId", "nonce", "event", "remainingTtlMs"]),
      let id = WatchWire.id(p["deliveryId"]), let w = waiting[id], p["nonce"] as? String == w.nonce,
      let event = WatchWire.event(p["event"], allowed: s.allowed), event["eventId"] as? String == w.eventId,
      let remaining = WatchWire.number(p["remainingTtlMs"]), remaining <= WatchWire.maximum {
      waiting[id] = nil
      let elapsed = instant - w.started
      guard let ttl = WatchWire.resolvedBudget(remaining, elapsed, (WatchWire.number(event["expiresAt"]) ?? 0) - (WatchWire.number(event["observedAt"]) ?? 0)) else { return }
      // Subtract the entire local resolve round trip: queue and transit never restart TTL.
      let selectedId = selected?.id
      items = items.filter { $0.forgetAt > instant }
      guard items.count < WatchWire.capacity else { return }
      let item = Item(id: id, event: event, deadline: instant + ttl, forgetAt: instant + ttl + WatchWire.maximum)
      items.append(item); current = items.firstIndex(where: { $0.id == selectedId }) ?? 0; receipt(item, "received")
    }
  }
  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) { if error != nil { DispatchQueue.main.async { if session.activationState != .activated { self.reset("Montre indisponible. Utilisez le téléphone.") } } } }
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    guard WatchWire.fields(message, ["payload"]), let raw = message["payload"] as? String, let packet = WatchWire.parse(raw) else { return }
    DispatchQueue.main.async { self.receive(packet) }
  }
  func sessionReachabilityDidChange(_ session: WCSession) { DispatchQueue.main.async { if !session.isReachable { self.reset("Liaison perdue. Utilisez le téléphone.") } } }
}
