import SwiftUI

@main
struct SolIDApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            switch model.stage {
            case .splash: SplashView().transition(.opacity)
            case .intro: IntroView().transition(.opacity)
            case .register: RegisterView().transition(.opacity)
            case .success: SuccessView().transition(.opacity)
            case .main: MainTabs().transition(.opacity)
            }
        }
        .foregroundColor(Theme.text)
        .animation(.easeInOut(duration: 0.35), value: model.stage)
    }
}
