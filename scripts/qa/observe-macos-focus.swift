import AppKit
import ApplicationServices
import Foundation

// Read-only OS observation; no activation, window titles, content, or input capture.
// Usage: xcrun swift scripts/qa/observe-macos-focus.swift [seconds]
guard CommandLine.arguments.count <= 2,
      let duration = Double(CommandLine.arguments.dropFirst().first ?? "300"),
      duration.isFinite, duration > 0 else {
    FileHandle.standardError.write(Data("Usage: observe-macos-focus.swift [positive seconds]\n".utf8))
    exit(2)
}

let workspace = NSWorkspace.shared
let started = ProcessInfo.processInfo.systemUptime
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let trusted = AXIsProcessTrusted()
var knownWindows: [AXUIElement] = []
var lastState = ""

func appInfo(_ app: NSRunningApplication?) -> [String: Any] {
    guard let app else { return ["pid": NSNull(), "bundleId": NSNull()] }
    return ["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier as Any? ?? NSNull()]
}

func focusedWindow() -> [String: Any] {
    guard trusted, let foreground = workspace.frontmostApplication else { return ["available": false] }
    let pid = foreground.processIdentifier
    let app = AXUIElementCreateApplication(pid)
    var windowValue: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowValue)
    guard status == .success, let windowValue else {
        return ["available": false, "pid": Int(pid), "error": status.rawValue]
    }
    let window = windowValue as! AXUIElement
    let index: Int
    if let found = knownWindows.firstIndex(where: { CFEqual($0, window) }) { index = found }
    else { index = knownWindows.count; knownWindows.append(window) }
    return ["available": true, "pid": Int(pid), "windowToken": index + 1]
}

func emit(_ event: String, activated: NSRunningApplication? = nil) {
    var record: [String: Any] = ["event": event, "utc": iso.string(from: Date()),
        "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
        "frontmost": appInfo(workspace.frontmostApplication), "focusedWindow": focusedWindow()]
    if let activated { record["activated"] = appInfo(activated) }
    if event == "observer_started" { record["axTrusted"] = trusted; record["observerPid"] = Int(ProcessInfo.processInfo.processIdentifier) }
    if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

let observer = workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
    object: nil, queue: .main) { notification in
    emit("didActivateApplication", activated: notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
emit("observer_started")
let sampleTimer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { _ in
    let info: [String: Any] = ["frontmost": appInfo(workspace.frontmostApplication), "focusedWindow": focusedWindow()]
    let state = String(data: (try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? ""
    if state != lastState { lastState = state; emit("sample_changed") }
}
let heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in emit("heartbeat") }
RunLoop.main.run(until: Date(timeIntervalSinceNow: duration))
workspace.notificationCenter.removeObserver(observer)
sampleTimer.invalidate()
heartbeat.invalidate()
emit("observer_stopped")
