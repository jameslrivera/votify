import Foundation

struct Race: Decodable, Equatable, Identifiable {
    let index: Int
    let office: String
    let district: String
    let electionId: String
    let candidates: [String]
    let tally: [Int]

    var id: String { electionId }
}

struct Ballot: Decodable, Equatable {
    let title: String
    let area: String
    let note: String
    let phase: String
    let registered: Int
    let rpcUrl: String
    let races: [Race]
}

struct RaceTransaction: Decodable, Equatable, Identifiable {
    let signature: String
    let time: Double?
    let kind: String
    let candidate: String?

    var id: String { signature }
}

struct RaceTransactions: Decodable {
    let transactions: [RaceTransaction]
}

struct Registration: Decodable {
    let race: Int
    let office: String
    let signature: String
}

struct RegistrationReceipt: Decodable {
    let registrations: [Registration]
}

struct RelayerFailure: Decodable {
    let message: String?
}

struct RelayerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct Relayer {
    let host: String

    private func url(_ path: String) throws -> URL {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let bare = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        let isLocal = bare == "localhost" || bare.allSatisfy { $0.isNumber || $0 == "." }
        let base = bare.contains("://") ? bare : (isLocal ? "http://\(bare):8787" : "https://\(bare)")
        guard !trimmed.isEmpty, let url = URL(string: base + path) else {
            throw RelayerError(message: "The server address is not valid. Set it in Account.")
        }
        return url
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw RelayerError(message: "Cannot reach the election server at \(host). Check the server address in Account.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw RelayerError(message: "The election server gave an unexpected reply.")
        }
        if http.statusCode != 200 {
            let failure = try? JSONDecoder().decode(RelayerFailure.self, from: data)
            throw RelayerError(message: failure?.message ?? "The election server refused the request.")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw RelayerError(message: "The election server gave an unexpected reply.")
        }
    }

    func ballot() async throws -> Ballot {
        var request = URLRequest(url: try url("/ballot"))
        request.timeoutInterval = 8
        return try await send(request)
    }

    func transactions(electionId: String) async throws -> [RaceTransaction] {
        var request = URLRequest(url: try url("/transactions?election=\(electionId)"))
        request.timeoutInterval = 8
        let result: RaceTransactions = try await send(request)
        return result.transactions
    }

    func prepareMock(credential: Credential) async {
        guard var request = try? URLRequest(url: url("/demo/prepare")) else { return }
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "secretHex": credential.secretHex,
            "nullifierKeyHex": credential.nullifierKeyHex,
        ])
        _ = try? await URLSession.shared.data(for: request)
    }

    func registerMock(credential: Credential) async throws -> RegistrationReceipt {
        var request = URLRequest(url: try url("/demo/register-mock"))
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "secretHex": credential.secretHex,
            "nullifierKeyHex": credential.nullifierKeyHex,
        ])
        return try await send(request)
    }
}
