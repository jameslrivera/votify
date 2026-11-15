import Foundation
import SwiftUI

struct Account: Codable, Equatable {
    var ballotTitle: String
    var raceCount: Int
    var signature: String
    var usedMockPassport: Bool
    var electionIds: [String]?
}

@MainActor
final class AppModel: ObservableObject {
    enum Stage: Equatable {
        case splash
        case intro
        case register
        case success
        case main
    }

    @Published var stage: Stage = .splash
    @Published var account: Account?
    @Published var serverHost: String {
        didSet { UserDefaults.standard.set(serverHost, forKey: Self.hostKey) }
    }

    private static let hostKey = "serverAddress"

    init() {
        let bundled = (Bundle.main.object(forInfoDictionaryKey: "DemoServerHost") as? String) ?? ""
        let saved = UserDefaults.standard.string(forKey: Self.hostKey) ?? ""
        serverHost = saved.isEmpty ? (bundled.isEmpty ? "127.0.0.1" : bundled) : saved
        account = Vault.loadAccount()
    }

    var relayer: Relayer { Relayer(host: serverHost) }

    func finishSplash() {
        stage = account == nil ? .intro : .main
    }

    func completeRegistration(credential: Credential, account: Account) throws {
        try Vault.saveCredential(credential.data)
        try Vault.saveAccount(account)
        self.account = account
        stage = .success
    }

    func resetIfBallotRestarted() async {
        guard stage == .main, let ids = account?.electionIds, !ids.isEmpty else { return }
        guard let ballot = try? await relayer.ballot(), !ballot.races.isEmpty else { return }
        if Set(ids).isDisjoint(with: ballot.races.map(\.electionId)) {
            deleteAccount()
        }
    }

    func deleteAccount() {
        Vault.deleteAll()
        account = nil
        stage = .intro
    }
}
