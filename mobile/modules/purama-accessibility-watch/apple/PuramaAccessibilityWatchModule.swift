import ExpoModulesCore
import Foundation
import WatchConnectivity
import UIKit

public final class PuramaAccessibilityWatchModule: Module {
  private var link: PhoneWatchLink?
  public func definition() -> ModuleDefinition {
    Name("PuramaAccessibilityWatch")
    Events("onWatchMessage", "onWatchStatus")
    OnCreate { self.link = PhoneWatchLink(message: { [weak self] event in self?.sendEvent("onWatchMessage", ["message": WatchWire.json(event)]) }, status: { [weak self] event in self?.sendEvent("onWatchStatus", ["message": WatchWire.json(event)]) }) }
    OnDestroy { DispatchQueue.main.async { self.link?.engine.end("closed", revoked: true); self.link?.stop(); self.link = nil } }
    OnAppEntersBackground { DispatchQueue.main.async { self.link?.engine.end("foreground-required", revoked: true) } }
    Function("challenge") { UUID().uuidString }
    Function("monotonicTime") { WatchWire.now() }
    AsyncFunction("discover") { (promise: Promise) in DispatchQueue.main.async { self.link?.discover(promise) ?? promise.reject(WatchFailure("native-unavailable")) } }
    AsyncFunction("authorize") { (raw: String, promise: Promise) in DispatchQueue.main.async {
      do {
        guard UIApplication.shared.applicationState == .active, let p = WatchWire.parse(raw), WatchWire.fields(p, ["deviceId", "allowedKinds"]), let device = WatchWire.id(p["deviceId"]), let kinds = p["allowedKinds"] as? [String], let link = self.link, device == link.deviceId else { throw WatchFailure("not-authorized") }
        try link.engine.authorize(device, kinds); promise.resolve(nil)
      } catch { promise.reject(error) }
    } }
    AsyncFunction("clearAuthorization") { (promise: Promise) in DispatchQueue.main.async { self.link?.engine.end("closed", revoked: true); promise.resolve(nil) } }
    AsyncFunction("open") { (raw: String, promise: Promise) in DispatchQueue.main.async {
      do { guard UIApplication.shared.applicationState == .active, let link = self.link, link.available else { throw WatchFailure("no-device") }; try link.engine.begin(raw) { result in switch result { case .success(let value): promise.resolve(value); case .failure(let error): promise.reject(error) } } }
      catch { promise.reject(error) }
    } }
    AsyncFunction("send") { (raw: String, submittedAt: Double, promise: Promise) in DispatchQueue.main.async {
      do { guard UIApplication.shared.applicationState == .active, let link = self.link else { throw WatchFailure("native-unavailable") }; try link.engine.submit(raw, startedAt: submittedAt) { error in if let error = error { promise.reject(error) } else { promise.resolve(nil) } } }
      catch { promise.reject(error) }
    } }
    AsyncFunction("cancel") { (request: String, delivery: String, promise: Promise) in DispatchQueue.main.async { self.link?.engine.cancel(request, delivery); promise.resolve(nil) } }
    AsyncFunction("close") { (request: String, promise: Promise) in DispatchQueue.main.async { self.link?.engine.close(request); promise.resolve(nil) } }
  }
}

private final class PhoneWatchLink: NSObject, WCSessionDelegate {
  let engine = PhoneWatchProtocol()
  let deviceId = UUID().uuidString
  private var timer: DispatchSourceTimer?
  private var discovery: Promise?
  private var discoveryId: UUID?
  private var stopped = false
  var available: Bool { !stopped && WCSession.isSupported() && WCSession.default.activationState == .activated && WCSession.default.isPaired && WCSession.default.isWatchAppInstalled && WCSession.default.isReachable }
  init(message: @escaping ([String: Any]) -> Void, status: @escaping ([String: Any]) -> Void) {
    super.init(); engine.message = message
    engine.status = { [weak self] value in status(value); self?.updateTimer() }
    engine.sendWire = { [weak self] packet, done in
      guard self?.available == true else { done(WatchFailure("link-lost")); return }
      WCSession.default.sendMessage(["payload": WatchWire.json(packet)], replyHandler: nil, errorHandler: { [weak self] _ in DispatchQueue.main.async {
        guard let self = self, let s = self.engine.binding, WatchWire.bound(packet, s) else { return }
        self.engine.end("link-lost")
      } })
      // This is enqueue acceptance only. Receipts arrive exclusively through WCSessionDelegate.
      done(nil)
    }
  }
  private func updateTimer() {
    guard !stopped, engine.binding != nil else { timer?.cancel(); timer = nil; return }
    guard timer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: .milliseconds(250))
    timer.setEventHandler { [weak self] in self?.engine.tick() }
    timer.resume(); self.timer = timer
  }
  func discover(_ promise: Promise) {
    guard !stopped, UIApplication.shared.applicationState == .active, engine.binding == nil, WCSession.isSupported(), discovery == nil else { promise.reject(WatchFailure("native-unavailable")); return }
    WCSession.default.delegate = self
    if WCSession.default.activationState == .activated { promise.resolve(devices()); return }
    let token = UUID(); discoveryId = token; discovery = promise; WCSession.default.delegate = self; WCSession.default.activate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in guard let self = self, self.discoveryId == token, let pending = self.discovery else { return }; self.discovery = nil; self.discoveryId = nil; pending.reject(WatchFailure("timeout")) }
  }
  private func devices() -> [[String: String]] { available ? [["deviceId": deviceId, "name": "Apple Watch appairée", "platform": "watchos"]] : [] }
  func stop() { stopped = true; timer?.cancel(); timer = nil; discovery?.reject(WatchFailure("closed")); discovery = nil; discoveryId = nil; if WCSession.default.delegate === self { WCSession.default.delegate = nil } }
  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    DispatchQueue.main.async { let pending = self.discovery; self.discovery = nil; self.discoveryId = nil; if let error = error { pending?.reject(error) } else { pending?.resolve(self.devices()) } }
  }
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    guard WatchWire.fields(message, ["payload"]), let raw = message["payload"] as? String, let packet = WatchWire.parse(raw) else { return }
    DispatchQueue.main.async { if !self.stopped, UIApplication.shared.applicationState == .active { self.engine.receive(packet) } }
  }
  func sessionReachabilityDidChange(_ session: WCSession) { DispatchQueue.main.async { if !self.available { self.engine.end("link-lost") } } }
  func sessionWatchStateDidChange(_ session: WCSession) { DispatchQueue.main.async { self.engine.end("link-lost", revoked: true) } }
  func sessionDidBecomeInactive(_ session: WCSession) { DispatchQueue.main.async { self.engine.end("link-lost") } }
  func sessionDidDeactivate(_ session: WCSession) { DispatchQueue.main.async { self.engine.end("link-lost", revoked: true) } }
}
