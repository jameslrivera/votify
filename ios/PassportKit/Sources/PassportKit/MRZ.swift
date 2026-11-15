import Foundation

public struct MRZInfo: Equatable {
    public let documentNumber: String
    public let nationality: String
    public let dateOfBirth: String
    public let expiry: String

    public init(documentNumber: String, nationality: String, dateOfBirth: String, expiry: String) {
        self.documentNumber = documentNumber
        self.nationality = nationality
        self.dateOfBirth = dateOfBirth
        self.expiry = expiry
    }

    public var mrzKey: String {
        func withCheck(_ s: String) -> String { s + String(MRZ.checkDigit(s)) }
        return withCheck(documentNumber) + withCheck(dateOfBirth) + withCheck(expiry)
    }
}

public enum MRZ {
    public static func checkDigit(_ s: String) -> Int {
        let weights = [7, 3, 1]
        var sum = 0
        for (i, ch) in s.unicodeScalars.enumerated() {
            let v: Int
            switch ch.value {
            case 48...57: v = Int(ch.value) - 48
            case 65...90: v = Int(ch.value) - 55
            default: v = 0
            }
            sum += v * weights[i % 3]
        }
        return sum % 10
    }

    public static func manual(documentNumber: String, dateOfBirth: String, expiry: String) -> MRZInfo? {
        let doc = documentNumber.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        guard (1...9).contains(doc.count), isDate(dateOfBirth), isDate(expiry) else { return nil }
        return MRZInfo(
            documentNumber: doc.padding(toLength: 9, withPad: "<", startingAt: 0),
            nationality: "",
            dateOfBirth: dateOfBirth,
            expiry: expiry)
    }

    static func isDate(_ s: String) -> Bool {
        guard s.count == 6, s.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        let mm = Int(s.dropFirst(2).prefix(2))!, dd = Int(s.suffix(2))!
        return (1...12).contains(mm) && (1...31).contains(dd)
    }

    public static func parseTD3Line2(_ raw: String) -> MRZInfo? {
        let line = normalise(raw)
        guard line.count == 44 else { return nil }
        let c = Array(line)
        func field(_ r: Range<Int>, numeric: Bool = false) -> String {
            let s = String(c[r])
            return numeric ? fixDigits(s) : s
        }
        let doc = field(0..<9)
        let nationality = field(10..<13)
        let dob = field(13..<19, numeric: true)
        let expiry = field(21..<27, numeric: true)
        let optional = field(28..<42)
        let checks = [9, 19, 27, 42, 43].map { fixDigits(String(c[$0])) }
        guard checks.allSatisfy({ $0.first?.isNumber == true }), isDate(dob), isDate(expiry) else { return nil }
        let digit = { (i: Int) in Int(checks[i])! }
        guard checkDigit(doc) == digit(0), checkDigit(dob) == digit(1), checkDigit(expiry) == digit(2),
            checkDigit(optional) == digit(3)
        else { return nil }
        let composite = doc + checks[0] + dob + checks[1] + expiry + checks[2] + optional + checks[3]
        guard checkDigit(composite) == digit(4) else { return nil }
        guard nationality.allSatisfy({ $0.isLetter || $0 == "<" }) else { return nil }
        return MRZInfo(documentNumber: doc, nationality: nationality, dateOfBirth: dob, expiry: expiry)
    }

    public static func find(in recognised: [String]) -> MRZInfo? {
        for s in recognised {
            if let info = parseTD3Line2(s) { return info }
        }
        return nil
    }

    static func normalise(_ s: String) -> String {
        var out = ""
        for ch in s.uppercased() {
            switch ch {
            case " ", "\t": continue
            case "«", "‹", "＜": out.append("<")
            default: out.append(ch)
            }
        }
        return out
    }

    static func fixDigits(_ s: String) -> String {
        String(s.map { ch -> Character in
            switch ch {
            case "O", "Q", "D": return "0"
            case "I", "L": return "1"
            case "Z": return "2"
            case "S": return "5"
            case "B": return "8"
            case "<": return "0"
            default: return ch
            }
        })
    }
}

public enum DG1Layout {
    public static let length = 93
    public static let mrzStart = 5
    public static let nationality = 59..<62
    public static let dateOfBirth = 62..<68
    public static let expiry = 70..<76
    public static let documentNumber = 49..<58

    public static func matches(dg1: [UInt8], mrz: MRZInfo) -> Bool {
        guard dg1.count == length, dg1[0] == 0x61, dg1[2] == 0x5f, dg1[3] == 0x1f, dg1[4] == 88 else { return false }
        func at(_ r: Range<Int>) -> String { String(decoding: dg1[r], as: UTF8.self) }
        return at(dateOfBirth) == mrz.dateOfBirth && at(expiry) == mrz.expiry
            && at(documentNumber) == mrz.documentNumber
            && (mrz.nationality.isEmpty || at(nationality) == mrz.nationality)
    }
}
