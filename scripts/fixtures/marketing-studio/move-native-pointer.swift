import CoreGraphics
import Foundation

guard
  CommandLine.arguments.count >= 4,
  let targetX = Double(CommandLine.arguments[1]),
  let targetY = Double(CommandLine.arguments[2]),
  let duration = Double(CommandLine.arguments[3]),
  targetX.isFinite,
  targetY.isFinite,
  duration.isFinite,
  duration >= 0
else {
  FileHandle.standardError.write(
    Data("Usage: move-native-pointer.swift <x> <y> <duration-seconds> [click]\n".utf8)
  )
  exit(1)
}

let shouldClick = CommandLine.arguments.dropFirst(4).first == "click"
let source = CGEventSource(stateID: .hidSystemState)
let start = CGEvent(source: source)?.location ?? .zero
let frameCount = max(1, Int((duration * 60).rounded()))

for frame in 1 ... frameCount {
  let progress = Double(frame) / Double(frameCount)
  let eased = progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - pow(-2 * progress + 2, 3) / 2
  let point = CGPoint(
    x: start.x + (targetX - start.x) * eased,
    y: start.y + (targetY - start.y) * eased
  )
  CGWarpMouseCursorPosition(point)
  if frame < frameCount, duration > 0 {
    usleep(useconds_t(duration * 1_000_000 / Double(frameCount)))
  }
}

if shouldClick {
  let target = CGPoint(x: targetX, y: targetY)
  CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseDown,
    mouseCursorPosition: target,
    mouseButton: .left
  )?.post(tap: .cghidEventTap)
  usleep(80_000)
  CGEvent(
    mouseEventSource: source,
    mouseType: .leftMouseUp,
    mouseCursorPosition: target,
    mouseButton: .left
  )?.post(tap: .cghidEventTap)
}
