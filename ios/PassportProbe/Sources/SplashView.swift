import SwiftUI

struct SplashView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        VStack(spacing: 20) {
            LogoMark(size: 120)
                .scaleEffect(shown || reduceMotion ? 1 : 0.6)
            Text("Votify")
                .font(.system(size: 40, weight: .heavy))
                .opacity(shown ? 1 : 0)
            Text("Private. Verifiable. Secure.")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.secondary)
                .opacity(shown ? 1 : 0)
        }
        .opacity(shown ? 1 : 0)
        .onAppear {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.7)) { shown = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { model.finishSplash() }
        }
    }
}

struct IntroView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer()
            LogoMark(size: 72)
            Text("Vote with\nyour passport.")
                .font(.system(size: 34, weight: .heavy))
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 18) {
                benefit("person.text.rectangle", "Register in seconds", "Scan your passport. That's all you need.")
                benefit("eye.slash", "Your info stays private", "Your name and passport number never leave your phone.")
                benefit("checkmark.seal", "Check the results yourself", "Every vote is counted in public on Solana.")
            }
            Spacer()
            Button("Continue") { model.stage = .register }.buttonStyle(PrimaryButtonStyle())
            Text("No forms, no passwords. Just your passport.")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(Theme.secondary)
                .frame(maxWidth: .infinity)
        }
        .padding(24)
    }

    private func benefit(_ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(Theme.accentText)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 17, weight: .bold))
                Text(detail).font(.system(size: 15, weight: .medium)).foregroundColor(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
