import XCTest

@testable import PassportKit

final class PassportKitTests: XCTestCase {
    static let line2 = "L898902C36USA7408122F1204159ZE184226B<<<<<10"

    func fixture(_ name: String) throws -> [UInt8] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "bin"))
        return [UInt8](try Data(contentsOf: url))
    }

    func testCheckDigits() {
        XCTAssertEqual(MRZ.checkDigit("L898902C3"), 6)
        XCTAssertEqual(MRZ.checkDigit("740812"), 2)
        XCTAssertEqual(MRZ.checkDigit("120415"), 9)
    }

    func testParsesSpecimenLineAndDerivesKey() throws {
        let info = try XCTUnwrap(MRZ.parseTD3Line2(Self.line2))
        XCTAssertEqual(info.documentNumber, "L898902C3")
        XCTAssertEqual(info.nationality, "USA")
        XCTAssertEqual(info.dateOfBirth, "740812")
        XCTAssertEqual(info.expiry, "120415")
        XCTAssertEqual(info.mrzKey, "L898902C3674081221204159")
    }

    func testToleratesOCRNoiseButNeverAcceptsBadCheckDigits() {
        XCTAssertNotNil(MRZ.parseTD3Line2("L898902C36USA74O8122F12O4I59ZE184226B«««««10"))
        XCTAssertNotNil(MRZ.find(in: ["PASSPORT", "P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", " " + Self.line2]))
        XCTAssertNil(MRZ.parseTD3Line2("L898902C36USA7408123F1204159ZE184226B<<<<<10"))
        XCTAssertNil(MRZ.parseTD3Line2("L898902C46USA7408122F1204159ZE184226B<<<<<10"))
        XCTAssertNil(MRZ.parseTD3Line2(String(Self.line2.dropLast())))
        XCTAssertNil(MRZ.find(in: ["hello", ""]))
    }

    func testManualEntry() {
        let info = MRZ.manual(documentNumber: "l898902c3", dateOfBirth: "740812", expiry: "120415")
        XCTAssertEqual(info?.mrzKey, "L898902C3674081221204159")
        XCTAssertEqual(MRZ.manual(documentNumber: "12345", dateOfBirth: "740812", expiry: "120415")?.documentNumber, "12345<<<<")
        XCTAssertNil(MRZ.manual(documentNumber: "L898902C3", dateOfBirth: "741312", expiry: "120415"))
        XCTAssertNil(MRZ.manual(documentNumber: "", dateOfBirth: "740812", expiry: "120415"))
    }

    func testDG1OffsetsMatchLayout() throws {
        let dg1 = try fixture("mock_dg1")
        XCTAssertEqual(dg1.count, 93)
        XCTAssertEqual(String(decoding: dg1[59...61], as: UTF8.self), "USA")
        XCTAssertEqual(String(decoding: dg1[62...67], as: UTF8.self), "740812")
        XCTAssertEqual(String(decoding: dg1[70...75], as: UTF8.self), "120415")
        let mrz = try XCTUnwrap(MRZ.parseTD3Line2(Self.line2))
        XCTAssertTrue(DG1Layout.matches(dg1: dg1, mrz: mrz))
        var other = dg1
        other[62] = UInt8(ascii: "9")
        XCTAssertFalse(DG1Layout.matches(dg1: other, mrz: mrz))
    }

    func testDER() throws {
        let el = try DERElement.parse([0x30, 0x06, 0x02, 0x01, 0x05, 0x04, 0x01, 0xff])
        XCTAssertEqual(try el.children().count, 2)
        XCTAssertEqual(try el.child(0, tag: 0x02).smallInt(), 5)
        XCTAssertEqual(try el.child(1).contentStart, 7)
        XCTAssertThrowsError(try el.child(0, tag: 0x04))
        XCTAssertThrowsError(try DERElement.parse([0x30, 0x05, 0x00]))
        XCTAssertThrowsError(try DERElement.parse([0x30, 0x80, 0x00, 0x00]))
        let oid = try DERElement.parse([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01])
        XCTAssertEqual(try oid.oid(), "2.16.840.1.101.3.4.2.1")
    }

    func testRSAPassportPassesAndFitsPlannedCircuit() throws {
        let dg1 = try fixture("mock_dg1")
        let sodFile = try fixture("mock_sod_rsa")
        let sod = try SOD(sodFile)
        XCTAssertEqual(sod.signatureScheme, .rsaPKCS1v15(.sha256))
        let dg1Offset = try XCTUnwrap(sod.dataGroupHashOffsets[1])
        XCTAssertEqual(Array(sod.eContent[dg1Offset..<dg1Offset + 32]), HashAlgorithm.sha256.hash(dg1))
        XCTAssertEqual(
            Array(sod.signedAttributes[sod.messageDigestOffset..<sod.messageDigestOffset + 32]),
            HashAlgorithm.sha256.hash(sod.eContent))
        XCTAssertEqual(sod.signedAttributes[0], 0x31)

        let report = try PassiveAuthentication.analyse(dg1: dg1, sod: sodFile, scannedMRZ: MRZ.parseTD3Line2(Self.line2))
        XCTAssertTrue(report.passiveAuthenticationPassed)
        XCTAssertTrue(report.matchesPlannedCircuit)
        XCTAssertEqual(report.dg1MatchesTD3Layout, true)
        XCTAssertEqual(report.key, "RSA 2048 bits, exponent 65537")
        XCTAssertEqual(report.signatureLength, 256)
        XCTAssertEqual(report.dataGroupsInSOD, [1, 2])
    }

    func testReportHoldsNoPersonalData() throws {
        let report = try PassiveAuthentication.analyse(
            dg1: try fixture("mock_dg1"), sod: try fixture("mock_sod_rsa"), scannedMRZ: MRZ.parseTD3Line2(Self.line2))
        for secret in ["ERIKSSON", "ANNA", "L898902C3", "740812", "120415", "ZE184226B"] {
            XCTAssertFalse(report.text.contains(secret), "report leaks \(secret)")
        }
    }

    func testTamperedDG1Fails() throws {
        var dg1 = try fixture("mock_dg1")
        dg1[62] ^= 1
        let report = try PassiveAuthentication.analyse(dg1: dg1, sod: try fixture("mock_sod_rsa"))
        XCTAssertFalse(report.dg1HashMatches)
        XCTAssertTrue(report.signatureValid)
        XCTAssertFalse(report.passiveAuthenticationPassed)
    }

    func testTamperedSODFails() throws {
        let good = try fixture("mock_sod_rsa")
        let sod = try SOD(good)
        var bad = good
        bad[bad.count - 1] ^= 1
        XCTAssertFalse(try PassiveAuthentication.analyse(dg1: try fixture("mock_dg1"), sod: bad).signatureValid)
        let needle = Array(sod.eContent.prefix(16))
        let at = try XCTUnwrap(good.indices.first { good[$0...].starts(with: needle) })
        var bad2 = good
        bad2[at + 40] ^= 1
        let r = try PassiveAuthentication.analyse(dg1: try fixture("mock_dg1"), sod: bad2)
        XCTAssertFalse(r.eContentHashMatches)
        XCTAssertFalse(r.passiveAuthenticationPassed)
    }

    func testECDSAPassportVerifiesButDoesNotFitPlannedCircuit() throws {
        let report = try PassiveAuthentication.analyse(dg1: try fixture("mock_dg1"), sod: try fixture("mock_sod_ecdsa"))
        XCTAssertTrue(report.passiveAuthenticationPassed)
        XCTAssertFalse(report.matchesPlannedCircuit)
        XCTAssertEqual(report.key, "EC P-256")
        XCTAssertEqual(report.signatureAlgorithm, "ECDSA with SHA-256")
    }

    func testRejectsGarbage() {
        XCTAssertThrowsError(try SOD([0x01, 0x02, 0x03]))
        XCTAssertThrowsError(try SOD([0x30, 0x03, 0x06, 0x01, 0x00]))
    }

    func testReadsTheTypeScriptMockPassport() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test-vectors/passports/valid-adult.mock.json")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(json["format"] as? String, "zk-election-passport/1")
        XCTAssertEqual(json["mock"] as? Bool, true)
        let dg1 = [UInt8](try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(json["dg1"] as? String))))
        let sod = [UInt8](try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(json["sod"] as? String))))

        let report = try PassiveAuthentication.analyse(dg1: dg1, sod: sod)
        XCTAssertTrue(report.passiveAuthenticationPassed)
        XCTAssertTrue(report.matchesPlannedCircuit)
        XCTAssertEqual(report.dataGroupsInSOD, [1, 2, 11, 12])
        XCTAssertEqual(report.eContentLength, 180)
        XCTAssertEqual(report.signedAttributesLength, 104)
        XCTAssertEqual(report.dg1HashOffsetInEContent, 31)
        XCTAssertEqual(report.eContentHashOffsetInSignedAttributes, 72)
    }
}
