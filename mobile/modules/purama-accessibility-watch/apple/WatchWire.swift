import Foundation
import CoreFoundation
import Darwin

enum WatchWire {
  static let maximum = 60_000.0
  static let capacity = 128
  static let path = "/purama/accessibility/v1"
  static let kinds = ["doorbell", "speech", "siren", "vehicle-sound", "horn", "knock", "telephone-ring", "vehicle", "sensor-unavailable"]
  static let labels = [
    "doorbell": "Sonnette possible. À vérifier.",
    "speech": "Une voix est possible. Aucun propos n’est transcrit.",
    "siren": "Sirène possible. Direction inconnue.",
    "vehicle-sound": "Bruit de véhicule possible. Position et distance inconnues.",
    "horn": "Klaxon possible. Aucun véhicule localisé.",
    "knock": "Coups possibles. Origine inconnue.",
    "telephone-ring": "Sonnerie de téléphone possible. Aucun appel identifié.",
    "vehicle": "Véhicule possible dans l’image. Aucune sécurité de passage évaluée.",
    "sensor-unavailable": "Observation indisponible. L’absence d’alerte ne signifie pas absence de danger."
  ]
  static func now() -> Double {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(mach_continuous_time()) * Double(info.numer) / Double(info.denom) / 1_000_000
  }
  static func wall() -> Double { floor(Date().timeIntervalSince1970 * 1000) }
  static func resolvedBudget(_ remaining: Double, _ elapsed: Double, _ eventLifetime: Double) -> Double? {
    guard remaining.isFinite, elapsed.isFinite, eventLifetime.isFinite, floor(remaining) == remaining,
      remaining >= 1, remaining <= maximum, remaining <= eventLifetime, elapsed >= 0, elapsed < 5000 else { return nil }
    let ttl = floor(remaining - elapsed)
    return ttl >= 1 ? ttl : nil
  }
  static func id(_ input: Any?) -> String? {
    guard let value = input as? String, value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$", options: .regularExpression) != nil else { return nil }
    return value
  }
  static func number(_ input: Any?) -> Double? {
    guard let n = input as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let v = n.doubleValue
    return v.isFinite && floor(v) == v && v >= 0 && v <= 8_640_000_000_000_000 - maximum ? v : nil
  }
  static func fields(_ value: [String: Any], _ keys: [String]) -> Bool { Set(value.keys) == Set(keys) }
  static func parse(_ input: String) -> [String: Any]? {
    guard input.utf8.count <= 4096, let data = input.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return value
  }
  static func json(_ value: [String: Any]) -> String {
    guard JSONSerialization.isValidJSONObject(value), let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), bytes.count <= 4096 else { return "{}" }
    return String(data: bytes, encoding: .utf8) ?? "{}"
  }
  static func event(_ input: Any?, allowed: Set<String>, wall: Double? = nil) -> [String: Any]? {
    guard let e = input as? [String: Any], fields(e, ["version", "eventId", "source", "kind", "observedAt", "expiresAt", "assessment"]), number(e["version"]) == 1,
      id(e["eventId"]) != nil, e["assessment"] as? String == "provisional", let source = e["source"] as? String,
      let kind = e["kind"] as? String, allowed.contains(kind), let observed = number(e["observedAt"]), let expires = number(e["expiresAt"]),
      expires > observed, expires - observed <= maximum,
      (source == "microphone" && kinds.prefix(7).contains(kind)) || (source == "camera" && kind == "vehicle") || (source == "system" && kind == "sensor-unavailable") else { return nil }
    if let wall = wall, observed > wall || expires <= wall { return nil }
    return e
  }
  static func bound(_ value: [String: Any], _ session: WatchBinding) -> Bool {
    number(value["v"]) == 1 && value["requestId"] as? String == session.requestId
      && value["sessionId"] as? String == session.sessionId && value["deviceId"] as? String == session.deviceId
  }
}

