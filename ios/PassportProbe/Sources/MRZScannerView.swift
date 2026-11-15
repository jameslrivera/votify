import AVFoundation
import PassportKit
import SwiftUI
import Vision

struct MRZScannerView: UIViewControllerRepresentable {
    let onFound: (MRZInfo) -> Void

    func makeUIViewController(context: Context) -> MRZScannerController {
        let c = MRZScannerController()
        c.onFound = onFound
        return c
    }

    func updateUIViewController(_ controller: MRZScannerController, context: Context) {}
}

final class MRZScannerController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {
    var onFound: ((MRZInfo) -> Void)?

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "mrz.scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private var busy = false
    private var lastCandidate: MRZInfo?
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard granted else { return }
            self?.queue.async { self?.configure() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private func configure() {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input)
        else { return }
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        if (try? camera.lockForConfiguration()) != nil {
            if camera.isFocusModeSupported(.continuousAutoFocus) { camera.focusMode = .continuousAutoFocus }
            camera.unlockForConfiguration()
        }
        DispatchQueue.main.async {
            let layer = AVCaptureVideoPreviewLayer(session: self.session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = self.view.bounds
            self.view.layer.addSublayer(layer)
            self.preview = layer
        }
        session.startRunning()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !busy, !finished, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        busy = true
        let request = VNRecognizeTextRequest { [weak self] request, _ in
            guard let self else { return }
            defer { self.busy = false }
            let lines = (request.results as? [VNRecognizedTextObservation] ?? [])
                .flatMap { $0.topCandidates(3).map(\.string) }
            guard let info = MRZ.find(in: lines) else { return }
            if info == self.lastCandidate {
                self.finished = true
                DispatchQueue.main.async { self.onFound?(info) }
            } else {
                self.lastCandidate = info
            }
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .right, options: [:]).perform([request])
    }
}
