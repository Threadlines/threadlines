import AppKit
import Foundation
import Vision

for path in CommandLine.arguments.dropFirst() {
  let url = URL(fileURLWithPath: path)
  guard
    let image = NSImage(contentsOf: url),
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let cgImage = bitmap.cgImage
  else {
    FileHandle.standardError.write(Data("Could not read \(path)\n".utf8))
    exit(2)
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  let handler = VNImageRequestHandler(cgImage: cgImage)

  do {
    try handler.perform([request])
  } catch {
    FileHandle.standardError.write(Data("OCR failed for \(path): \(error)\n".utf8))
    exit(3)
  }

  for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    print("\(url.lastPathComponent)\t\(candidate.string)")
  }
}
