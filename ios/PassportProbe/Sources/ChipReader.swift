import Foundation
import NFCPassportReader
import PassportKit

enum ChipReadError: LocalizedError {
    case missingFile(String)

    var errorDescription: String? {
        switch self {
        case .missingFile(let name): return "The chip did not return \(name)."
        }
    }
}

enum ChipReader {
    static func readAndAnalyse(mrz: MRZInfo) async throws -> PassportReport {
        let reader = PassportReader()
        let passport = try await reader.readPassport(
            mrzKey: mrz.mrzKey,
            tags: [.DG1, .SOD],
            skipSecureElements: true,
            customDisplayMessage: { message in
                switch message {
                case .requestPresentPassport: return "Hold the top of your iPhone against the passport's back cover."
                case .successfulRead: return "Done. You can move your phone away."
                default: return nil
                }
            })
        guard var dg1 = passport.getDataGroup(.DG1)?.data else { throw ChipReadError.missingFile("DG1") }
        guard var sod = passport.getDataGroup(.SOD)?.data else { throw ChipReadError.missingFile("the security object (SOD)") }
        defer {
            dg1.resetBytes()
            sod.resetBytes()
        }
        return try PassiveAuthentication.analyse(dg1: dg1, sod: sod, scannedMRZ: mrz)
    }

    static func analyseMock() throws -> PassportReport {
        func load(_ name: String) throws -> [UInt8] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "bin", subdirectory: "Fixtures") else {
                throw ChipReadError.missingFile("mock fixture \(name)")
            }
            return [UInt8](try Data(contentsOf: url))
        }
        let mrz = MRZ.parseTD3Line2("L898902C36USA7408122F1204159ZE184226B<<<<<10")
        return try PassiveAuthentication.analyse(dg1: try load("mock_dg1"), sod: try load("mock_sod_rsa"), scannedMRZ: mrz)
    }
}

private extension Array where Element == UInt8 {
    mutating func resetBytes() {
        for i in indices { self[i] = 0 }
    }
}
