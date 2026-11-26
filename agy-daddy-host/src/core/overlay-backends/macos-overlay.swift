import Cocoa
import CoreGraphics
import Darwin
import Foundation

// MARK: - Wire Models

struct OverlayBounds: Decodable {
  let x: Double?
  let y: Double?
  let width: Double?
  let height: Double?
}

struct OverlayViewBox: Decodable {
  let width: Double
  let height: Double
}

struct OverlayHitBox: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct OverlayMotionSpec: Decodable {
  let bobAmpY: Double?
  let bobFreqHz: Double?
  let swayAmpX: Double?
  let swayFreqHz: Double?
  let rotAmpDeg: Double?
  let rotFreqHz: Double?
  let phaseRad: Double?
  let blinkIntervalMs: Double?
  let states: [String]?
}

struct OverlaySpriteFrameRect: Decodable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
}

struct OverlaySceneLayer: Decodable {
  let id: String
  let kind: String
  let d: String?
  let cx: Double?
  let cy: Double?
  let r: Double?
  let rx: Double?
  let ry: Double?
  let x: Double?
  let y: Double?
  let width: Double?
  let height: Double?
  let cornerRadius: Double?
  let spritePath: String?
  let frameRects: [OverlaySpriteFrameRect]?
  let fill: String?
  let stroke: String?
  let strokeWidth: Double?
  let opacity: Double?
  let pivotX: Double?
  let pivotY: Double?
  let motion: OverlayMotionSpec?
}

struct OverlayParticlesSpec: Decodable {
  let preset: String?
  let color: String?
}

struct OverlayFpsSpec: Decodable {
  let active: Double?
  let idle: Double?
  let sleep: Double?
}

struct OverlaySceneSpec: Decodable {
  let sceneId: String
  let viewBox: OverlayViewBox
  let fps: OverlayFpsSpec?
  let hitBox: OverlayHitBox
  let layers: [OverlaySceneLayer]
  let particles: OverlayParticlesSpec?
}

struct OverlayRoamSpec: Decodable {
  let enabled: Bool?
  let mode: String?
  let baseSpeedPxPerSec: Double?
}

struct OverlayStatusPill: Decodable {
  let text: String
  let tone: String?
}

struct OverlayBubbleSpec: Decodable {
  let id: String
  let kind: String
  let title: String
  let subtitle: String?
  let badge: String?
  let accentHex: String?
  let dismissible: Bool?
}

struct OverlayContextMenuItem: Decodable {
  let id: String
  let type: String?
  let label: String?
  let checked: Bool?
  let enabled: Bool?
}

struct OverlayRuntimeState: Decodable {
  let animState: String?
  let speedFactor: Double?
  let tps: Double?
  let roam: OverlayRoamSpec?
  let scale: Double?
  let flipX: Bool?
  let statusPill: OverlayStatusPill?
  let bubble: OverlayBubbleSpec?
  let contextMenu: [OverlayContextMenuItem]?
}

struct OverlayCommand: Decodable {
  let type: String
  let windowId: String?
  let bounds: OverlayBounds?
  let visible: Bool?
  let scene: OverlaySceneSpec?
  let state: OverlayRuntimeState?
}

// MARK: - Helpers

func connectUnixSocket(_ socketPath: String) -> Int32? {
  let pathBytes = Array(socketPath.utf8)
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
  guard pathBytes.count < maxLen else { return nil }
  let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }
  addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
    rawBuf.initializeMemory(as: UInt8.self, repeating: 0)
    for (idx, byte) in pathBytes.enumerated() {
      rawBuf[idx] = byte
    }
  }
  let res = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
      Darwin.connect(fd, saPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if res != 0 {
    Darwin.close(fd)
    return nil
  }
  return fd
}

func nsColorFromHex(_ hexStr: String?, fallback: NSColor = .clear) -> NSColor {
  guard let raw = hexStr?.trimmingCharacters(in: .whitespacesAndNewlines),
        raw.hasPrefix("#") else {
    return fallback
  }
  let hex = String(raw.dropFirst())
  var val: UInt64 = 0
  guard Scanner(string: hex).scanHexInt64(&val) else { return fallback }
  if hex.count == 6 {
    let r = CGFloat((val >> 16) & 0xff) / 255.0
    let g = CGFloat((val >> 8) & 0xff) / 255.0
    let b = CGFloat(val & 0xff) / 255.0
    return NSColor(srgbRed: r, green: g, blue: b, alpha: 1.0)
  } else if hex.count == 8 {
    let r = CGFloat((val >> 24) & 0xff) / 255.0
    let g = CGFloat((val >> 16) & 0xff) / 255.0
    let b = CGFloat((val >> 8) & 0xff) / 255.0
    let a = CGFloat(val & 0xff) / 255.0
    return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
  }
  return fallback
}

