import CoreNFC
import PassportKit
import SwiftUI

struct RegisterView: View {
    enum Step: Int, CaseIterable {
        case scan
        case chip
        case proof
        case solana

        var title: String {
            switch self {
            case .scan: return "Scan the photo page"
            case .chip: return "Hold your passport to the phone"
            case .proof: return "Create your proof"
            case .solana: return "Register for the ballot on Solana"
            }
        }
    }

    enum Sheet: Identifiable {
        case scanner
        var id: Int { hashValue }
    }

    @EnvironmentObject private var model: AppModel
    @State private var done: Set<Step> = []
    @State private var active: Step?
    @State private var mrz: MRZInfo?
    @State private var failure: String?
    @State private var sheet: Sheet?
    @State private var working = false
    @State private var credential: Credential?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Create your voter ID")
                .font(.system(size: 30, weight: .heavy))
                .padding(.top, 12)
                .onTapGesture(count: 3) {
                    #if targetEnvironment(simulator)
                    if !working && mrz == nil { useMock() }
                    #endif
                }
            VStack(spacing: 0) {
                ForEach(Step.allCases, id: \.rawValue) { step in
                    row(step)
                    if step != .solana { Rectangle().fill(Theme.divider).frame(height: 1) }
                }
            }
            FailureBanner(message: failure)
            Spacer()
            Button(primaryLabel) { primaryAction() }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working)
            if !working {
                Button("Back") { model.stage = .intro }.buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(24)
        .sheet(item: $sheet) { item in
            switch item {
            case .scanner: scannerSheet
            }
        }
    }

    private var primaryLabel: String {
        if working { return "Working…" }
        return mrz == nil ? "Scan passport" : "Read the chip"
    }

    private func row(_ step: Step) -> some View {
        let isDone = done.contains(step)
        let isActive = active == step
        return HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(isDone ? Theme.accent : Theme.surface)
                    .frame(width: 32, height: 32)
                if isDone {
                    Image(systemName: "checkmark").font(.system(size: 14, weight: .heavy)).foregroundColor(.white)
                } else if isActive {
                    ProgressView().tint(Theme.accentText)
                } else {
                    Text("\(step.rawValue + 1)").font(.system(size: 14, weight: .bold)).foregroundColor(Theme.secondary)
                }
            }
            Text(step.title)
                .font(.system(size: 17, weight: isDone || isActive ? .bold : .medium))
                .foregroundColor(isDone || isActive ? Theme.text : Theme.secondary)
            Spacer()
        }
        .frame(minHeight: 60)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(step.title), \(isDone ? "done" : isActive ? "in progress" : "not started")")
    }

    private var scannerSheet: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                Text("Point the camera at the photo page").font(.system(size: 24, weight: .heavy))
                Text("Fit the two lines of letters and chevrons at the bottom of the page in view.")
                    .font(.system(size: 15, weight: .medium)).foregroundColor(Theme.secondary)
                MRZScannerView { info in
                    accept(info)
                }
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                Button("Cancel") { sheet = nil }.buttonStyle(SecondaryButtonStyle())
            }
            .padding(24)
        }
        .foregroundColor(Theme.text)
    }

    private func accept(_ info: MRZInfo) {
        mrz = info
        failure = nil
        done.insert(.scan)
        sheet = nil
    }

    private func startProofEarly() {
        guard credential == nil, let fresh = try? Credential.random() else { return }
        credential = fresh
        let relayer = model.relayer
        Task { await relayer.prepareMock(credential: fresh) }
    }

    private func primaryAction() {
        failure = nil
        startProofEarly()
        if mrz == nil {
            sheet = .scanner
        } else {
            readChip()
        }
    }

    private func useMock() {
        failure = nil
        do {
            let report = try ChipReader.analyseMock()
            guard report.passiveAuthenticationPassed else {
                failure = "The passport did not pass its checks."
                return
            }
            done.formUnion([.scan, .chip])
            startProofEarly()
            register(usedMockPassport: true)
        } catch {
            failure = "The passport could not be loaded."
        }
    }

    private func readChip() {
        guard let mrz else { return }
        guard NFCTagReaderSession.readingAvailable else {
            failure = "This device cannot read passport chips."
            return
        }
        working = true
        active = .chip
        Task {
            do {
                let report = try await ChipReader.readAndAnalyse(mrz: mrz)
                self.mrz = nil
                guard report.passiveAuthenticationPassed else {
                    stop("The passport's signature did not verify, so it cannot be used.")
                    return
                }
                done.insert(.chip)
                register(usedMockPassport: false)
            } catch {
                stop(Self.message(for: error))
            }
        }
    }

    private func register(usedMockPassport: Bool) {
        working = true
        active = .proof
        Task {
            do {
                let credential = try self.credential ?? Credential.random()
                self.credential = credential
                let ballot = try await model.relayer.ballot()
                let receipt = try await model.relayer.registerMock(credential: credential)
                guard let first = receipt.registrations.first else {
                    throw RelayerError(message: "The election server did not confirm the registration.")
                }
                done.formUnion([.proof, .solana])
                active = nil
                try model.completeRegistration(
                    credential: credential,
                    account: Account(
                        ballotTitle: ballot.title,
                        raceCount: receipt.registrations.count,
                        signature: first.signature,
                        usedMockPassport: usedMockPassport,
                        electionIds: ballot.races.map(\.electionId)
                    )
                )
            } catch {
                stop(error.localizedDescription)
            }
        }
    }

    private func stop(_ message: String) {
        failure = message
        active = nil
        working = false
    }

    static func message(for error: Error) -> String {
        let text = String(describing: error)
        if text.contains("UserCanceled") { return "Reading was cancelled. Try again when you are ready." }
        if text.contains("InvalidMRZKey") || text.contains("ResponseError") {
            return "The chip refused the details from the photo page. Go back and scan the page again."
        }
        if text.contains("ConnectionError") || text.contains("TimeOut") || text.contains("NoConnectedTag") {
            return "The connection to the chip dropped. Hold the phone still against the back cover and try again."
        }
        if error is SODError || error is DERError {
            return "The chip was read, but its security object has a structure this app does not handle yet."
        }
        return "The chip could not be read. Try again."
    }
}