struct WatchBinding {
  let requestId: String
  let sessionId: String
  let deviceId: String
  let challenge: String
  let allowed: Set<String>
  var wire: [String: Any] { ["v": 1, "requestId": requestId, "sessionId": sessionId, "deviceId": deviceId] }
  func message(_ type: String, _ more: [String: Any] = [:]) -> [String: Any] { wire.merging(["t": type]) { _, b in b }.merging(more) { _, b in b } }
}

/** Bounded, session-scoped tombstones for reordered close/hello messages. */
final class WatchSessionRevocations {
  private var closed: [String: Double] = [:]
  private var blockedUntil = 0.0
  private func key(_ p: [String: Any]) -> String? {
    guard let request = WatchWire.id(p["requestId"]), let session = WatchWire.id(p["sessionId"]), let device = WatchWire.id(p["deviceId"]) else { return nil }
    return request + "|" + session + "|" + device
  }
  func record(_ p: [String: Any], at now: Double) {
    guard now.isFinite, now >= 0, let key = key(p) else { return }
    closed = closed.filter { $0.value > now }
    if closed[key] != nil || closed.count < WatchWire.capacity { closed[key] = now + 2 * WatchWire.maximum }
    else { blockedUntil = max(blockedUntil, now + 2 * WatchWire.maximum) }
  }
  func allows(_ p: [String: Any], at now: Double) -> Bool {
    guard now.isFinite, now >= 0, now >= blockedUntil, let key = key(p) else { return false }
    closed = closed.filter { $0.value > now }
    return closed[key] == nil
  }
}

final class PhoneWatchProtocol {
  struct Delivery { let event: [String: Any]; let deadline: Double; let forgetAt: Double; var stage = -1; var cancelled = false }
  var clock: () -> Double = WatchWire.now
  var wall: () -> Double = WatchWire.wall
  var sendWire: ([String: Any], @escaping (Error?) -> Void) -> Void = { _, done in done(WatchFailure("link-lost")) }
  var message: ([String: Any]) -> Void = { _ in }
  var status: ([String: Any]) -> Void = { _ in }
  private(set) var binding: WatchBinding?
  private var permission: (String, Set<String>)?
  private var permissionDeadline = 0.0
  private var ready: ((Result<String, Error>) -> Void)?
  private var pairingDeadline = 0.0
  private var peerSeen = 0.0
  private var probe: (String, Double)?
  private var lastProbe = 0.0
  private var deliveries: [String: Delivery] = [:]
  private var cancelled: [String: Double] = [:]
  private var closed: [String: Double] = [:]
  private var blockedUntil = 0.0
  private var lastClock = 0.0

