import CoreGraphics
import Foundation

let expectedOwner = "Threadlines (Dev)"
let expectedWidth = CommandLine.arguments.dropFirst().first.flatMap(Int.init) ?? 1600
let expectedHeight = CommandLine.arguments.dropFirst(2).first.flatMap(Int.init) ?? 934
let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
let windows =
  CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []

let match = windows.first { window in
  let owner = window[kCGWindowOwnerName as String] as? String
  let layer = window[kCGWindowLayer as String] as? Int
  guard
    owner == expectedOwner,
    layer == 0,
    let bounds = window[kCGWindowBounds as String] as? [String: Any],
    let width = bounds["Width"] as? Int,
    let height = bounds["Height"] as? Int
  else {
    return false
  }
  return width == expectedWidth && height == expectedHeight
}

guard
  let match,
  let windowNumber = match[kCGWindowNumber as String] as? Int,
  let rawBounds = match[kCGWindowBounds as String] as? [String: Any],
  let x = rawBounds["X"] as? Int,
  let y = rawBounds["Y"] as? Int,
  let width = rawBounds["Width"] as? Int,
  let height = rawBounds["Height"] as? Int
else {
  FileHandle.standardError.write(
    Data(
      "Could not find the \(expectedWidth)×\(expectedHeight) Threadlines Marketing Studio window.\n"
        .utf8
    )
  )
  exit(1)
}

var displayCount: UInt32 = 0
guard CGGetActiveDisplayList(0, nil, &displayCount) == .success else {
  FileHandle.standardError.write(Data("Could not enumerate active displays.\n".utf8))
  exit(1)
}
var displayIds = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
guard
  CGGetActiveDisplayList(displayCount, &displayIds, &displayCount) == .success
else {
  FileHandle.standardError.write(Data("Could not read active display bounds.\n".utf8))
  exit(1)
}

let displayBounds = displayIds.prefix(Int(displayCount)).map { displayId in
  let bounds = CGDisplayBounds(displayId)
  return [
    "x": Int(bounds.origin.x),
    "y": Int(bounds.origin.y),
    "width": Int(bounds.width),
    "height": Int(bounds.height),
  ]
}
let result: [String: Any] = [
  "windowId": windowNumber,
  "bounds": [
    "x": x,
    "y": y,
    "width": width,
    "height": height,
  ],
  "displays": displayBounds,
]

do {
  let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
} catch {
  FileHandle.standardError.write(Data("Could not serialize capture-window geometry.\n".utf8))
  exit(1)
}
