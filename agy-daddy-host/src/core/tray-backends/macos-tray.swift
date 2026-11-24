import Cocoa
import Darwin
import Foundation

struct TrayMenuItemSpec: Decodable {
  let id: String
  let type: String?
  let label: String?
  let icon: String?
  let tooltip: String?
  let enabled: Bool?
  let checked: Bool?
  let submenu: [TrayMenuItemSpec]?
}

struct TrayCommand: Decodable {
  let type: String
  let tooltip: String?
  let title: String?
  let iconPath: String?
  let isTemplate: Bool?
  let items: [TrayMenuItemSpec]?
}

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

final class AgyTrayDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var itemIdMap: [ObjectIdentifier: String] = [:]
  private let outputLock = NSLock()
  private var initialIconPath: String?
  private var initialTooltip: String
  private var socketPath: String?
  private var parentPid: Int32
  private var socketFd: Int32 = -1
  private var parentWatchTimer: Timer?

  init(iconPath: String?, tooltip: String, socketPath: String?, parentPid: Int32) {
    self.initialIconPath = iconPath
    self.initialTooltip = tooltip
    self.socketPath = socketPath
    self.parentPid = parentPid
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if NSApp.mainMenu == nil {
      let mainMenu = NSMenu()
      mainMenu.addItem(NSMenuItem())
      NSApp.mainMenu = mainMenu
    }

    if let sock = socketPath, !sock.isEmpty {
      guard let fd = connectUnixSocket(sock) else {
        NSApp.terminate(nil)
        return
      }
      socketFd = fd
    }

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.autosaveName = "AgyDaddyLauncher"
    statusItem.isVisible = true
    applyStatusButton(iconPath: initialIconPath, isTemplate: true, tooltip: initialTooltip, title: "AD")
    startInputLoop()
    startParentWatchdog()

    emitEvent([
      "type": "ready",
      "platform": "darwin",
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "bundleId": Bundle.main.bundleIdentifier ?? ""
    ])
  }

  func applicationWillTerminate(_ notification: Notification) {
    parentWatchTimer?.invalidate()
    parentWatchTimer = nil
    if socketFd >= 0 {
      Darwin.close(socketFd)
      socketFd = -1
    }
  }

  private func startParentWatchdog() {
    guard parentPid > 0 else { return }
    parentWatchTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
      guard let self = self else { return }
      if Darwin.kill(self.parentPid, 0) != 0 && errno == ESRCH {
        NSApp.terminate(nil)
      }
    }
  }

  private func emitEvent(_ payload: [String: Any]) {
    outputLock.lock()
    defer { outputLock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          var line = String(data: data, encoding: .utf8) else {
      return
    }
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

  private func applyStatusButton(iconPath: String?, isTemplate: Bool, tooltip: String?, title: String?) {
    guard let button = statusItem.button else { return }
    let effectiveTip = (tooltip?.isEmpty == false) ? tooltip! : "Agy-Daddy Launcher"
    button.toolTip = effectiveTip
    button.setAccessibilityLabel(effectiveTip)
    button.setAccessibilityTitle(effectiveTip)

    if let path = iconPath, !path.isEmpty, FileManager.default.fileExists(atPath: path),
       let img = NSImage(contentsOfFile: path) {
      img.size = NSSize(width: 18, height: 18)
      img.isTemplate = isTemplate
      button.image = img
      button.imagePosition = .imageOnly
      button.title = ""
      return
    }
    button.image = nil
    button.title = (title?.isEmpty == false) ? title! : "AD"
  }

  private func loadItemIcon(_ rawIcon: String?) -> (image: NSImage?, prefix: String?) {
    guard let raw = rawIcon?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return (nil, nil)
    }
    if raw.hasPrefix("/") && FileManager.default.fileExists(atPath: raw),
       let img = NSImage(contentsOfFile: raw) {
      img.size = NSSize(width: 16, height: 16)
      if raw.lowercased().contains("template") {
        img.isTemplate = true
      }
      return (img, nil)
    }
    if raw.hasPrefix("data:image/"),
       let comma = raw.firstIndex(of: ",") {
      let b64 = String(raw[raw.index(after: comma)...])
      if let data = Data(base64Encoded: b64), let img = NSImage(data: data) {
        img.size = NSSize(width: 16, height: 16)
        return (img, nil)
      }
    }
    if raw.count <= 4 {
      return (nil, raw)
    }
    return (nil, nil)
  }

  private func buildMenu(_ specs: [TrayMenuItemSpec]) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    for spec in specs {
      let itemType = spec.type ?? "normal"
      if itemType == "separator" {
        menu.addItem(NSMenuItem.separator())
        continue
      }
      let baseLabel = spec.label ?? spec.id
      let (iconImg, iconPrefix) = loadItemIcon(spec.icon)
      let displayTitle = iconPrefix != nil ? "\(iconPrefix!) \(baseLabel)" : baseLabel
      let item = NSMenuItem(title: displayTitle, action: #selector(handleMenuItemClick(_:)), keyEquivalent: "")
      item.target = self
      item.isEnabled = spec.enabled ?? true
      if let tip = spec.tooltip, !tip.isEmpty {
        item.toolTip = tip
      }
      if let img = iconImg {
        item.image = img
      }
      if itemType == "checkbox" {
        item.state = (spec.checked ?? false) ? .on : .off
      }
      if itemType == "submenu", let children = spec.submenu, !children.isEmpty {
        item.submenu = buildMenu(children)
      }
      itemIdMap[ObjectIdentifier(item)] = spec.id
      menu.addItem(item)
    }
    return menu
  }

  @objc private func handleMenuItemClick(_ sender: NSMenuItem) {
    let key = ObjectIdentifier(sender)
    if let itemId = itemIdMap[key] {
      emitEvent(["type": "click", "itemId": itemId])
    }
  }

  private func handleCommand(_ cmd: TrayCommand) {
    switch cmd.type {
    case "update-menu":
      itemIdMap.removeAll()
      if cmd.iconPath != nil || cmd.tooltip != nil || cmd.title != nil {
        applyStatusButton(
          iconPath: cmd.iconPath ?? initialIconPath,
          isTemplate: cmd.isTemplate ?? true,
          tooltip: cmd.tooltip ?? initialTooltip,
          title: cmd.title
        )
      }
      let menu = buildMenu(cmd.items ?? [])
      statusItem.menu = menu
    case "quit":
      NSApp.terminate(nil)
    default:
      break
    }
  }

  private func startInputLoop() {
    let readFd: Int32 = socketFd >= 0 ? socketFd : FileHandle.standardInput.fileDescriptor
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var buffer = Data()
      var chunk = [UInt8](repeating: 0, count: 65536)
      let newline = UInt8(ascii: "\n")
      while true {
        let n = Darwin.read(readFd, &chunk, chunk.count)
        if n < 0 && errno == EINTR {
          continue
        }
        if n <= 0 {
          DispatchQueue.main.async {
            NSApp.terminate(nil)
          }
          break
        }
        buffer.append(chunk, count: n)
        while let idx = buffer.firstIndex(of: newline) {
          let lineData = buffer.subdata(in: buffer.startIndex..<idx)
          buffer.removeSubrange(buffer.startIndex...idx)
          if lineData.isEmpty { continue }
          if let cmd = try? JSONDecoder().decode(TrayCommand.self, from: lineData) {
            DispatchQueue.main.async {
              self?.handleCommand(cmd)
            }
          }
        }
      }
    }
  }
}