func parseSvgPath(_ d: String) -> CGPath {
  let path = CGMutablePath()
  var tokens: [String] = []
  var cur = ""
  let cmdSet = CharacterSet(charactersIn: "MLHVCSQTAZmlhvcsqtaz")
  for scalar in d.unicodeScalars {
    if cmdSet.contains(scalar) {
      if !cur.isEmpty { tokens.append(cur); cur = "" }
      tokens.append(String(scalar))
    } else if scalar == "," || CharacterSet.whitespacesAndNewlines.contains(scalar) {
      if !cur.isEmpty { tokens.append(cur); cur = "" }
    } else if scalar == "-" && !cur.isEmpty && !cur.hasSuffix("e") && !cur.hasSuffix("E") {
      tokens.append(cur)
      cur = "-"
    } else {
      cur.append(Character(scalar))
    }
  }
  if !cur.isEmpty { tokens.append(cur) }

  var i = 0
  var cx: CGFloat = 0
  var cy: CGFloat = 0
  var sx: CGFloat = 0
  var sy: CGFloat = 0
  var lastCmd = ""

  func nextNum() -> CGFloat {
    guard i < tokens.count else { return 0 }
    let v = Double(tokens[i]) ?? 0
    i += 1
    return CGFloat(v)
  }
  func hasNum() -> Bool {
    guard i < tokens.count else { return false }
    return Double(tokens[i]) != nil
  }

  while i < tokens.count {
    let tok = tokens[i]
    if tok.count == 1, let first = tok.unicodeScalars.first, cmdSet.contains(first) {
      lastCmd = tok
      i += 1
    } else if lastCmd.isEmpty {
      i += 1
      continue
    }

    switch lastCmd {
    case "M", "m":
      let rel = (lastCmd == "m")
      var first = true
      while hasNum() {
        let x = nextNum() + (rel ? cx : 0)
        let y = nextNum() + (rel ? cy : 0)
        if first {
          path.move(to: CGPoint(x: x, y: y))
          sx = x; sy = y
          first = false
        } else {
          path.addLine(to: CGPoint(x: x, y: y))
        }
        cx = x; cy = y
      }
      lastCmd = rel ? "l" : "L"
    case "L", "l":
      let rel = (lastCmd == "l")
      while hasNum() {
        let x = nextNum() + (rel ? cx : 0)
        let y = nextNum() + (rel ? cy : 0)
        path.addLine(to: CGPoint(x: x, y: y))
        cx = x; cy = y
      }
    case "H", "h":
      let rel = (lastCmd == "h")
      while hasNum() {
        let x = nextNum() + (rel ? cx : 0)
        path.addLine(to: CGPoint(x: x, y: cy))
        cx = x
      }
    case "V", "v":
      let rel = (lastCmd == "v")
      while hasNum() {
        let y = nextNum() + (rel ? cy : 0)
        path.addLine(to: CGPoint(x: cx, y: y))
        cy = y
      }
    case "C", "c":
      let rel = (lastCmd == "c")
      while hasNum() {
        let x1 = nextNum() + (rel ? cx : 0)
        let y1 = nextNum() + (rel ? cy : 0)
        let x2 = nextNum() + (rel ? cx : 0)
        let y2 = nextNum() + (rel ? cy : 0)
        let x = nextNum() + (rel ? cx : 0)
        let y = nextNum() + (rel ? cy : 0)
        path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
        cx = x; cy = y
      }
    case "Q", "q":
      let rel = (lastCmd == "q")
      while hasNum() {
        let x1 = nextNum() + (rel ? cx : 0)
        let y1 = nextNum() + (rel ? cy : 0)
        let x = nextNum() + (rel ? cx : 0)
        let y = nextNum() + (rel ? cy : 0)
        path.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: x1, y: y1))
        cx = x; cy = y
      }
    case "Z", "z":
      path.closeSubpath()
      cx = sx; cy = sy
      lastCmd = ""
    default:
      if hasNum() { _ = nextNum() } else { lastCmd = "" }
    }
  }
  return path
}

