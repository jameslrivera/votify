import Foundation

public enum SODError: Error, Equatable {
    case notASOD(String)
    case unsupported(String)
}

public struct SOD {
    public let dataGroupHashAlgorithm: HashAlgorithm
    public let dataGroupHashes: [Int: [UInt8]]
    public let eContent: [UInt8]
    public let dataGroupHashOffsets: [Int: Int]

    public let signerDigestAlgorithm: HashAlgorithm
    public let signedAttributes: [UInt8]
    public let messageDigest: [UInt8]
    public let messageDigestOffset: Int

    public let signatureAlgorithmOID: String
    public let signatureScheme: SignatureScheme
    public let signature: [UInt8]

    public let documentSigningCertificate: [UInt8]
    public let certificateCount: Int

    public init(_ file: [UInt8]) throws {
        var root = try DERElement.parse(file)
        if root.tag == 0x77 { root = try root.child(0, tag: 0x30) }
        guard root.tag == 0x30 else { throw SODError.notASOD("no ContentInfo") }
        guard try root.child(0, tag: 0x06).oid() == OID.signedData else { throw SODError.notASOD("not SignedData") }
        let signedData = try root.child(1, tag: 0xa0).child(0, tag: 0x30)
        let parts = try signedData.children()

        guard let encap = parts.first(where: { $0.tag == 0x30 }) else { throw SODError.notASOD("no encapContentInfo") }
        let eContentOctets = try encap.child(1, tag: 0xa0).child(0)
        guard eContentOctets.tag == 0x04 else { throw SODError.unsupported("eContent is not a primitive OCTET STRING") }
        let eContent = eContentOctets.content
        self.eContent = eContent

        let lds = try DERElement.parse(eContent)
        let ldsHashOID = try lds.child(1, tag: 0x30).child(0, tag: 0x06).oid()
        guard let ldsHash = HashAlgorithm(oid: ldsHashOID) else { throw SODError.unsupported("hash \(ldsHashOID)") }
        self.dataGroupHashAlgorithm = ldsHash
        var hashes: [Int: [UInt8]] = [:]
        var offsets: [Int: Int] = [:]
        for entry in try lds.child(2, tag: 0x30).children() {
            let number = try entry.child(0, tag: 0x02).smallInt()
            let value = try entry.child(1, tag: 0x04)
            hashes[number] = value.content
            offsets[number] = value.contentStart
        }
        self.dataGroupHashes = hashes
        self.dataGroupHashOffsets = offsets

        let certs = try parts.first(where: { $0.tag == 0xa0 })?.children() ?? []
        guard let dsc = certs.first else { throw SODError.unsupported("SOD carries no certificate") }
        self.documentSigningCertificate = dsc.raw
        self.certificateCount = certs.count

        guard let signerInfos = parts.last(where: { $0.tag == 0x31 }), signerInfos.start > encap.start else {
            throw SODError.notASOD("no signerInfos")
        }
        let signer = try signerInfos.child(0, tag: 0x30).children()
        guard signer.count >= 5 else { throw SODError.notASOD("short SignerInfo") }
        let digestOID = try signer[2].child(0, tag: 0x06).oid()
        guard let signerDigest = HashAlgorithm(oid: digestOID) else { throw SODError.unsupported("hash \(digestOID)") }
        self.signerDigestAlgorithm = signerDigest
        guard signer[3].tag == 0xa0 else { throw SODError.unsupported("SignerInfo has no signedAttributes") }
        var attrs = signer[3].raw
        attrs[0] = 0x31
        self.signedAttributes = attrs

        var digest: [UInt8]?
        var digestOffset = 0
        for attr in try signer[3].children() {
            if try attr.child(0, tag: 0x06).oid() == OID.messageDigest {
                let value = try attr.child(1, tag: 0x31).child(0, tag: 0x04)
                digest = value.content
                digestOffset = value.contentStart - signer[3].start
            }
        }
        guard let digest else { throw SODError.notASOD("no messageDigest attribute") }
        self.messageDigest = digest
        self.messageDigestOffset = digestOffset

        let sigAlg = signer[4]
        let sigOID = try sigAlg.child(0, tag: 0x06).oid()
        self.signatureAlgorithmOID = sigOID
        if sigOID == OID.rsaEncryption {
            self.signatureScheme = .rsaPKCS1v15(signerDigest)
        } else if let h = OID.rsaWithHash[sigOID] {
            self.signatureScheme = .rsaPKCS1v15(h)
        } else if let h = OID.ecdsaWithHash[sigOID] {
            self.signatureScheme = .ecdsa(h)
        } else if sigOID == OID.rsaPSS {
            self.signatureScheme = try SOD.parsePSS(sigAlg)
        } else {
            throw SODError.unsupported("signature algorithm \(sigOID)")
        }
        guard signer[5].tag == 0x04 else { throw SODError.notASOD("no signature") }
        self.signature = signer[5].content
    }

