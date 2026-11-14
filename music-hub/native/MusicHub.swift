import AppKit
import WebKit
import Foundation

private let serverURL = URL(string: "http://127.0.0.1:18769/music-hub/index.html")!
private let healthURL = URL(string: "http://127.0.0.1:18769/api/music-hub/state")!

final class MusicHubApplication: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var attempt = 0
    private var started = false
    private var initialLoad = false
    private var controllerDiagnosticsTimer: Timer?
    private var controllerDiagnosticsBusy = false
    private var nativeRustProcess: Process?
    private var rustAudioLog: FileHandle?
    private var monitoringPhysicalFader = false
    private var lastPhysicalEventCount = -1
    private let project = ProcessInfo.processInfo.environment["REKORDBOX_MCP_ROOT"] ?? FileManager.default.currentDirectoryPath

    func applicationDidFinishLaunching(_ notification: Notification) {
        let mainMenu = NSMenu()
        let appMenu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)
        appMenu.addItem(withTitle: "About Rekordbox Music Hub", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Rekordbox Music Hub", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Test FLX4 Playback", action: #selector(testFLX4Playback), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Test FLX4 Crossfader", action: #selector(testFLX4Crossfader), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Test FLX4 Full Mixer", action: #selector(testFLX4FullMixer), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Monitor Physical FLX4 Fader", action: #selector(togglePhysicalFaderMonitor(_:)), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Open Vintage Sampler Lab (Separate App)", action: #selector(openVintageSamplerLab), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Activate Rust Audio Engine", action: #selector(activateRustAudio), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Return to Web Audio Engine", action: #selector(deactivateRustAudio), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Profile FLX4 Browse Latency", action: #selector(profileFLX4Browse), keyEquivalent: "")
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)
        NSApp.mainMenu = mainMenu

        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // The physical DDJ-FLX4 PLAY button arrives through CoreMIDI/WebSocket,
        // not a browser click. WKWebView must allow that explicitly requested
        // local audio playback without requiring another mouse gesture first.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = true
        let size = NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = NSWindow(contentRect: size, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Rekordbox Music Hub"
        window.minSize = NSSize(width: 1050, height: 730)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        checkServer()
        startNativeRustAudioIfNeeded()
        controllerDiagnosticsTimer = Timer.scheduledTimer(timeInterval: 2.0, target: self,
            selector: #selector(captureControllerDiagnostics), userInfo: nil, repeats: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        // Only terminate the Rust process created by THIS app session.
        // Never signal rekordbox, the original audio server, or an unrelated
        // process that happens to own the same localhost port.
        if let process = nativeRustProcess, process.isRunning {
            process.terminate()
        }
        try? rustAudioLog?.close()
    }

    private func startNativeRustAudioIfNeeded() {
        let endpoint = URL(string: "http://127.0.0.1:18779/health")!
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 1.2
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let online = (response as? HTTPURLResponse)?.statusCode == 200 &&
                (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
                    .flatMap { $0["engine"] as? String } == "rust-cpal"
            if online {
                NSLog("Existing local Rust audio engine is ready; not starting duplicate.")
                return
            }
            DispatchQueue.main.async {
                self?.launchNativeRustAudio()
            }
        }.resume()
    }

    private func launchNativeRustAudio() {
        guard nativeRustProcess == nil else { return }
        let binary = URL(fileURLWithPath: project)
            .appendingPathComponent("rust/music-hub-audio/target/release/music-hub-audio")
        guard FileManager.default.isExecutableFile(atPath: binary.path) else {
            NSLog("Rust audio binary not installed; keeping Web Audio fallback.")
            return
        }
        let process = Process()
        process.executableURL = binary
        process.currentDirectoryURL = URL(fileURLWithPath: project)
        do {
            let dir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Logs")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let log = dir.appendingPathComponent("MusicHubRustAudio.gui.log")
            if !FileManager.default.fileExists(atPath: log.path) {
                FileManager.default.createFile(atPath: log.path, contents: Data())
            }
            let output = try FileHandle(forWritingTo: log)
            output.seekToEndOfFile()
            process.standardError = output
            process.standardOutput = output
            rustAudioLog = output
            try process.run()
            nativeRustProcess = process
            process.terminationHandler = { [weak self] finished in
                NSLog("Music Hub Rust audio child exited with status %d", finished.terminationStatus)
                DispatchQueue.main.async {
                    if self?.nativeRustProcess === finished {
                        self?.nativeRustProcess = nil
                    }
                }
            }
            NSLog("Music Hub launched Rust CoreAudio service from the native desktop session.")
        } catch {
            NSLog("Rust audio could not start: %@; Web Audio fallback remains enabled.",
                  error.localizedDescription)
        }
    }

    @objc private func captureControllerDiagnostics() {
        guard !controllerDiagnosticsBusy, webView.url?.host == "127.0.0.1" else { return }
        controllerDiagnosticsBusy = true
        // This snapshot is local-only and deliberately excludes audio paths,
        // passwords, device tokens, or library contents.
        let expression = """
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          url: window.location.pathname,
          controller: window.MusicHubPhysicalFLX4?.status?.() ?? null,
          mixer: window.MusicHubTopDecks?.mixerState?.() ?? null,
          rustAudio: window.MusicHubRustAudio?.status?.() ?? null,
          browsePerformance: window.MusicHubLastBrowseProfile ?? null,
          crossfaderTest: window.MusicHubLastCrossfaderTest ?? null,
          fullMixerTest: window.MusicHubLastFullMixerTest ?? null,
          playerReady: !!window.MusicHubTopDecks,
          appReady: !!window.MusicHubDesktopController
        })
        """
        webView.evaluateJavaScript(expression) { [weak self] result, error in
            guard let self = self else { return }
            self.controllerDiagnosticsBusy = false
            let report: String
            if let value = result as? String {
                report = value
                if self.monitoringPhysicalFader,
                   let data = value.data(using: .utf8),
                   let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   let controller = parsed["controller"] as? [String: Any],
                   let count = controller["hardwareMessages"] as? Int,
                   count != self.lastPhysicalEventCount {
                    self.lastPhysicalEventCount = count
                    let last = controller["lastEvent"] as? [String: Any] ?? [:]
                    let action = last["action"] as? String ?? "unknown"
                    if ["hardware_crossfader", "hardware_channel_fader", "hardware_eq", "hardware_trim"].contains(action),
                       last["diagnosticTest"] as? Bool != true {
                        NSLog("PHYSICAL FLX4 fader received: hardwareMessages=%ld action=%@ deck=%@ value=%@", count, action, String(describing: last["deck"] ?? "-"), String(describing: last["value"] ?? "-"))
                    } else {
                        NSLog("PHYSICAL FLX4 hardware event count=%ld, last=%@", count, action)
                    }
                }
            } else {
                let problem = (error?.localizedDescription ?? "WebView returned no status")
                    .replacingOccurrences(of: "\"", with: "'")
                report = "{\"error\":\"\(problem)\"}"
            }
            guard let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
            let file = dir.appendingPathComponent("Logs/RekordboxMusicHubFLX4Status.json")
            do {
                try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                    withIntermediateDirectories: true, attributes: nil)
                try Data(report.utf8).write(to: file, options: .atomic)
            } catch {
                NSLog("Controller diagnostics write unavailable: %@", error.localizedDescription)
            }
        }
    }

    @objc private func togglePhysicalFaderMonitor(_ sender: NSMenuItem) {
        monitoringPhysicalFader.toggle()
        sender.state = monitoringPhysicalFader ? .on : .off
        lastPhysicalEventCount = -1
        NSLog("Passive FLX4 physical fader monitor %@; genuine MIDI messages are counted separately from synthetic diagnostics", monitoringPhysicalFader ? "ON" : "OFF")
        if monitoringPhysicalFader { captureControllerDiagnostics() }
    }

    @objc private func testFLX4FullMixer() {
        // Only synthetic dispatch into the actual FLX4 event handler; no MIDI
        // is transmitted to hardware and no transport/play commands are sent.
        webView.evaluateJavaScript("""
        (() => {
          const m=window.MusicHubTopDecks, p=window.MusicHubPhysicalFLX4;
          const fail=reason=>JSON.stringify({ok:false,reason,kind:'synthetic',
            hardwareMessages:p?.status?.()?.hardwareMessages??null});
          if(!m?.mixerState||!m?.localStatus||!p?.processPhysical)
            return fail('Local mixer or FLX4 event handler unavailable; load the Music Hub page');
          const playback=m.localStatus(), before=m.mixerState(), physical=p.status?.()||{};
          if(!playback.deckA||!playback.deckB)
            return fail('Load a valid audio track into BOTH local decks first; missing/unavailable source file must be repaired in the library');
          if(playback.playingA||playback.playingB)
            return fail('Pause BOTH local decks before testing. No mixer values were changed');
          if(!before.audioGraphConnected?.every(Boolean)||
             !before.mediaReadyState?.every(n=>Number(n)>=1))
            return fail('Both actual audio decks must have loaded media and initialized audio graphs. Check missing source files and reload tracks');
          if(!physical.enabled||!physical.ready)
            return fail('Physical FLX4 bridge is not ready; synthetic event handler requires an open bridge');
          const emit=(action,value,deck,band)=>p.processPhysical({
            source:'physical_flx4',action,value,deck,band,diagnosticTest:true});
          const close=(a,b)=>Math.abs(a-b)<.0001;
          const checks=[];
          const check=(name,pass,observed)=>checks.push({name,pass,observed});
          const report={kind:'synthetic',startedAt:new Date().toISOString(),
            hardwareMessagesBefore:physical.hardwareMessages??null,checks};
          try {
            for(const d of [1,2]) {
              check('channel '+d+' unity',emit('hardware_channel_fader',1,d)&&
                close(m.mixerState().channelFaders[d-1],1),m.mixerState().channelFaders[d-1]);
            }
            for(const position of [0,.5,1]) {
              const accepted=emit('hardware_crossfader',position);
              const state=m.mixerState();
              const g=state.masterGain;
              check('crossfader '+position,accepted&&close(state.crossfade,position)&&
                (position===0?g[0]>.5&&g[1]<.0001:
                 position===1?g[1]>.5&&g[0]<.0001:g[0]>.1&&g[1]>.1),
                {crossfade:state.crossfade,masterGain:g});
            }
            for(const d of [1,2]) {
              check('channel '+d+' fader',emit('hardware_channel_fader',.37,d)&&
                close(m.mixerState().channelFaders[d-1],.37),m.mixerState().channelFaders[d-1]);
              check('channel '+d+' trim',emit('hardware_trim',.62,d)&&
                close(m.mixerState().trim[d-1],.62),m.mixerState().trim[d-1]);
              for(const band of ['low','mid','high']) {
                check('channel '+d+' '+band+' EQ',emit('hardware_eq',.28,d,band)&&
                  close(m.mixerState().eq[d-1][band],.28),m.mixerState().eq[d-1][band]);
              }
            }
          } catch(e) {report.error=String(e?.message||e).slice(0,180)}
          finally {
            // Restore all fields touched, including on partial dispatch failure.
            for(const d of [1,2]) {
              m.setChannelFader(d,before.channelFaders[d-1]);
              m.setTrim(d,before.trim[d-1]);
              for(const band of ['low','mid','high'])
                m.setEq(d,band,before.eq[d-1][band]);
            }
            m.setCrossfade(before.crossfade);
          }
          report.restored=close(m.mixerState().crossfade,before.crossfade)&&
            [0,1].every(i=>close(m.mixerState().channelFaders[i],before.channelFaders[i])&&
              close(m.mixerState().trim[i],before.trim[i])&&
              ['low','mid','high'].every(b=>close(m.mixerState().eq[i][b],before.eq[i][b])));
          report.hardwareMessagesAfter=p.status?.()?.hardwareMessages??null;
          report.ok=!report.error&&report.restored&&checks.every(c=>c.pass);
          report.endedAt=new Date().toISOString();
          window.MusicHubLastFullMixerTest=report;
          return JSON.stringify(report);
        })()
        """) { result, error in
            if let error = error {
                NSLog("FLX4 full mixer synthetic test failed: %@", error.localizedDescription)
            } else if let result = result {
                NSLog("FLX4 full mixer synthetic test: %@", String(describing: result))
            }
        }
    }

    @objc private func testFLX4Playback() {
        webView.evaluateJavaScript("window.MusicHubPhysicalFLX4?.selfTest?.() ?? 'Not installed'") {
            _, error in
            if let error = error { NSLog("FLX4 local test: %@", error.localizedDescription) }
        }
    }

    @objc private func activateRustAudio() {
        webView.evaluateJavaScript("void window.MusicHubRustAudio?.activate?.()") { _, error in
            if let error = error {
                NSLog("Rust audio activation failed: %@", error.localizedDescription)
            }
        }
    }

    @objc private func openVintageSamplerLab() {
        // The sampler is a separate macOS application. Never render its pads
        // inside Music Hub or take over its MIDI/direct-audio service.
        let app = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications/Vintage Sampler Lab.app")
        guard FileManager.default.fileExists(atPath: app.path) else {
            let alert = NSAlert()
            alert.messageText = "Vintage Sampler Lab is not installed"
            alert.informativeText = "Music Hub remains available; install the standalone sampler app to use its separate window."
            alert.runModal()
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: app, configuration: configuration) { _, error in
            if let error = error {
                NSLog("Could not open the separate Vintage Sampler Lab app: %@", error.localizedDescription)
            }
        }
    }

    @objc private func deactivateRustAudio() {
        webView.evaluateJavaScript("void window.MusicHubRustAudio?.deactivate?.()") { _, error in
            if let error = error {
                NSLog("Rust audio fallback failed: %@", error.localizedDescription)
            }
        }
    }

    @objc private func testFLX4Crossfader() {
        // Contract test of the real mixer graph in the installed WKWebView,
        // not a claim that any physical knob was moved by this test.
        webView.evaluateJavaScript("""
        (() => {
          const mixer=window.MusicHubTopDecks;
          if(!mixer?.setCrossfade||!mixer?.mixerState)
            return JSON.stringify({ok:false,error:'Local audio mixer is unavailable'});
          const before=mixer.mixerState();
          const playback=mixer.localStatus?.()||{};
          if(playback.playingA||playback.playingB)
            return JSON.stringify({skipped:true,reason:'Do not change faders while music is playing'});
          try{
            mixer.setChannelFader(1,1);mixer.setChannelFader(2,1);
            mixer.setCrossfade(0); const left=mixer.mixerState().masterGain;
            mixer.setCrossfade(.5); const center=mixer.mixerState().masterGain;
            mixer.setCrossfade(1); const right=mixer.mixerState().masterGain;
            const ok=left[0]>0 && left[1]<.0001 &&
              right[1]>0 && right[0]<.0001 &&
              center[0]>0 && center[1]>0;
            window.MusicHubLastCrossfaderTest={ok,left,center,right,
              timestamp:new Date().toISOString()};
            return JSON.stringify(window.MusicHubLastCrossfaderTest);
          }finally{
            mixer.setCrossfade(before.crossfade);
            mixer.setChannelFader(1,before.channelFaders[0]);
            mixer.setChannelFader(2,before.channelFaders[1]);
          }
        })()
        """) { result, error in
            if let error=error {
                NSLog("FLX4 crossfader contract test error: %@", error.localizedDescription)
            } else if let result=result {
                NSLog("FLX4 crossfader contract test: %@", String(describing: result))
            }
        }
    }

    @objc private func profileFLX4Browse() {
        webView.evaluateJavaScript("""
        window.MusicHubLastBrowseProfile =
            window.MusicHubDesktopController?.profileBrowse?.(50) ?? {error:'Profiler unavailable'};
        JSON.stringify(window.MusicHubLastBrowseProfile)
        """) { result, error in
            if let error = error {
                NSLog("FLX4 browse benchmark failed: %@", error.localizedDescription)
            } else if let result = result {
                NSLog("FLX4 browse benchmark: %@", String(describing: result))
            }
        }
    }

    private func freshMusicHubRequest() -> URLRequest {
        // Native UI restarts must fetch the latest script with the controller
        // listener. WebKit's old disk cache kept the FLX4 listener disconnected
        // until an explicit menu Reload.
        URLRequest(url: serverURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    }

    @objc private func reload() { webView.load(freshMusicHubRequest()) }

    private func checkServer() {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let response = response as? HTTPURLResponse, response.statusCode == 200 {
                    if !self.initialLoad {
                        self.initialLoad = true
                        self.webView.load(self.freshMusicHubRequest())
                    }
                    return
                }
                if !self.started {
                    self.started = true
                    self.startServer()
                }
                self.attempt += 1
                if self.attempt < 40 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.checkServer() }
                } else {
                    self.showError("Could not connect to Music Hub. Confirm the project workspace and its .venv are available, then choose View > Reload.")
                }
            }
        }.resume()
    }

    private func startServer() {
        let python = project + "/.venv/bin/python"
        let script = project + "/music_hub_server.py"
        guard FileManager.default.fileExists(atPath: python), FileManager.default.fileExists(atPath: script) else {
            showError("Music Hub workspace is missing: " + project)
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = [script]
        process.currentDirectoryURL = URL(fileURLWithPath: project, isDirectory: true)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch { showError("Could not launch Music Hub server: " + error.localizedDescription) }
    }

    private func showError(_ message: String) {
        webView.loadHTMLString("""
        <html><body style="margin:0;background:#101218;color:#e9edf4;font:17px -apple-system,system-ui;display:grid;place-items:center;height:100vh"><div style="max-width:650px;padding:40px"><h2>Music Hub</h2><p>\(message)</p></div></body></html>
        """, baseURL: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http", url.host == "127.0.0.1", url.port == 18769 {
            decisionHandler(.allow)
        } else if url.scheme == "about" || url.scheme == "blob" {
            decisionHandler(.allow)
        } else if url.scheme == "https", navigationAction.targetFrame?.isMainFrame == false,
                  isOfficialMusicEmbed(url) {
            // Only selected, official third-party *subframe players* are allowed
            // inside the native DJ window. Their own playback and account
            // access remain with the original streaming providers, not our app.
            // All other external navigations open in the system browser.
            decisionHandler(.allow)
        } else {
            if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    private func isOfficialMusicEmbed(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        switch host {
        case "open.spotify.com": return url.path.hasPrefix("/embed/")
        case "embed.music.apple.com": return url.path.hasPrefix("/")
        case "w.soundcloud.com": return url.path == "/player/" || url.path == "/player"
        default: return false
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Provider embeds commonly open external login/artist pages in a new
        // tab. Never route those into the local app's single trusted window.
        if let target = navigationAction.request.url,
           ["https", "http", "mailto"].contains(target.scheme ?? "") {
            NSWorkspace.shared.open(target)
        }
        return nil
    }

    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    @available(macOS 11.3, *)
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.begin { reply in completionHandler(reply == .OK ? panel.url : nil) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError("Music Hub could not load: " + error.localizedDescription)
    }
}

let app = NSApplication.shared
let delegate = MusicHubApplication()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
