import Foundation
import Security

public struct PassportReport: Equatable {
    public var dg1Length: Int
    public var dg1MatchesTD3Layout: Bool?
    public var sodLength: Int
    public var dataGroupsInSOD: [Int]
    public var dataGroupHashAlgorithm: String
    public var signerDigestAlgorithm: String
    public var signatureAlgorithm: String
    public var signatureAlgorithmOID: String
    public var key: String
    public var eContentLength: Int
    public var signedAttributesLength: Int
    public var signatureLength: Int
    public var certificateLength: Int
    public var certificateCount: Int
    public var dg1HashOffsetInEContent: Int?
    public var eContentHashOffsetInSignedAttributes: Int

    public var dg1HashMatches: Bool
    public var eContentHashMatches: Bool
    public var signatureValid: Bool
    public var signatureNote: String?

    public var matchesPlannedCircuit: Bool

    public var passiveAuthenticationPassed: Bool { dg1HashMatches && eContentHashMatches && signatureValid }

    public var text: String {
        func yn(_ b: Bool) -> String { b ? "yes" : "NO" }
        var lines = [
            "Votify passport report",
            "DG1 length: \(dg1Length) bytes",
            "DG1 matches TD3 layout and expected offsets: \(dg1MatchesTD3Layout.map(yn) ?? "not checked")",
            "SOD length: \(sodLength) bytes",
            "Data groups listed in SOD: \(dataGroupsInSOD.map(String.init).joined(separator: ", "))",
            "Data-group hash algorithm: \(dataGroupHashAlgorithm)",
            "Signer digest algorithm: \(signerDigestAlgorithm)",
            "Signature algorithm: \(signatureAlgorithm) (OID \(signatureAlgorithmOID))",
            "DSC key: \(key)",
            "eContent length: \(eContentLength) bytes",
            "signedAttributes length: \(signedAttributesLength) bytes",
            "Signature length: \(signatureLength) bytes",
            "DSC certificate length: \(certificateLength) bytes (certificates in SOD: \(certificateCount))",
            "DG1 hash offset in eContent: \(dg1HashOffsetInEContent.map(String.init) ?? "not found")",
            "eContent hash offset in signedAttributes: \(eContentHashOffsetInSignedAttributes)",
            "hash(DG1) found in eContent: \(yn(dg1HashMatches))",
            "hash(eContent) found in signedAttributes: \(yn(eContentHashMatches))",
            "SOD signature verifies under DSC key: \(yn(signatureValid))",
        ]
        if let signatureNote { lines.append("Note: \(signatureNote)") }
        lines.append("Raw SOD bytes available from NFCPassportReader: yes")
        lines.append("Fits planned circuit (RSA, SHA-256, PKCS#1 v1.5): \(yn(matchesPlannedCircuit))")
        return lines.joined(separator: "\n")
    }
}

public enum PassiveAuthentication {
    public static func analyse(dg1: [UInt8], sod sodFile: [UInt8], scannedMRZ: MRZInfo? = nil) throws -> PassportReport {
        let sod = try SOD(sodFile)
        let key = try CertificateKey(certificate: sod.documentSigningCertificate)

        let dg1Hash = sod.dataGroupHashAlgorithm.hash(dg1)
        let dg1Matches = sod.dataGroupHashes[1] == dg1Hash
        let eContentMatches = sod.signerDigestAlgorithm.hash(sod.eContent) == sod.messageDigest

        let (valid, note) = verifySignature(sod: sod)

        var rsaOK = false
        if case .rsa = key.kind { rsaOK = true }
        let fits = rsaOK && sod.signatureScheme.isRSASHA256PKCS1
            && sod.dataGroupHashAlgorithm == .sha256 && sod.signerDigestAlgorithm == .sha256

        return PassportReport(
            dg1Length: dg1.count,
            dg1MatchesTD3Layout: scannedMRZ.map { DG1Layout.matches(dg1: dg1, mrz: $0) },
            sodLength: sodFile.count,
            dataGroupsInSOD: sod.dataGroupHashes.keys.sorted(),
            dataGroupHashAlgorithm: sod.dataGroupHashAlgorithm.rawValue,
            signerDigestAlgorithm: sod.signerDigestAlgorithm.rawValue,
            signatureAlgorithm: sod.signatureScheme.description,
            signatureAlgorithmOID: sod.signatureAlgorithmOID,
            key: key.description,
            eContentLength: sod.eContent.count,
            signedAttributesLength: sod.signedAttributes.count,
            signatureLength: sod.signature.count,
            certificateLength: sod.documentSigningCertificate.count,
            certificateCount: sod.certificateCount,
            dg1HashOffsetInEContent: sod.dataGroupHashOffsets[1],
            eContentHashOffsetInSignedAttributes: sod.messageDigestOffset,
            dg1HashMatches: dg1Matches,
            eContentHashMatches: eContentMatches,
            signatureValid: valid,
            signatureNote: note,
            matchesPlannedCircuit: fits)
    }

    static func verifySignature(sod: SOD) -> (valid: Bool, note: String?) {
        guard let cert = SecCertificateCreateWithData(nil, Data(sod.documentSigningCertificate) as CFData),
            let key = SecCertificateCopyKey(cert)
        else {
            return (false, "The Security framework could not load the DSC public key (unsupported key type or curve).")
        }
        let algorithm: SecKeyAlgorithm
        switch sod.signatureScheme {
        case .rsaPKCS1v15(let h):
            algorithm =
                [
                    .sha1: .rsaSignatureMessagePKCS1v15SHA1, .sha224: .rsaSignatureMessagePKCS1v15SHA224,
                    .sha256: .rsaSignatureMessagePKCS1v15SHA256, .sha384: .rsaSignatureMessagePKCS1v15SHA384,
                    .sha512: .rsaSignatureMessagePKCS1v15SHA512,
                ][h]!
        case .rsaPSS(let h, let salt):
            guard salt == h.digestLength else {
                return (false, "RSA-PSS salt length \(salt) differs from the digest length; not verifiable here.")
            }
            algorithm =
                [
                    .sha1: .rsaSignatureMessagePSSSHA1, .sha224: .rsaSignatureMessagePSSSHA224,
                    .sha256: .rsaSignatureMessagePSSSHA256, .sha384: .rsaSignatureMessagePSSSHA384,
                    .sha512: .rsaSignatureMessagePSSSHA512,
                ][h]!
        case .ecdsa(let h):
            algorithm =
                [
                    .sha1: .ecdsaSignatureMessageX962SHA1, .sha224: .ecdsaSignatureMessageX962SHA224,
                    .sha256: .ecdsaSignatureMessageX962SHA256, .sha384: .ecdsaSignatureMessageX962SHA384,
                    .sha512: .ecdsaSignatureMessageX962SHA512,
                ][h]!
        }
        guard SecKeyIsAlgorithmSupported(key, .verify, algorithm) else {
            return (false, "The Security framework does not support this algorithm for this key.")
        }
        var error: Unmanaged<CFError>?
        let ok = SecKeyVerifySignature(
            key, algorithm, Data(sod.signedAttributes) as CFData, Data(sod.signature) as CFData, &error)
        error?.release()
        return (ok, nil)
    }
}
