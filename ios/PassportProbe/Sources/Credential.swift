import Foundation
import LocalAuthentication
import Security

struct Credential {
    static let partLength = 31
    let data: Data

    static func random() throws -> Credential {
        var bytes = [UInt8](repeating: 0, count: partLength * 2)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw VaultError.randomFailed
        }
        return Credential(data: Data(bytes))
    }

    var secretHex: String { hex(data.prefix(Self.partLength)) }
    var nullifierKeyHex: String { hex(data.suffix(Self.partLength)) }

    var qrPayload: String {
        let encoded = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "zkv1:" + encoded
    }

    private func hex(_ bytes: Data) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}

enum VaultError: LocalizedError {
    case randomFailed
    case keychain(OSStatus)
    case missing

    var errorDescription: String? {
        switch self {
        case .randomFailed: return "This phone could not create a secure random code."
        case .keychain(let status): return "The secure storage on this phone returned an error (\(status))."
        case .missing: return "No voting code is stored on this phone."
        }
    }
}

enum Vault {
    private static let service = "solid.voter"
    private static let credentialKey = "credential"
    private static let accountKey = "account"

    private static func base(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    static func saveCredential(_ data: Data) throws {
        SecItemDelete(base(credentialKey) as CFDictionary)
        var query = base(credentialKey)
        query[kSecValueData as String] = data
        #if targetEnvironment(simulator)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        #else
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, nil) else {
            throw VaultError.keychain(errSecParam)
        }
        query[kSecAttrAccessControl as String] = access
        #endif
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
    }

    static func loadCredential(reason: String) async throws -> Credential {
        try await Task.detached(priority: .userInitiated) {
            let context = LAContext()
            context.localizedReason = reason
            var query = base(credentialKey)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            query[kSecUseAuthenticationContext as String] = context
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { throw VaultError.missing }
            guard status == errSecSuccess, let data = result as? Data, data.count == Credential.partLength * 2 else {
                throw VaultError.keychain(status)
            }
            return Credential(data: data)
        }.value
    }

    static func saveAccount(_ account: Account) throws {
        SecItemDelete(base(accountKey) as CFDictionary)
        var query = base(accountKey)
        query[kSecValueData as String] = try JSONEncoder().encode(account)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
    }

    static func loadAccount() -> Account? {
        var query = base(accountKey)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(Account.self, from: data)
    }

    static func deleteAll() {
        SecItemDelete(base(credentialKey) as CFDictionary)
        SecItemDelete(base(accountKey) as CFDictionary)
    }
}
