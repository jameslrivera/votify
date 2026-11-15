import SwiftUI

enum Theme {
    static let background = Color(hex: 0x0B0D10)
    static let surface = Color(hex: 0x171A1F)
    static let divider = Color(hex: 0x23272E)
    static let text = Color(hex: 0xF2F4F7)
    static let secondary = Color(hex: 0x9BA3AF)
    static let accent = Color(hex: 0x0E7A5A)
    static let accentText = Color(hex: 0x58C9A3)
    static let accentTint = Color(hex: 0x0F2A21)
    static let onAccent = Color(hex: 0xFFFFFF)
    static let candidates = [Color(hex: 0x4C8DFF), Color(hex: 0xFFB454), Color(hex: 0xC084FC)]
    static let danger = Color(hex: 0xFF7B7B)
    static let dangerTint = Color(hex: 0x2A1416)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundColor(Theme.onAccent)
            .background(Theme.accent.opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundColor(Theme.text.opacity(configuration.isPressed ? 0.6 : 1))
    }
}

struct DangerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold))
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundColor(Theme.danger)
            .background(Theme.dangerTint.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct LogoMark: View {
    var size: CGFloat = 96

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous).fill(Theme.accent)
            LogoCheck()
                .stroke(Color.white, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round, lineJoin: .round))
                .frame(width: size * 0.48, height: size * 0.36)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct LogoCheck: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.54))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.345, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

struct FailureBanner: View {
    let message: String?

    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.danger)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.dangerTint)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