    private static func parsePSS(_ algorithm: DERElement) throws -> SignatureScheme {
        var hash = HashAlgorithm.sha1
        var salt = 20
        let kids = try algorithm.children()
        if kids.count > 1, kids[1].tag == 0x30 {
            for p in try kids[1].children() {
                switch p.tag {
                case 0xa0:
                    let oid = try p.child(0, tag: 0x30).child(0, tag: 0x06).oid()
                    guard let h = HashAlgorithm(oid: oid) else { throw SODError.unsupported("PSS hash \(oid)") }
                    hash = h
                case 0xa2:
                    salt = try p.child(0, tag: 0x02).smallInt()
                default:
                    break
                }
            }
        }
        return .rsaPSS(hash, saltLength: salt)
    }
}

public struct CertificateKey: Equatable {
    public enum Kind: Equatable {
        case rsa(modulus: [UInt8], exponent: [UInt8])
        case ec(curve: String)
        case other(String)
    }
    public let kind: Kind

    public var bits: Int? {
        if case .rsa(let modulus, _) = kind {
            guard let first = modulus.first else { return 0 }
            return modulus.count * 8 - first.leadingZeroBitCount
        }
        return nil
    }

    public var description: String {
        switch kind {
        case .rsa(_, let e):
            let exp = e.count <= 8 ? String(e.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }) : "\(e.count * 8)-bit"
            return "RSA \(bits ?? 0) bits, exponent \(exp)"
        case .ec(let curve): return "EC \(curve)"
        case .other(let oid): return "unknown key type \(oid)"
        }
    }

    public init(certificate der: [UInt8]) throws {
        let tbs = try DERElement.parse(der).child(0, tag: 0x30)
        var fields = try tbs.children()
        if fields.first?.tag == 0xa0 { fields.removeFirst() }
        guard fields.count >= 6 else { throw DERError.unexpected("short TBSCertificate") }
        let spki = fields[5]
        let alg = try spki.child(0, tag: 0x30)
        let oid = try alg.child(0, tag: 0x06).oid()
        let bitString = try spki.child(1, tag: 0x03)
        switch oid {
        case OID.rsaEncryption, OID.rsaPSS:
            let key = try DERElement.parse(Array(bitString.content.dropFirst()))
            kind = .rsa(
                modulus: try key.child(0, tag: 0x02).unsignedIntegerBytes(),
                exponent: try key.child(1, tag: 0x02).unsignedIntegerBytes())
        case OID.ecPublicKey:
            let params = try alg.child(1)
            if params.tag == 0x06 {
                let curve = try params.oid()
                kind = .ec(curve: OID.curves[curve] ?? curve)
            } else {
                let fieldBytes = (bitString.contentLength - 2) / 2
                kind = .ec(curve: "explicit parameters, \(fieldBytes * 8)-bit field")
            }
        default:
            kind = .other(oid)
        }
    }
}
