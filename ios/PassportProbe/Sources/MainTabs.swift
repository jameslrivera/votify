import CoreImage.CIFilterBuiltins
import SwiftUI

struct MainTabs: View {
    enum Tab: Hashable {
        case results
        case id
        case account
    }

    @EnvironmentObject private var model: AppModel
    @State private var selection: Tab = .id

    init() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Theme.surface)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    var body: some View {
        TabView(selection: $selection) {
            ResultsTab()
                .tabItem { Label("Results", systemImage: "chart.bar.fill") }
                .tag(Tab.results)
            IDTab()
                .tabItem { Label("ID", systemImage: "person.text.rectangle.fill") }
                .tag(Tab.id)
            AccountTab()
                .tabItem { Label("Account", systemImage: "person.crop.circle.fill") }
                .tag(Tab.account)
        }
        .tint(Theme.accentText)
        .task {
            while !Task.isCancelled {
                await model.resetIfBallotRestarted()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
}

struct Screen<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(title).font(.system(size: 30, weight: .heavy)).padding(.top, 12)
                    content
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .foregroundColor(Theme.text)
    }
}

struct IDTab: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var code: UIImage?
    @State private var failure: String?
    @State private var loading = false

    var body: some View {
        Screen(title: "Your voter ID") {
            Label("Registered to vote", systemImage: "checkmark.seal.fill")
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(Theme.accentText)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.accentTint)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            VStack(spacing: 16) {
                if let code {
                    Image(uiImage: code)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .padding(16)
                        .background(Color.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .accessibilityLabel("Your voting code")
                } else {
                    Theme.surface
                        .aspectRatio(1, contentMode: .fit)
                        .overlay(
                            VStack(spacing: 12) {
                                Image(systemName: "qrcode")
                                    .font(.system(size: 88, weight: .regular))
                                    .foregroundColor(Theme.divider)
                                Text("Your voting code is hidden")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(Theme.secondary)
                            }
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .accessibilityElement(children: .combine)
                }
            }

            FailureBanner(message: failure)

            Button(code == nil ? (loading ? "Unlocking…" : "Show voting code") : "Hide voting code") {
                code == nil ? reveal() : hide()
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(loading)

            Text("Show this code at the voting booth kiosk to vote.")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onChange(of: scenePhase) { phase in
            if phase != .active { hide() }
        }
        .onDisappear { hide() }
    }

    private func hide() {
        code = nil
    }

    private func reveal() {
        failure = nil
        loading = true
        Task {
            do {
                let credential = try await Vault.loadCredential(reason: "Show your voting code")
                code = Self.qr(credential.qrPayload)
                if code == nil { failure = "The voting code could not be drawn." }
            } catch {
                failure = "The voting code stayed locked. Try again."
            }
            loading = false
        }
    }

    static func qr(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}

struct ResultsTab: View {
    @EnvironmentObject private var model: AppModel
    @State private var ballot: Ballot?
    @State private var failure: String?
    @State private var selected: Race?

    var body: some View {
        Screen(title: ballot?.title ?? "Results") {
            if let ballot {
                Text(ballot.area)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(Theme.secondary)
                    .padding(.top, -12)
                ForEach(ballot.races) { race in
                    Button { selected = race } label: { RaceCard(race: race) }
                        .buttonStyle(.plain)
                        .accessibilityHint("Shows every transaction for this race")
                }
                Text(footer(ballot))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Theme.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
            } else if let failure {
                FailureBanner(message: failure)
            } else {
                ProgressView().tint(Theme.accentText).frame(maxWidth: .infinity)
            }
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        .sheet(item: $selected) { race in
            RaceDetail(race: ballot?.races.first { $0.id == race.id } ?? race, rpcUrl: ballot?.rpcUrl ?? "")
                .environmentObject(model)
        }
    }

    private func load() async {
        do {
            ballot = try await model.relayer.ballot()
            failure = nil
        } catch {
            if ballot == nil { failure = error.localizedDescription }
        }
    }

    private func footer(_ ballot: Ballot) -> String {
        let cast = ballot.races.map { $0.tally.reduce(0, +) }.max() ?? 0
        return "\(ballot.registered) registered · \(cast) \(cast == 1 ? "ballot" : "ballots") cast · \(ballot.note)"
    }
}

struct RaceDetail: View {
    let race: Race
    let rpcUrl: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var transactions: [RaceTransaction]?
    @State private var failure: String?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(race.office).font(.system(size: 28, weight: .heavy))
                            Text(race.district).font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.secondary)
                        }
                        Spacer()
                        Button("Done") { dismiss() }
                            .font(.system(size: 17, weight: .bold))
                            .foregroundColor(Theme.accentText)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    RaceCard(race: race, showsHeader: false)
                    Text("Transactions on Solana").font(.system(size: 20, weight: .heavy)).padding(.top, 8)
                    if let transactions {
                        if transactions.isEmpty {
                            Text("Nothing yet.").font(.system(size: 15, weight: .medium)).foregroundColor(Theme.secondary)
                        }
                        VStack(spacing: 0) {
                            ForEach(transactions) { item in
                                row(item)
                                Rectangle().fill(Theme.divider).frame(height: 1)
                            }
                        }
                    } else if let failure {
                        FailureBanner(message: failure)
                    } else {
                        ProgressView().tint(Theme.accentText).frame(maxWidth: .infinity)
                    }
                }
                .padding(24)
            }
        }
        .foregroundColor(Theme.text)
        .task {
            while !Task.isCancelled {
                do {
                    transactions = try await model.relayer.transactions(electionId: race.electionId)
                        .filter { $0.kind != "registered" && $0.kind != "double-registration" }
                    failure = nil
                } catch {
                    if transactions == nil { failure = error.localizedDescription }
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    @ViewBuilder private func row(_ item: RaceTransaction) -> some View {
        let bad = item.kind != "registered" && item.kind != "vote"
        let content = HStack(spacing: 12) {
            Image(systemName: bad ? "xmark.circle.fill" : item.kind == "vote" ? "checkmark.circle.fill" : "person.crop.circle.badge.plus")
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(bad ? Theme.danger : Theme.accentText)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(label(item))
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(bad ? Theme.danger : Theme.text)
                Text("\(item.signature.prefix(8))…\(item.signature.suffix(8)) · \(time(item.time))")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(Theme.secondary)
            }
            Spacer()
            Image(systemName: "arrow.up.right")
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(Theme.secondary)
                .accessibilityHidden(true)
        }
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        if let url = explorerURL(item.signature) {
            Link(destination: url) { content }
                .accessibilityHint("Opens this transaction in Solana Explorer")
        } else {
            content
        }
    }

    private func label(_ item: RaceTransaction) -> String {
        switch item.kind {
        case "registered": return "Voter registered"
        case "vote": return "Vote for \(item.candidate ?? "a candidate")"
        case "double-vote": return "Double vote rejected"
        case "double-registration": return "Double registration rejected"
        default: return "Transaction rejected"
        }
    }

    private func time(_ seconds: Double?) -> String {
        guard let seconds else { return "" }
        let formatter = DateFormatter()
        formatter.timeStyle = .medium
        formatter.dateStyle = .none
        return formatter.string(from: Date(timeIntervalSince1970: seconds))
    }

    private func explorerURL(_ signature: String) -> URL? {
        var components = URLComponents(string: "https://explorer.solana.com/tx/\(signature)")
        if rpcUrl.contains("devnet") {
            components?.queryItems = [URLQueryItem(name: "cluster", value: "devnet")]
        } else {
            components?.queryItems = [
                URLQueryItem(name: "cluster", value: "custom"),
                URLQueryItem(name: "customUrl", value: rpcUrl),
            ]
        }
        return components?.url
    }
}

struct RaceCard: View {
    let race: Race
    var showsHeader = true

    var body: some View {
        let total = race.tally.reduce(0, +)
        let ranked = race.tally.enumerated().sorted { $0.element > $1.element }
        let leader = ranked.first
        let runnerUp = ranked.dropFirst().first
        let tied = total > 0 && leader?.element == runnerUp?.element

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                if showsHeader {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(race.office).font(.system(size: 20, weight: .heavy))
                        Text(race.district).font(.system(size: 14, weight: .medium)).foregroundColor(Theme.secondary)
                    }
                }
                Spacer()
                Text("\(total) \(total == 1 ? "vote" : "votes")")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Theme.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Theme.background)
                    .clipShape(Capsule())
            }
            Text(caption(total: total, leader: leader, runnerUp: runnerUp, tied: tied))
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.secondary)
            VStack(spacing: 0) {
                ForEach(Array(race.candidates.enumerated()), id: \.offset) { index, name in
                    let votes = index < race.tally.count ? race.tally[index] : 0
                    let leading = total > 0 && !tied && leader?.offset == index
                    Rectangle().fill(Theme.divider).frame(height: 1)
                    HStack(spacing: 12) {
                        Text(String(name.prefix(1)))
                            .font(.system(size: 15, weight: .heavy))
                            .foregroundColor(Theme.background)
                            .frame(width: 36, height: 36)
                            .background(Theme.candidates[index % Theme.candidates.count])
                            .clipShape(Circle())
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(name).font(.system(size: 16, weight: .bold))
                            GeometryReader { proxy in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Theme.divider)
                                    Capsule().fill(Theme.candidates[index % Theme.candidates.count])
                                        .frame(width: proxy.size.width * CGFloat(percent(votes, total)) / 100)
                                }
                            }
                            .frame(height: 5)
                        }
                        Text("\(percent(votes, total))%")
                            .font(.system(size: 16, weight: .heavy)).monospacedDigit()
                            .foregroundColor(leading ? Theme.onAccent : Theme.text)
                            .frame(minWidth: 56, minHeight: 36)
                            .background(leading ? Theme.accent : Theme.background)
                            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    .frame(minHeight: 60)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(name), \(votes) \(votes == 1 ? "vote" : "votes"), \(percent(votes, total)) percent")
                }
            }
        }
        .padding(16)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func percent(_ part: Int, _ whole: Int) -> Int {
        whole == 0 ? 0 : Int((Double(part) / Double(whole) * 100).rounded())
    }

    private func caption(total: Int, leader: (offset: Int, element: Int)?, runnerUp: (offset: Int, element: Int)?, tied: Bool) -> String {
        guard total > 0, let leader else { return "No votes yet" }
        let name = race.candidates[leader.offset]
        guard let runnerUp else { return "\(name) leads" }
        if tied { return "\(name) and \(race.candidates[runnerUp.offset]) are tied" }
        let margin = leader.element - runnerUp.element
        return "\(name) leads by \(margin) \(margin == 1 ? "vote" : "votes")"
    }
}