// MARK: - Window & Canvas

final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class OverlayCanvasView: NSView {
  var windowId: String
  var scene: OverlaySceneSpec? { didSet { rebuildCaches() } }
  var state: OverlayRuntimeState?
  var emitInteraction: ((String, [String: Any]) -> Void)?
  var onRoamTick: (() -> Void)?

  private var cachedPaths: [String: CGPath] = [:]
  private var cachedImages: [String: NSImage] = [:]
  private var dragOriginScreen: NSPoint = .zero
  private var panelOriginStart: NSPoint = .zero
  private var didDrag: Bool = false
  private var dragStartedInPet: Bool = false
  private var isHovered: Bool = false
  private var trackingArea: NSTrackingArea?

  var currentPetHitRect: NSRect = .zero
  var currentBubbleRect: NSRect = .zero
  var currentDismissRect: NSRect = .zero

  init(windowId: String, frame: NSRect) {
    self.windowId = windowId
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isFlipped: Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let ta = trackingArea { removeTrackingArea(ta) }
    let ta = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways], owner: self, userInfo: nil)
    addTrackingArea(ta)
    trackingArea = ta
  }

  override func mouseEntered(with event: NSEvent) {
    isHovered = true
  }

  override func mouseExited(with event: NSEvent) {
    isHovered = false
  }

  func shouldPauseRoam() -> Bool {
    if isHovered || dragStartedInPet { return true }
    if state?.bubble?.kind == "approval" || state?.animState == "approval" { return true }
    return false
  }

  private func rebuildCaches() {
    cachedPaths.removeAll()
    cachedImages.removeAll()
    guard let scene = scene else { return }
    for layer in scene.layers {
      if layer.kind == "path", let d = layer.d {
        cachedPaths[layer.id] = parseSvgPath(d)
      } else if layer.kind == "sprite", let sp = layer.spritePath {
        if let img = NSImage(contentsOfFile: sp) {
          cachedImages[layer.id] = img
        }
      }
    }
    needsDisplay = true
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    let pt = convert(point, from: superview)
    if currentPetHitRect.contains(pt) || (!currentBubbleRect.isEmpty && currentBubbleRect.contains(pt)) {
      return self
    }
    return nil
  }

  override func mouseDown(with event: NSEvent) {
    let pt = convert(event.locationInWindow, from: nil)
    didDrag = false
    dragStartedInPet = false
    if !currentDismissRect.isEmpty && currentDismissRect.contains(pt), let bid = state?.bubble?.id {
      emitInteraction?("bubble-dismiss", ["bubbleId": bid])
      return
    }
    if !currentBubbleRect.isEmpty && currentBubbleRect.contains(pt), let bid = state?.bubble?.id {
      emitInteraction?("bubble-click", ["bubbleId": bid])
      return
    }
    if currentPetHitRect.contains(pt) {
      dragStartedInPet = true
      dragOriginScreen = NSEvent.mouseLocation
      panelOriginStart = window?.frame.origin ?? .zero
    }
  }

  override func mouseDragged(with event: NSEvent) {
    guard dragStartedInPet, let win = window else { return }
    let cur = NSEvent.mouseLocation
    let dx = cur.x - dragOriginScreen.x
    let dy = cur.y - dragOriginScreen.y
    if abs(dx) > 3 || abs(dy) > 3 {
      didDrag = true
    }
    if didDrag {
      win.setFrameOrigin(NSPoint(x: panelOriginStart.x + dx, y: panelOriginStart.y + dy))
    }
  }

  override func mouseUp(with event: NSEvent) {
    if dragStartedInPet {
      if didDrag, let win = window {
        let f = win.frame
        emitInteraction?("position-changed", [
          "bounds": [
            "x": Int(round(f.origin.x)),
            "y": Int(round(f.origin.y)),
            "width": Int(round(f.size.width)),
            "height": Int(round(f.size.height))
          ]
        ])
      } else if event.clickCount >= 2 {
        emitInteraction?("pet-double-click", [:])
      } else {
        emitInteraction?("pet-click", [:])
      }
    }
    dragStartedInPet = false
    didDrag = false
  }

  override func rightMouseDown(with event: NSEvent) {
    guard let items = state?.contextMenu, !items.isEmpty else { return }
    let menu = NSMenu()
    for item in items {
      if item.type == "separator" {
        menu.addItem(NSMenuItem.separator())
        continue
      }
      let mi = NSMenuItem(title: item.label ?? item.id, action: #selector(handleMenuClick(_:)), keyEquivalent: "")
      mi.target = self
      mi.representedObject = item.id
      mi.isEnabled = (item.enabled != false)
      if item.type == "checkbox" && item.checked == true {
        mi.state = .on
      }
      menu.addItem(mi)
    }
    NSMenu.popUpContextMenu(menu, with: event, for: self)
  }

  @objc private func handleMenuClick(_ sender: NSMenuItem) {
    if let itemId = sender.representedObject as? String {
      emitInteraction?("menu-click", ["itemId": itemId])
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    ctx.clear(bounds)

    let nowSec = Date().timeIntervalSinceReferenceDate
    let animState = state?.animState ?? "idle"
    let speedFactor = max(0.25, min(4.0, state?.speedFactor ?? 1.0))
    let petScale = max(0.6, min(2.0, state?.scale ?? 1.0))

    let bubbleHeight: CGFloat = (state?.bubble != nil) ? 54 : 0
    let petArea = NSRect(x: 0, y: bubbleHeight, width: bounds.width, height: max(48, bounds.height - bubbleHeight))

    if let scene = scene {
      let vbW = max(1.0, scene.viewBox.width)
      let vbH = max(1.0, scene.viewBox.height)
      let fitScale = min(petArea.width / CGFloat(vbW), petArea.height / CGFloat(vbH)) * CGFloat(petScale)
      let drawW = CGFloat(vbW) * fitScale
      let drawH = CGFloat(vbH) * fitScale
      let ox = petArea.origin.x + (petArea.width - drawW) / 2.0
      let oy = petArea.origin.y + (petArea.height - drawH) / 2.0

      currentPetHitRect = NSRect(
        x: ox + CGFloat(scene.hitBox.x) * fitScale,
        y: oy + CGFloat(scene.hitBox.y) * fitScale,
        width: CGFloat(scene.hitBox.width) * fitScale,
        height: CGFloat(scene.hitBox.height) * fitScale
      )

      ctx.saveGState()
      ctx.translateBy(x: ox, y: oy)
      ctx.scaleBy(x: fitScale, y: fitScale)
      if state?.flipX == true {
        ctx.translateBy(x: CGFloat(vbW), y: 0)
        ctx.scaleBy(x: -1, y: 1)
      }

      for layer in scene.layers {
        if let allowed = layer.motion?.states, !allowed.contains(animState) { continue }
        ctx.saveGState()
        var tx: CGFloat = 0
        var ty: CGFloat = 0
        var rot: CGFloat = 0
        var sy: CGFloat = 1
        if let m = layer.motion {
          let phase = m.phaseRad ?? 0
          if let ampY = m.bobAmpY, let fY = m.bobFreqHz, fY > 0 {
            ty += CGFloat(ampY * sin(2.0 * Double.pi * fY * speedFactor * nowSec + phase))
          }
          if let ampX = m.swayAmpX, let fX = m.swayFreqHz, fX > 0 {
            tx += CGFloat(ampX * sin(2.0 * Double.pi * fX * speedFactor * nowSec + phase))
          }
          if let ampR = m.rotAmpDeg, let fR = m.rotFreqHz, fR > 0 {
            rot = CGFloat((ampR * Double.pi / 180.0) * sin(2.0 * Double.pi * fR * speedFactor * nowSec + phase))
          }
          if let blink = m.blinkIntervalMs, blink > 0 {
            let modMs = (nowSec * 1000.0).truncatingRemainder(dividingBy: blink)
            if modMs < 130.0 { sy = 0.12 }
          }
        }
        let px = CGFloat(layer.pivotX ?? vbW / 2.0)
        let py = CGFloat(layer.pivotY ?? vbH / 2.0)
        ctx.translateBy(x: px + tx, y: py + ty)
        if rot != 0 { ctx.rotate(by: rot) }
        if sy != 1 { ctx.scaleBy(x: 1, y: sy) }
        ctx.translateBy(x: -px, y: -py)
        if let alpha = layer.opacity { ctx.setAlpha(CGFloat(alpha)) }

        let fillColor = nsColorFromHex(layer.fill, fallback: .clear)
        let strokeColor = nsColorFromHex(layer.stroke, fallback: .clear)
        let hasFill = (layer.fill != nil && layer.fill != "none")
        let hasStroke = (layer.stroke != nil && layer.stroke != "none")

        if layer.kind == "path", let cgPath = cachedPaths[layer.id] {
          ctx.addPath(cgPath)
          if hasFill && hasStroke {
            ctx.setFillColor(fillColor.cgColor)
            ctx.setStrokeColor(strokeColor.cgColor)
            ctx.setLineWidth(CGFloat(layer.strokeWidth ?? 1.5))
            ctx.drawPath(using: .fillStroke)
          } else if hasFill {
            ctx.setFillColor(fillColor.cgColor)
            ctx.fillPath()
          } else if hasStroke {
            ctx.setStrokeColor(strokeColor.cgColor)
            ctx.setLineWidth(CGFloat(layer.strokeWidth ?? 1.5))
            ctx.strokePath()
          }
        } else if layer.kind == "circle" {
          let r = CGFloat(layer.r ?? 10)
          let rect = CGRect(x: CGFloat(layer.cx ?? 0) - r, y: CGFloat(layer.cy ?? 0) - r, width: r * 2, height: r * 2)
          if hasFill { ctx.setFillColor(fillColor.cgColor); ctx.fillEllipse(in: rect) }
          if hasStroke {
            ctx.setStrokeColor(strokeColor.cgColor)
            ctx.setLineWidth(CGFloat(layer.strokeWidth ?? 1.5))
            ctx.strokeEllipse(in: rect)
          }
        } else if layer.kind == "ellipse" {
          let rx = CGFloat(layer.rx ?? 10)
          let ry = CGFloat(layer.ry ?? 10)
          let rect = CGRect(x: CGFloat(layer.cx ?? 0) - rx, y: CGFloat(layer.cy ?? 0) - ry, width: rx * 2, height: ry * 2)
          if hasFill { ctx.setFillColor(fillColor.cgColor); ctx.fillEllipse(in: rect) }
          if hasStroke {
            ctx.setStrokeColor(strokeColor.cgColor)
            ctx.setLineWidth(CGFloat(layer.strokeWidth ?? 1.5))
            ctx.strokeEllipse(in: rect)
          }
        } else if layer.kind == "rect" {
          let rect = CGRect(x: CGFloat(layer.x ?? 0), y: CGFloat(layer.y ?? 0), width: CGFloat(layer.width ?? 10), height: CGFloat(layer.height ?? 10))
          let cr = CGFloat(layer.cornerRadius ?? 0)
          let p = CGPath(roundedRect: rect, cornerWidth: cr, cornerHeight: cr, transform: nil)
          ctx.addPath(p)
          if hasFill && hasStroke {
            ctx.setFillColor(fillColor.cgColor)
            ctx.setStrokeColor(strokeColor.cgColor)
            ctx.setLineWidth(CGFloat(layer.strokeWidth ?? 1.5))
            ctx.drawPath(using: .fillStroke)
          } else if hasFill {
            ctx.setFillColor(fillColor.cgColor)
            ctx.fillPath()
          } else if hasStroke {
            ctx.setStrokeColor(strokeColor.cgColor)
            ctx.setLineWidth(CGFloat(layer.strokeWidth ?? 1.5))
            ctx.strokePath()
          }
        } else if layer.kind == "sprite", let img = cachedImages[layer.id] {
          let dest = NSRect(x: layer.x ?? 0, y: layer.y ?? 0, width: layer.width ?? vbW, height: layer.height ?? vbH)
          img.draw(in: dest)
        }
        ctx.restoreGState()
      }
      ctx.restoreGState()
    } else {
      currentPetHitRect = NSRect(x: bounds.width / 4, y: bounds.height / 4, width: bounds.width / 2, height: bounds.height / 2)
    }

    // Draw Bubble if present
    if let bubble = state?.bubble {
      let bRect = NSRect(x: 8, y: 4, width: bounds.width - 16, height: 46)
      currentBubbleRect = bRect
      let bgPath = NSBezierPath(roundedRect: bRect, xRadius: 10, yRadius: 10)
      NSColor(srgbRed: 0.08, green: 0.09, blue: 0.13, alpha: 0.92).setFill()
      bgPath.fill()
      let accent = nsColorFromHex(bubble.accentHex, fallback: NSColor(srgbRed: 0.65, green: 0.55, blue: 0.98, alpha: 1.0))
      accent.withAlphaComponent(0.75).setStroke()
      bgPath.lineWidth = 1.25
      bgPath.stroke()

      let titleAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        .foregroundColor: NSColor.white
      ]
      let subAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 10, weight: .regular),
        .foregroundColor: NSColor(white: 0.82, alpha: 1.0)
      ]
      (bubble.title as NSString).draw(in: NSRect(x: bRect.minX + 10, y: bRect.minY + 6, width: bRect.width - 30, height: 16), withAttributes: titleAttrs)
      if let sub = bubble.subtitle {
        (sub as NSString).draw(in: NSRect(x: bRect.minX + 10, y: bRect.minY + 23, width: bRect.width - 20, height: 15), withAttributes: subAttrs)
      }
      if bubble.dismissible != false {
        let dRect = NSRect(x: bRect.maxX - 20, y: bRect.minY + 5, width: 15, height: 15)
        currentDismissRect = dRect
        ("×" as NSString).draw(in: dRect, withAttributes: titleAttrs)
      } else {
        currentDismissRect = .zero
      }
    } else {
      currentBubbleRect = .zero
      currentDismissRect = .zero
    }
  }
}

