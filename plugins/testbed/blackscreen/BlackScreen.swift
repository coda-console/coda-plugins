import UIKit

// 纯黑全屏：测试机用完交出前切到这里（插件「测试机」的切黑屏），空闲时停着；OLED 黑色像素不发光，不烧屏。
// LCD（iPad）黑色仍有背光：在前台时把亮度压到最低，离开时还原，别的 App 和截图不受影响。
final class BlackViewController: UIViewController {
    override func loadView() {
        view = UIView()
        view.backgroundColor = .black
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var savedBrightness: CGFloat?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = BlackViewController()
        window?.makeKeyAndVisible()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        savedBrightness = savedBrightness ?? UIScreen.main.brightness
        UIScreen.main.brightness = 0
    }

    func applicationWillResignActive(_ application: UIApplication) {
        if let saved = savedBrightness {
            UIScreen.main.brightness = saved
            savedBrightness = nil
        }
    }
}
