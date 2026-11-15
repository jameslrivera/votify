import Foundation

public enum DERError: Error, Equatable {
    case truncated
    case indefiniteLength
    case unsupportedTag
    case unexpected(String)
}

public struct DERElement {
    public let tag: UInt8
    public let start: Int
    public let contentStart: Int
    public let end: Int
    let buffer: [UInt8]

    public var isConstructed: Bool { tag & 0x20 != 0 }
    public var content: [UInt8] { Array(buffer[contentStart..<end]) }
    public var raw: [UInt8] { Array(buffer[start..<end]) }
    public var contentLength: Int { end - contentStart }

    public static func parse(_ buffer: [UInt8], at offset: Int = 0, limit: Int? = nil) throws -> DERElement {
        let limit = limit ?? buffer.count
        guard offset + 2 <= limit else { throw DERError.truncated }
        let tag = buffer[offset]
        guard tag & 0x1f != 0x1f else { throw DERError.unsupportedTag }
        var pos = offset + 1
        let first = buffer[pos]
        pos += 1
        var length = 0
        if first < 0x80 {
            length = Int(first)
        } else if first == 0x80 {
            throw DERError.indefiniteLength
        } else {
            let count = Int(first & 0x7f)
            guard count <= 4, pos + count <= limit else { throw DERError.truncated }
            for _ in 0..<count {
                length = (length << 8) | Int(buffer[pos])
                pos += 1
            }
        }
        guard pos + length <= limit else { throw DERError.truncated }
        return DERElement(tag: tag, start: offset, contentStart: pos, end: pos + length, buffer: buffer)
    }

    public func children() throws -> [DERElement] {
        guard isConstructed else { throw DERError.unexpected("element 0x\(String(tag, radix: 16)) is not constructed") }
        var out: [DERElement] = []
        var pos = contentStart
        while pos < end {
            let child = try DERElement.parse(buffer, at: pos, limit: end)
            out.append(child)
            pos = child.end
        }
        return out
    }

    public func child(_ index: Int, tag expected: UInt8? = nil) throws -> DERElement {
        let kids = try children()
        guard index < kids.count else { throw DERError.unexpected("missing child \(index)") }
        if let expected, kids[index].tag != expected {
            throw DERError.unexpected(
                "expected tag 0x\(String(expected, radix: 16)), found 0x\(String(kids[index].tag, radix: 16))")
        }
        return kids[index]
    }

    public func oid() throws -> String {
        guard tag == 0x06, contentLength > 0 else { throw DERError.unexpected("not an OID") }
        let bytes = content
        var parts: [UInt64] = [UInt64(bytes[0] / 40), UInt64(bytes[0] % 40)]
        var value: UInt64 = 0
        for b in bytes.dropFirst() {
            value = (value << 7) | UInt64(b & 0x7f)
            if b & 0x80 == 0 {
                parts.append(value)
                value = 0
            }
        }
        return parts.map(String.init).joined(separator: ".")
    }

    public func smallInt() throws -> Int {
        guard tag == 0x02, contentLength >= 1, contentLength <= 8 else { throw DERError.unexpected("not a small INTEGER") }
        return content.reduce(0) { ($0 << 8) | Int($1) }
    }

    public func unsignedIntegerBytes() throws -> [UInt8] {
        guard tag == 0x02 else { throw DERError.unexpected("not an INTEGER") }
        var bytes = content
        while bytes.count > 1, bytes[0] == 0 { bytes.removeFirst() }
        return bytes
    }
}