var argIconPath: String? = nil
var argTooltip = "Agy-Daddy Launcher"
var argSocketPath: String? = nil
var argParentPid: Int32 = 0
var argUseStdin = false
let args = CommandLine.arguments
var i = 1
while i < args.count {
  if args[i] == "--icon", i + 1 < args.count {
    argIconPath = args[i + 1]
    i += 2
    continue
  }
  if args[i] == "--tooltip", i + 1 < args.count {
    argTooltip = args[i + 1]
    i += 2
    continue
  }
  if args[i] == "--socket", i + 1 < args.count {
    argSocketPath = args[i + 1]
    i += 2
    continue
  }
  if args[i] == "--parent-pid", i + 1 < args.count {
    argParentPid = Int32(args[i + 1]) ?? 0
    i += 2
    continue
  }
  if args[i] == "--stdin" {
    argUseStdin = true
    i += 1
    continue
  }
  i += 1
}

if argSocketPath == nil && !argUseStdin {
  let exeURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  let launchURL = exeURL.deletingLastPathComponent().appendingPathComponent("launch")
  if FileManager.default.isExecutableFile(atPath: launchURL.path) {
    let proc = Process()
    proc.executableURL = launchURL
    proc.standardInput = FileHandle.nullDevice
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    do {
      try proc.run()
      exit(0)
    } catch {
      fputs("Failed to launch sibling script: \(error)\n", stderr)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AgyTrayDelegate(
  iconPath: argIconPath,
  tooltip: argTooltip,
  socketPath: argSocketPath,
  parentPid: argParentPid
)
app.delegate = delegate
app.run()
