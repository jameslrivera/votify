import CommonCrypto
import Foundation

public enum HashAlgorithm: String, Equatable, CaseIterable {
    case sha1 = "SHA-1"
    case sha224 = "SHA-224"
    case sha256 = "SHA-256"
    case sha384 = "SHA-384"
    case sha512 = "SHA-512"

    public var digestLength: Int {
        switch self {
        case .sha1: return 20
        case .sha224: return 28
        case .sha256: return 32
        case .sha384: return 48
        case .sha512: return 64
        }
    }

    public init?(oid: String) {
        switch oid {
        case "1.3.14.3.2.26": self = .sha1
        case "2.16.840.1.101.3.4.2.4": self = .sha224
        case "2.16.840.1.101.3.4.2.1": self = .sha256
        case "2.16.840.1.101.3.4.2.2": self = .sha384
        case "2.16.840.1.101.3.4.2.3": self = .sha512
        default: return nil
        }
    }

    public func hash(_ data: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: digestLength)
        let n = CC_LONG(data.count)
        switch self {
        case .sha1: _ = CC_SHA1(data, n, &out)
        case .sha224: _ = CC_SHA224(data, n, &out)
        case .sha256: _ = CC_SHA256(data, n, &out)
        case .sha384: _ = CC_SHA384(data, n, &out)
        case .sha512: _ = CC_SHA512(data, n, &out)
        }
        return out
    }
}

public enum SignatureScheme: Equatable {
    case rsaPKCS1v15(HashAlgorithm)
    case rsaPSS(HashAlgorithm, saltLength: Int)
    case ecdsa(HashAlgorithm)

    public var description: String {
        switch self {
        case .rsaPKCS1v15(let h): return "RSA PKCS#1 v1.5 with \(h.rawValue)"
        case .rsaPSS(let h, let salt): return "RSA-PSS with \(h.rawValue), salt \(salt) bytes"
        case .ecdsa(let h): return "ECDSA with \(h.rawValue)"
        }
    }

    public var isRSASHA256PKCS1: Bool { self == .rsaPKCS1v15(.sha256) }
}

enum OID {
    static let signedData = "1.2.840.113549.1.7.2"
    static let ldsSecurityObject = "2.23.136.1.1.1"
    static let messageDigest = "1.2.840.113549.1.9.4"
    static let contentType = "1.2.840.113549.1.9.3"
    static let rsaEncryption = "1.2.840.113549.1.1.1"
    static let rsaPSS = "1.2.840.113549.1.1.10"
    static let ecPublicKey = "1.2.840.10045.2.1"

    static let rsaWithHash: [String: HashAlgorithm] = [
        "1.2.840.113549.1.1.5": .sha1,
        "1.2.840.113549.1.1.14": .sha224,
        "1.2.840.113549.1.1.11": .sha256,
        "1.2.840.113549.1.1.12": .sha384,
        "1.2.840.113549.1.1.13": .sha512,
    ]
    static let ecdsaWithHash: [String: HashAlgorithm] = [
        "1.2.840.10045.4.1": .sha1,
        "1.2.840.10045.4.3.1": .sha224,
        "1.2.840.10045.4.3.2": .sha256,
        "1.2.840.10045.4.3.3": .sha384,
        "1.2.840.10045.4.3.4": .sha512,
    ]
    static let curves: [String: String] = [
        "1.2.840.10045.3.1.7": "P-256",
        "1.3.132.0.34": "P-384",
        "1.3.132.0.35": "P-521",
        "1.3.36.3.3.2.8.1.1.7": "brainpoolP256r1",
        "1.3.36.3.3.2.8.1.1.11": "brainpoolP384r1",
        "1.3.36.3.3.2.8.1.1.13": "brainpoolP512r1",
    ]
}
