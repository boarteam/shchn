// Captures the default macOS input with AVAudioEngine and writes 16-bit mono PCM
// to stdout. Used instead of ffmpeg's avfoundation input, which loses ~6% of the
// audio and so falls further behind real time the longer a session runs.
//
// Usage: mic-capture <sampleRate> <channel>   (channel is 1-based; 0 mixes all)

import AVFoundation
import Foundation

let arguments = CommandLine.arguments
let sampleRate = Double(arguments.count > 1 ? arguments[1] : "16000") ?? 16000
let channel = Int(arguments.count > 2 ? arguments[2] : "0") ?? 0

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let deviceFormat = input.outputFormat(forBus: 0)
if deviceFormat.sampleRate == 0 || deviceFormat.channelCount == 0 {
  fail("No input device, or this app has no microphone access.")
}
let channels = Int(deviceFormat.channelCount)
if channel > channels { fail("The input has \(channels) channel(s); --channel \(channel) doesn't exist.") }

let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: deviceFormat.sampleRate, channels: 1, interleaved: false)!
let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
guard let converter = AVAudioConverter(from: monoFormat, to: outputFormat) else { fail("Can't convert the input format.") }
let stdout = FileHandle.standardOutput

input.installTap(onBus: 0, bufferSize: 4096, format: deviceFormat) { buffer, _ in
  let frames = Int(buffer.frameLength)
  guard frames > 0, let source = buffer.floatChannelData,
        let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
  mono.frameLength = AVAudioFrameCount(frames)
  let target = mono.floatChannelData![0]
  for i in 0..<frames {
    if channel >= 1 {
      target[i] = source[channel - 1][i]
    } else {
      var sum: Float = 0
      for c in 0..<channels { sum += source[c][i] }
      target[i] = sum / Float(channels)
    }
  }
  let capacity = AVAudioFrameCount(Double(frames) * sampleRate / deviceFormat.sampleRate) + 32
  guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
  var supplied = false
  var error: NSError?
  converter.convert(to: converted, error: &error) { _, status in
    if supplied {
      status.pointee = .noDataNow
      return nil
    }
    supplied = true
    status.pointee = .haveData
    return mono
  }
  if converted.frameLength > 0, let samples = converted.int16ChannelData {
    stdout.write(Data(bytes: samples[0], count: Int(converted.frameLength) * 2))
  }
}

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }
signal(SIGPIPE) { _ in exit(0) }

do {
  try engine.start()
} catch {
  fail("Can't start the microphone: \(error.localizedDescription)")
}
RunLoop.main.run()