struct AccountTab: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirming = false

    var body: some View {
        Screen(title: "Account") {
            VStack(spacing: 0) {
                row("Status", "Registered")
                row("Ballot", model.account?.ballotTitle ?? "")
                row("Races", "\(model.account?.raceCount ?? 0)")
                row("Registration", short(model.account?.signature ?? ""))
                row("Passport", "Verified on this phone")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Election server").font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.secondary)
                TextField("", text: $model.serverHost)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .font(.system(size: 17, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 14)
                    .frame(minHeight: 48)
                    .background(Theme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityLabel("Election server address")
                Text("The election server's address.")
                    .font(.system(size: 13, weight: .medium)).foregroundColor(Theme.secondary)
            }

            Button("Delete account") { confirming = true }
                .buttonStyle(DangerButtonStyle())
                .padding(.top, 8)
            Text("Deleting removes your voting code from this phone so you can start over. Your registration stays on Solana.")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .confirmationDialog("Delete your voter ID from this phone?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Delete account", role: .destructive) { model.deleteAccount() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You will not be able to vote with this ID after deleting it.")
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(label).foregroundColor(Theme.secondary)
                Spacer()
                Text(value).fontWeight(.semibold)
            }
            .font(.system(size: 15, weight: .medium))
            .frame(minHeight: 48)
            Rectangle().fill(Theme.divider).frame(height: 1)
        }
    }

    private func short(_ text: String) -> String {
        text.count <= 14 ? text : "\(text.prefix(6))…\(text.suffix(6))"
    }
}