// MARK: - App Delegate

final class OverlayAppDelegate: NSObject, NSApplicationDelegate {
  private var socketPath: String?
  private var parentPid: Int32
  private var socketFd: Int32 = -1
  private let outputLock = NSLock()
  private var windows: [String: (panel: OverlayPanel, view: OverlayCanvasView, roamDir: CGFloat)] = [:]
  private var animTimer: Timer?
  private var parentWatchTimer: Timer?

  init(socketPath: String?, parentPid: Int32) {
    self.socketPath = socketPath
    self.parentPid = parentPid
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    if let sock = socketPath, !sock.isEmpty {
      guard let fd = connectUnixSocket(sock) else {
        NSApp.terminate(nil)
        return
      }
      socketFd = fd
    }

    startInputLoop()
    startTimers()

    let visibleFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 25, width: 1440, height: 875)
    emitEvent([
      "type": "ready",
      "platform": "darwin",
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "workArea": [
        "x": Int(visibleFrame.origin.x),
        "y": Int(visibleFrame.origin.y),
        "width": Int(visibleFrame.size.width),
        "height": Int(visibleFrame.size.height)
      ]
    ])
  }

  private func emitEvent(_ payload: [String: Any]) {
    outputLock.lock()
    defer { outputLock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    if socketFd >= 0 {
      let bytes = Array(line.utf8)
      bytes.withUnsafeBufferPointer { buf in
        guard let base = buf.baseAddress else { return }
        var sent = 0
        while sent < buf.count {
          let n = Darwin.write(socketFd, base.advanced(by: sent), buf.count - sent)
          if n <= 0 {
            if n < 0 && errno == EINTR { continue }
            break
          }
          sent += n
        }
      }
    } else {
      FileHandle.standardOutput.write(Data(line.utf8))
    }
  }

  private func startTimers() {
    animTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
      self?.tickFrames()
    }
    if parentPid > 0 {
      parentWatchTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
        guard let self = self else { return }
        if Darwin.kill(self.parentPid, 0) != 0 && errno == ESRCH {
          NSApp.terminate(nil)
        }
      }
    }
  }

  private func tickFrames() {
    let dt: CGFloat = 1.0 / 30.0
    let work = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 25, width: 1440, height: 875)
    for (wid, entry) in windows {
      let view = entry.view
      let panel = entry.panel
      guard panel.isVisible else { continue }
      if let roam = view.state?.roam, roam.enabled == true,
         let baseSpeed = roam.baseSpeedPxPerSec, baseSpeed > 0,
         !view.shouldPauseRoam(),
         view.state?.animState != "sleeping" {
        let speedFactor = CGFloat(max(0.25, min(4.0, view.state?.speedFactor ?? 1.0)))
        var dir = entry.roamDir
        var origin = panel.frame.origin
        origin.x += dir * CGFloat(baseSpeed) * speedFactor * dt
        if origin.x <= work.minX {
          origin.x = work.minX
          dir = 1
        } else if origin.x + panel.frame.width >= work.maxX {
          origin.x = max(work.minX, work.maxX - panel.frame.width)
          dir = -1
        }
        panel.setFrameOrigin(origin)
        windows[wid]?.roamDir = dir
      }
      view.needsDisplay = true
    }
  }

  private func startInputLoop() {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self = self else { return }
      var buffer = Data()
      var temp = [UInt8](repeating: 0, count: 65536)
      while true {
        let n: Int
        if self.socketFd >= 0 {
          n = Darwin.read(self.socketFd, &temp, temp.count)
        } else {
          let d = FileHandle.standardInput.availableData
          n = d.count
          if n > 0 { d.copyBytes(to: &temp, count: min(n, temp.count)) }
        }
        if n <= 0 {
          DispatchQueue.main.async { NSApp.terminate(nil) }
          break
        }
        buffer.append(temp, count: n)
        while let range = buffer.firstRange(of: Data([0x0a])) {
          let lineData = buffer.subdata(in: 0..<range.lowerBound)
          buffer.removeSubrange(0...range.lowerBound)
          if let cmd = try? JSONDecoder().decode(OverlayCommand.self, from: lineData) {
            DispatchQueue.main.async { self.handleCommand(cmd) }
          }
        }
      }
    }
  }

  private func handleCommand(_ cmd: OverlayCommand) {
    if cmd.type == "quit" {
      NSApp.terminate(nil)
      return
    }
    guard let wid = cmd.windowId, !wid.isEmpty else { return }

    if cmd.type == "remove-window" {
      if let entry = windows.removeValue(forKey: wid) {
        entry.panel.orderOut(nil)
        entry.panel.close()
      }
      return
    }

    if cmd.type == "upsert-window" {
      let w = CGFloat(cmd.bounds?.width ?? 220)
      let h = CGFloat(cmd.bounds?.height ?? 200)
      let x = CGFloat(cmd.bounds?.x ?? 100)
      let y = CGFloat(cmd.bounds?.y ?? 100)
      let rect = NSRect(x: x, y: y, width: w, height: h)

      if let entry = windows[wid] {
        entry.panel.setFrame(rect, display: true)
        if cmd.visible == false {
          entry.panel.orderOut(nil)
        } else {
          entry.panel.orderFrontRegardless()
        }
      } else {
        let panel = OverlayPanel(
          contentRect: rect,
          styleMask: [.borderless, .nonactivatingPanel],
          backing: .buffered,
          defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.ignoresMouseEvents = false
        panel.isMovableByWindowBackground = false

        let view = OverlayCanvasView(windowId: wid, frame: NSRect(origin: .zero, size: rect.size))
        view.autoresizingMask = [.width, .height]
        view.emitInteraction = { [weak self] evType, extra in
          var payload: [String: Any] = ["type": "interaction", "windowId": wid, "eventType": evType]
          for (k, v) in extra { payload[k] = v }
          self?.emitEvent(payload)
        }
        panel.contentView = view
        windows[wid] = (panel: panel, view: view, roamDir: 1.0)
        if cmd.visible != false {
          panel.orderFrontRegardless()
        }
      }
      return
    }

    if cmd.type == "set-scene", let scene = cmd.scene, let entry = windows[wid] {
      entry.view.scene = scene
      return
    }

    if cmd.type == "update-state", let st = cmd.state, let entry = windows[wid] {
      entry.view.state = st
      entry.view.needsDisplay = true
    }
  }
}

// MARK: - Entrypoint

var sockArg: String? = nil
var ppidArg: Int32 = 0
var idx = 1
let args = CommandLine.arguments
while idx < args.count {
  if args[idx] == "--socket", idx + 1 < args.count {
    sockArg = args[idx + 1]
    idx += 2
  } else if args[idx] == "--parent-pid", idx + 1 < args.count {
    ppidArg = Int32(args[idx + 1]) ?? 0
    idx += 2
  } else {
    idx += 1
  }
}

let app = NSApplication.shared
let delegate = OverlayAppDelegate(socketPath: sockArg, parentPid: ppidArg)
app.delegate = delegate
app.run()
