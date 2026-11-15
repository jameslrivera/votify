import SwiftUI

struct AnimatedCheckmark: View {
    var size: CGFloat = 140
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var ring: CGFloat = 0
    @State private var check: CGFloat = 0
    @State private var fill = false

    var body: some View {
        ZStack {
            Circle()
                .fill(Theme.accent)
                .scaleEffect(fill ? 1 : 0.2)
                .opacity(fill ? 1 : 0)
            Circle()
                .trim(from: 0, to: ring)
                .stroke(Theme.accentText, style: StrokeStyle(lineWidth: size * 0.05, lineCap: .round))
                .rotationEffect(.degrees(-90))
            CheckShape()
                .trim(from: 0, to: check)
                .stroke(Color.white, style: StrokeStyle(lineWidth: size * 0.09, lineCap: .round, lineJoin: .round))
                .frame(width: size * 0.46, height: size * 0.34)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onAppear {
            if reduceMotion {
                ring = 1
                check = 1
                fill = true
                return
            }
            withAnimation(.easeOut(duration: 0.5)) { ring = 1 }
            withAnimation(.spring(response: 0.5, dampingFraction: 0.65).delay(0.35)) { fill = true }
            withAnimation(.easeOut(duration: 0.35).delay(0.6)) { check = 1 }
        }
    }
}

struct CheckShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.36, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

struct SuccessView: View {
    @EnvironmentObject private var model: AppModel
    @State private var shown = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            AnimatedCheckmark()
            VStack(spacing: 10) {
                Text("You're registered")
                    .font(.system(size: 32, weight: .heavy))
                Text(model.account.map { "You can vote in \($0.raceCount) races in the \($0.ballotTitle). Your name and passport number were never sent." }
                    ?? "Your anonymous voter ID is on Solana. Your name and passport number were never sent.")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundColor(Theme.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if let signature = model.account?.signature {
                    Text("Transaction \(signature.prefix(8))…\(signature.suffix(8))")
                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                        .foregroundColor(Theme.secondary)
                        .padding(.top, 6)
                }
            }
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 12)
            Spacer()
            Button("Continue") { model.stage = .main }
                .buttonStyle(PrimaryButtonStyle())
                .opacity(shown ? 1 : 0)
        }
        .padding(24)
        .onAppear {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            withAnimation(.easeOut(duration: 0.4).delay(0.9)) { shown = true }
        }
    }
}
