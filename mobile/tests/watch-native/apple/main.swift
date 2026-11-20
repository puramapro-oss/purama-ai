import Foundation

var checks = 0
func check(_ name: String, _ body: () throws -> Void) {
  do { try body(); checks += 1; print("PASS \(name)") }
  catch { print("FAIL \(name): \(error)"); exit(1) }
}
func expect(_ value: @autoclosure () -> Bool) throws { if !value() { throw WatchFailure("assertion") } }
func refused(_ action: () throws -> Void) throws {
  do { try action() } catch { return }
  throw WatchFailure("expected-refusal")
}
final class Harness {
  var now = 1000.0
  var wall = 1000.0
  var packets: [[String: Any]] = []
  var receipts: [[String: Any]] = []
  var result: Result<String, Error>?
  let phone = PhoneWatchProtocol()
  init() {
    phone.clock = { [unowned self] in self.now }; phone.wall = { [unowned self] in self.wall }
    phone.sendWire = { [unowned self] packet, complete in self.packets.append(packet); complete(nil) }
    phone.message = { [unowned self] in self.receipts.append($0) }
  }
  func begin(_ request: String = "request-1") throws {
    try phone.authorize("device-1", ["speech"])
    try phone.begin(WatchWire.json(["version": 1, "type": "one-watch-handshake", "requestId": request])) { [unowned self] in self.result = $0 }
  }
  func connected() throws { try begin(); let s = phone.binding!; phone.receive(s.message("accepted", ["challenge": s.challenge])) }
  func send(_ id: String = "delivery-1", eventID: String = "event-1", source: String = "microphone", remaining: Double = 5000, startedAt: Double? = nil) throws {
    let s = phone.binding!
    let event: [String: Any] = ["version": 1, "eventId": eventID, "source": source, "kind": "speech", "observedAt": wall, "expiresAt": wall + 5000, "assessment": "provisional"]
    try phone.submit(WatchWire.json(["version": 1, "type": "one-watch-send", "requestId": s.requestId,
      "envelope": ["version": 1, "type": "one-awareness-delivery", "sessionId": s.sessionId, "deviceId": s.deviceId, "deliveryId": id, "event": event, "remainingTtlMs": remaining]]), startedAt: startedAt) { _ in }
  }
  func resolve(_ id: String = "delivery-1") { if let s = phone.binding { phone.receive(s.message("resolve", ["deliveryId": id, "nonce": "fresh-nonce"])) } }
}
check("explicit permission required") { let h = Harness(); try refused { try h.phone.begin("{}") { _ in } }; try expect(h.packets.isEmpty) }
check("authorization is one-use and expires") {
  let h = Harness(); try h.phone.authorize("device-1", ["speech"]); h.now += 60_000
  try refused { try h.phone.begin(WatchWire.json(["version": 1, "type": "one-watch-handshake", "requestId": "r"])) { _ in } }
}
check("enqueue is neither consent nor ready") { let h = Harness(); try h.begin(); try expect(h.result == nil); try expect(h.packets.count == 1) }
check("incorrect challenge cannot connect") { let h = Harness(); try h.begin(); let s = h.phone.binding!; h.phone.receive(s.message("accepted", ["challenge": "wrong"])); try expect(h.result == nil) }
check("real accepted packet produces exactly the ONE binding") { let h = Harness(); try h.connected(); let raw = try h.result!.get(); let result = WatchWire.parse(raw)!; try expect(result["type"] as? String == "one-watch-ready"); try expect(h.packets.last?["t"] as? String == "confirmed") }
check("no fabricated receipt after dispatch") { let h = Harness(); try h.connected(); try h.send(); try expect(h.receipts.isEmpty); try expect(h.packets.last?["t"] as? String == "offer") }
check("resolution subtracts queue time") { let h = Harness(); try h.connected(); try h.send(); h.now += 1500; h.wall += 1500; h.resolve(); try expect(WatchWire.number(h.packets.last?["remainingTtlMs"]) == 3500) }
check("exact deadline cannot deliver") { let h = Harness(); try h.connected(); try h.send(); h.now += 5000; let count = h.packets.count; h.resolve(); try expect(h.packets.count == count) }
check("cancel invalidates pending resolution") { let h = Harness(); try h.connected(); try h.send(); h.phone.cancel("request-1", "delivery-1"); let count = h.packets.count; h.resolve(); try expect(h.packets.count == count) }
check("delivery and event replay are refused") { let h = Harness(); try h.connected(); try h.send(); try refused { try h.send() }; try refused { try h.send("second", eventID: "event-1") } }
check("simulations cannot enter native transport") { let h = Harness(); try h.connected(); try refused { try h.send(source: "simulation") } }
check("close before delayed open is fail closed") { let h = Harness(); h.phone.close("request-1"); try refused { try h.begin() }; try expect(h.phone.binding == nil) }
check("close rejects pending handshake and late acceptance") { let h = Harness(); try h.begin(); let old = h.phone.binding!; h.phone.close("request-1"); try refused { _ = try h.result!.get() }; h.phone.receive(old.message("accepted", ["challenge": old.challenge])); try expect(h.phone.binding == nil) }
check("handshake timeout is separate from observation TTL") { let h = Harness(); try h.begin(); h.now += 59_999; h.phone.tick(); try expect(h.result == nil); h.now += 1; h.phone.tick(); try refused { _ = try h.result!.get() } }
check("clock rollback revokes the live session") { let h = Harness(); try h.connected(); h.now = 999; try refused { try h.send() }; try expect(h.phone.binding == nil) }
check("bounded replay memory refuses excess live records") { let h = Harness(); try h.connected(); for i in 0..<128 { try h.send("delivery-\(i)", eventID: "event-\(i)") }; try refused { try h.send("overflow", eventID: "overflow") } }
check("receiver subtracts entire round trip") { try expect(WatchWire.resolvedBudget(4000, 1500, 5000) == 2500) }
check("receiver rejects stale replies and impossible budget") { try expect(WatchWire.resolvedBudget(5000, 5000, 5000) == nil); try expect(WatchWire.resolvedBudget(6000, 1, 5000) == nil); try expect(WatchWire.resolvedBudget(5000, -1, 5000) == nil) }
check("numeric booleans and extra event claims are refused") { try expect(WatchWire.number(true) == nil); try expect(WatchWire.event(["version": 1, "direction": "cross"], allowed: ["speech"]) == nil) }
check("Expo queue age is subtracted before a delivery is stored") { let h = Harness(); try h.connected(); h.now = 1800; h.wall = 1800; try h.send(remaining: 1000, startedAt: 1000); h.resolve(); try expect(WatchWire.number(h.packets.last?["remainingTtlMs"]) == 200) }
check("Expo queue cannot restart an exhausted budget or accept a future clock") { let h = Harness(); try h.connected(); h.now = 2000; try refused { try h.send(remaining: 1000, startedAt: 1000) }; try refused { try h.send(startedAt: 2001) } }
check("cancel before submit survives reordered Expo work") { let h = Harness(); try h.connected(); h.phone.cancel("request-1", "delivery-1"); try refused { try h.send() }; try expect(h.packets.allSatisfy { $0["t"] as? String != "offer" }) }
check("early cancellation memory is bounded and fails closed") { let h = Harness(); try h.connected(); for i in 0..<129 { h.phone.cancel("request-1", "cancel-\(i)") }; try expect(h.phone.binding == nil) }
check("late failure from A cannot cancel or close B") {
  let h = Harness(); try h.connected(); var delayed: ((Error?) -> Void)?
  h.phone.sendWire = { packet, done in h.packets.append(packet); if packet["t"] as? String == "offer" { delayed = done } else { done(nil) } }
  try h.send(); h.phone.close("request-1"); h.now += 1; try h.begin("request-2"); let s = h.phone.binding!; h.phone.receive(s.message("accepted", ["challenge": s.challenge]))
  delayed?(WatchFailure("link-lost")); try expect(h.phone.binding?.sessionId == s.sessionId)
}
check("lost peer or lost close expires after six seconds") { let h = Harness(); try h.connected(); h.now += 5999; h.phone.tick(); try expect(h.phone.binding != nil); h.now += 1; h.phone.tick(); try expect(h.phone.binding == nil) }
check("only a fresh response to our nonce extends the peer lease") {
  let h = Harness(); try h.connected(); let s = h.phone.binding!; h.now = 3000; h.phone.tick(); let nonce = h.packets.last!["nonce"] as! String
  h.now = 3500; h.phone.receive(s.message("pong", ["nonce": nonce])); h.now = 7000; h.phone.tick(); try expect(h.phone.binding != nil)
  h.now = 9500; h.phone.tick(); try expect(h.phone.binding == nil)
}
check("wrong nonce, replay, late pong and incoming ping cannot extend lease") {
  for variant in ["wrong", "late", "ping", "replay"] {
    let h = Harness(); try h.connected(); let s = h.phone.binding!; h.now = 3000; h.phone.tick(); let nonce = h.packets.last!["nonce"] as! String
    if variant == "replay" { h.now = 3100; h.phone.receive(s.message("pong", ["nonce": nonce])); h.now = 5000; h.phone.tick(); h.now = 6000 }
    else { h.now = variant == "late" ? 5000 : 3500 }
    h.phone.receive(s.message(variant == "ping" ? "ping" : "pong", ["nonce": variant == "wrong" ? "wrong" : nonce]))
    h.now = variant == "replay" ? 9100 : 7000; h.phone.tick(); try expect(h.phone.binding == nil)
  }
}
check("close before hello is remembered for exactly its bound session") {
  let memory = WatchSessionRevocations(); let a = WatchBinding(requestId: "a", sessionId: "s1", deviceId: "d", challenge: "c", allowed: ["speech"])
  memory.record(a.message("close"), at: 1000); try expect(!memory.allows(a.message("hello"), at: 1001))
  let b = WatchBinding(requestId: "a", sessionId: "s2", deviceId: "d", challenge: "c", allowed: ["speech"])
  try expect(memory.allows(b.message("hello"), at: 1001)); try expect(memory.allows(a.message("hello"), at: 121000))
}
check("watch session tombstones fail closed at bounded capacity") {
  let memory = WatchSessionRevocations()
  for i in 0..<129 { memory.record(["requestId": "r\(i)", "sessionId": "s", "deviceId": "d"], at: 1000) }
  let novel: [String: Any] = ["requestId": "new", "sessionId": "s", "deviceId": "d"]
  try expect(!memory.allows(novel, at: 1001)); try expect(memory.allows(novel, at: 121000))
}
print(WatchWire.json(["status": "PASS", "checks": checks, "scope": "Compiled Swift protocol tests; no watch hardware, UI or haptic perception tested"]))
