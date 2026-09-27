// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HotMicCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "HotMicCore", targets: ["HotMicCore"])],
    targets: [
        .target(name: "HotMicCore"),
        // Runs on the Mac with only the command-line tools, where XCTest may be absent.
        .executableTarget(name: "hotmic-selfcheck", dependencies: ["HotMicCore"]),
    ]
)