  private func time() throws -> Double {
    let now = clock()
    guard now.isFinite, now >= lastClock, now <= 9_007_199_254_740_991 - 2 * WatchWire.maximum else { end("invalid-message"); throw WatchFailure("invalid-message") }
    lastClock = now
    return now
  }
  func authorize(_ device: String, _ kinds: [String]) throws {
    guard binding == nil, WatchWire.id(device) != nil, !kinds.isEmpty, kinds.count <= WatchWire.kinds.count,
      Set(kinds).count == kinds.count, kinds.allSatisfy(WatchWire.kinds.contains) else { throw WatchFailure("not-authorized") }
    permission = (device, Set(kinds))
    permissionDeadline = try time() + WatchWire.maximum
  }
  func begin(_ raw: String, complete: @escaping (Result<String, Error>) -> Void) throws {
    let now = try time()
    closed = closed.filter { $0.value > now }
    guard let p = WatchWire.parse(raw), WatchWire.fields(p, ["version", "type", "requestId"]), WatchWire.number(p["version"]) == 1,
      p["type"] as? String == "one-watch-handshake", let request = WatchWire.id(p["requestId"]), binding == nil,
      closed[request] == nil, now >= blockedUntil, now < permissionDeadline, let authorized = permission else { throw WatchFailure("not-authorized") }
    permission = nil
    let session = WatchBinding(requestId: request, sessionId: UUID().uuidString, deviceId: authorized.0, challenge: UUID().uuidString, allowed: authorized.1)
    binding = session; ready = complete; pairingDeadline = now + WatchWire.maximum
    let code = String(format: "%06u", arc4random_uniform(1_000_000))
    status(["state": "awaiting-watch", "requestId": request, "deviceId": session.deviceId, "pairingCode": code])
    sendWire(session.message("hello", ["challenge": session.challenge, "code": code, "allowedKinds": session.allowed.sorted()])) { [weak self] error in
      if error != nil, self?.binding?.sessionId == session.sessionId { self?.end("link-lost") }
    }
  }
  func submit(_ raw: String, startedAt: Double? = nil, complete: @escaping (Error?) -> Void) throws {
    let now = try time()
    let submitted = startedAt ?? now
    guard submitted.isFinite, submitted >= 0, submitted <= now else { throw WatchFailure("invalid-message") }
    guard ready == nil, let s = binding, let p = WatchWire.parse(raw), WatchWire.fields(p, ["version", "type", "requestId", "envelope"]),
      WatchWire.number(p["version"]) == 1, p["type"] as? String == "one-watch-send", p["requestId"] as? String == s.requestId,
      let e = p["envelope"] as? [String: Any], WatchWire.fields(e, ["version", "type", "sessionId", "deviceId", "deliveryId", "event", "remainingTtlMs"]),
      WatchWire.number(e["version"]) == 1, e["type"] as? String == "one-awareness-delivery", e["sessionId"] as? String == s.sessionId, e["deviceId"] as? String == s.deviceId,
      let id = WatchWire.id(e["deliveryId"]), let event = WatchWire.event(e["event"], allowed: s.allowed, wall: wall()),
      let budget = WatchWire.number(e["remainingTtlMs"]), budget >= 1, budget <= WatchWire.maximum else { throw WatchFailure("invalid-message") }
    deliveries = deliveries.filter { $0.value.forgetAt > now }
    cancelled = cancelled.filter { $0.value > now }
    guard cancelled[id] == nil else { throw WatchFailure("closed") }
    guard deliveries.count < WatchWire.capacity, deliveries[id] == nil,
      !deliveries.values.contains(where: { $0.event["eventId"] as? String == event["eventId"] as? String }) else { throw WatchFailure("capacity") }
    let ttl = floor(min(budget - (now - submitted), (event["expiresAt"] as! Double) - wall()))
    guard ttl >= 1 else { throw WatchFailure("timeout") }
    deliveries[id] = Delivery(event: event, deadline: now + ttl, forgetAt: now + ttl + WatchWire.maximum)
    sendWire(s.message("offer", ["deliveryId": id, "eventId": event["eventId"]!])) { [weak self] error in
      if error != nil, self?.binding?.sessionId == s.sessionId { self?.cancel(s.requestId, id) }
      complete(error)
    }
  }
  func receive(_ p: [String: Any]) {
    guard let now = try? time(), let s = binding, WatchWire.bound(p, s), let kind = p["t"] as? String else { return }
    if kind == "accepted", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "challenge"]), p["challenge"] as? String == s.challenge,
      let done = ready, now < pairingDeadline {
      ready = nil; peerSeen = now
      sendWire(s.message("confirmed")) { [weak self] error in if error != nil, self?.binding?.sessionId == s.sessionId { self?.end("link-lost") } }
      guard binding?.sessionId == s.sessionId else { done(.failure(WatchFailure("link-lost"))); return }
      done(.success(WatchWire.json(["version": 1, "type": "one-watch-ready", "requestId": s.requestId, "binding": ["version": 1, "sessionId": s.sessionId, "deviceId": s.deviceId, "platform": "watchos"]])))
      status(["state": "connected", "requestId": s.requestId, "deviceId": s.deviceId]); return
    }
    if kind == "close", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId"]) { end(ready == nil ? "closed" : "watch-declined"); return }
    guard ready == nil else { return }
    if kind == "ping", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "nonce"]), let nonce = WatchWire.id(p["nonce"]) {
      sendWire(s.message("pong", ["nonce": nonce])) { _ in }; return
    }
    if kind == "pong", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "nonce"]), let pending = probe,
      p["nonce"] as? String == pending.0, now >= pending.1, now - pending.1 < 2000 {
      probe = nil; peerSeen = now; return
    }
    if kind == "resolve", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "deliveryId", "nonce"]), let id = WatchWire.id(p["deliveryId"]),
      let nonce = WatchWire.id(p["nonce"]), let d = deliveries[id], !d.cancelled, now < d.deadline {
      let left = floor(min(d.deadline - now, (d.event["expiresAt"] as! Double) - wall()))
      if left >= 1 { sendWire(s.message("event", ["deliveryId": id, "nonce": nonce, "event": d.event, "remainingTtlMs": left])) { _ in } }
      return
    }
    if kind == "receipt", WatchWire.fields(p, ["v", "t", "requestId", "sessionId", "deviceId", "receipt"]), let r = p["receipt"] as? [String: Any],
      WatchWire.fields(r, ["version", "type", "sessionId", "deviceId", "deliveryId", "eventId", "stage"]), WatchWire.number(r["version"]) == 1,
      r["type"] as? String == "one-awareness-receipt", r["sessionId"] as? String == s.sessionId, r["deviceId"] as? String == s.deviceId,
      let id = WatchWire.id(r["deliveryId"]), var d = deliveries[id], !d.cancelled, now < d.deadline, (d.event["expiresAt"] as! Double) > wall(),
      r["eventId"] as? String == d.event["eventId"] as? String, let stage = r["stage"] as? String,
      let rank = ["received", "displayed", "acknowledged"].firstIndex(of: stage), rank > d.stage {
      d.stage = rank; deliveries[id] = d
      message(["version": 1, "type": "one-watch-receipt", "requestId": s.requestId, "receipt": r])
    }
  }
  func tick() {
    guard let now = try? time() else { return }
    if ready != nil, now >= pairingDeadline { end("timeout") }
    else if let s = binding, ready == nil {
      if now - peerSeen >= 6000 { end("link-lost") }
      else if now - lastProbe >= 2000 {
        lastProbe = now; let nonce = UUID().uuidString; probe = (nonce, now)
        sendWire(s.message("ping", ["nonce": nonce])) { _ in }
      }
    }
  }
  func cancel(_ request: String, _ id: String) {
    guard let now = try? time(), let s = binding, s.requestId == request, WatchWire.id(id) != nil else { return }
    cancelled = cancelled.filter { $0.value > now }
    guard cancelled[id] != nil || cancelled.count < WatchWire.capacity else { end("capacity"); return }
    // Expo work can be reordered. Remember cancellation even before submit.
    cancelled[id] = now + 2 * WatchWire.maximum
    if var d = deliveries[id] { d.cancelled = true; deliveries[id] = d }
    sendWire(s.message("cancel", ["deliveryId": id])) { _ in }
  }
  func close(_ request: String) {
    let now = clock()
    closed = closed.filter { $0.value > now }
    if closed.count < WatchWire.capacity { closed[request] = now + WatchWire.maximum } else { blockedUntil = max(blockedUntil, now + WatchWire.maximum) }
    if binding?.requestId == request { end("closed") }
  }
  func end(_ why: String, revoked: Bool = false) {
    permission = nil
    guard let s = binding else { return }
    binding = nil; let done = ready; ready = nil; probe = nil; lastProbe = 0; deliveries.removeAll(); cancelled.removeAll()
    let now = clock()
    if closed.count < WatchWire.capacity { closed[s.requestId] = now + WatchWire.maximum } else { blockedUntil = max(blockedUntil, now + WatchWire.maximum) }
    sendWire(s.message("close")) { _ in }
    done?(.failure(WatchFailure(why)))
    message(["version": 1, "type": revoked ? "one-watch-revoked" : "one-watch-disconnected", "requestId": s.requestId])
    status(["state": revoked ? "revoked" : "disconnected", "requestId": s.requestId, "reason": why])
  }
}

struct WatchFailure: Error, LocalizedError {
  let reason: String
  init(_ reason: String) { self.reason = reason }
  var errorDescription: String? { reason }
}
