# CHANGELOG

All notable changes (from 2.13.0 onwards) will be documented in this file.
Intermediate pre-release changes will only be registered *separately* in their respective tag's CHANGELOG.
Final releases will consolidate all intermediate changes in chronological order.

For previous changes, see the [release notes](https://github.com/bigbluebutton/bbb-webrtc-sfu/releases).

### UNRELEASED

* feat(livekit): add histogram metrics for mute/unmute duration
* fix(livekit): honor user-scoped conditional recording flags
* chore: disable Kurento by default in base/example config file

### v2.21.2

* fix(livekit): incorrect callerIdNum causes audio join failures
* build(deps): js-yaml@v4.1.1
* build(deps): express@v4.22.1

### v2.21.1

* fix(livekit): incorrect mute state with muteOnStart=false + eventSource=agent
* fix(livekit): race condition on token generation (clients fail to connect)

### v2.21.0

* feat(livekit): add agent conn state and event metrics
* feat: add docker matrix build to support arm64
* fix(livekit): add conn retry logic for RTC state sync agents
* fix(livekit): BBB state sync stalls on idle rooms
* fix(mediasoup): incorrect media direction causes tab sharing + audio to fail
* build: add environment variable to disable file logging
* build: remove QEMU setup from publish Docker workflow
* build(deps): livekit-server-sdk@2.14.0
* build(deps): @livekit/rtc-node@0.13.20
* build(deps): pino@10.1.0
* build(deps): pino-pretty@13.1.2
* build(deps): bump actions/checkout from 4 to 5

### v2.20.0

* feat(livekit): RTC-based event source (alternative to webhooks)
* feat: getRecordings primitive in bbb-webrtc-recorder client
* feat(livekit): add recording resync
* build: livekit-server-sdk@2.13.2

### v2.19.2

fix: bbb-webrtc-recorder heartbeat generates inaccurate crash alerts

### v2.19.1

* fix(livekit): forcefully unpublish screenshare when server ejects it
* fix(screenshare): ignore eject requests in mediasoup module if using LiveKit
* fix(livekit): discard camera/screen events if meeting is not using LiveKit

### v2.19.0

* feat(livekit): add manual subscription capabilities to internal RTC clients
* feat(livekit): token gen for breakout audio-only transfers
* feat(screenshare): add userId to screenshare RPCs
* feat: add support for camera recording consent flag
* feat(livekit): add flag to enable custom BBB permission checks
* feat(livekit): add metric for track publish handler errors
* feat(livekit): DTMF handling
* feat(livekit): implement SIP speaking detection
* fix(livekit): stop recording retry on track unavailable error
* fix(livekit): track unretriable start failures in Prom as error
* fix(livekit): add missing label to retry failure metric
* fix(livekit): guarantee internal RTC agent is hidden on BBB
* fix(livekit): incorrect RTC agent config parsing
* fix(livekit): recording fails due to incomplete track_publish event
* fix(livekit): don't create RTC clients for non-BBB meetings
* fix(livekit): incorrect metadata override for external participants
* fix: bbb-webrtc-recorder stop requests have no timeout
* fix: camera and screen states in BBB become stale on broken stop calls
* fix(livekit): incorrect parsing of dispatch and trunk rule options
* fix(livekit): SIP users have hardcoded `Phone ` prefix in their names
* fix(livekit): unhandled EjectUserFromVoiceConfSysMsg
* refactor(livekit): move RTC agent mgmt to its own module
* build: livekit-server-sdk@2.13.0
* build: @livekit/rtc-node@0.13.18
* build: transitive dep brace-expansion audit fix

### v2.18.3

* fix(livekit): false positive in recording error metric
* refactor(livekit): cleanup recordings directly on meeting end

### v2.18.2

* fix(livekit): improvements to recording retry loop and event mgmt

### v2.18.1

* chore(livekit): bbb-webrtc-recorder as the default recording adapter

### v2.18.0

* feat(livekit): support recording LiveKit streams through bbb-webrtc-recorder
* feat(livekit): add webrtc-recorder status and error metrics to LK module
* feat(livekit): add recorder reqs/resps counter metrics
* fix(livekit): make dial-in pin requirement configurable (default: false)
* fix(livekit): create inbound trunks based on voice bridge number
* fix(livekit): clean trunks and dispatch rules on restarts
* fix(livekit): attach room metadata to inbound trunks and dispatch rules
* fix(livekit): link dispatch rules to respective inbound trunks
* fix(livekit): expose inbound trunks and dispatch rules configs
* fix: restart loop on boot due to early requests
* fix(livekit): guarantee uniqueness of "external" LK users

### v2.17.1

* build(medisoup): 3.14.14 (without extra debug logs)

### v2.17.0

* feat(livekit): add track egress support
* feat(livekit): webhooks module
* feat(livekit): server side BBB <-> LiveKit event sync
* feat(livekit): add server domain to metadata
* feat: base-manager may opt out of connecting to mcs-core
* feat: add `enabled` flag to SFU modules, default to true
* feat: add state sync and recording RPCs for LiveKit
* feat(livekit): sync screen share state with BBB
* feat(livekit): handle camera ejections
* feat(livekit): add egress retry routines and Prometheus metrics
* feat(livekit): add support for recordFullDurationMedia=false
* feat(livekit): make egress retry timers configurable
* fix(livekit): do not sync stale egress instances
* fix(livekit): improve state sync and external user handling
* fix(core): onEvent is not a transaction, treat is as such
* fix: reorganize module forking to work around FIFO sched issues
* fix(livekit): treat screen share audio as separate tracks
* fix(livekit): muteOnStart state inconsistency
* fix(livekit): various adjustments to egress handling
* fix(livekit): ignore participants other than STANDARD and SIP
* fix(livekit): do not send audio events to BBB if bridge is unused
* fix(livekit): clean up rooms on meeting end
* fix(livekit): add error handling to ParticipantLeft callback
* fix(livekit): unhandled exception when recordFullDurationMedia=false
* fix(livekit): retry egress regardless of error type
* fix(livekit): handle egress shutdowns and assorted fixes
* fix(livekit): temporarily disable custom maxParticipants limit
* fix(freeswitch): UA fails due to unescaped `"/"` or malformed URI user
* fix(audio): TLO callerID matching is too strict
* fix(audio): channel incorrectly muted when transferring to breakout room
* fix(audio): handle global audio bridge failures
* fix(audio): make fs-consumer-bridge disconn handler verify current IDs
* chore(audio): add option to control when global audio restarts
* refactor(livekit): rename GenerateWebRtcToken* to GenerateLiveKitToken*
* build(livekit): add LiveKit submodule to base configuration
* build: mcs-js@0.0.21
* build: bump cross-spawn from 7.0.3 to 7.0.6 (transitive)
* build: express@4.21.2 (up from 4.21.1)
* build: livekit-server-sdk@2.10.2 (pinned)
* build: @livekit/rtc-node@0.13.6 (pinned)
* build(docker): Automatic build pipeline for docker images
* build(docker): Update build environment and Use multi stage builds
* build(docker): add .github folder to dockerignore
* build(docker): only push Docker images for release tags

### v2.16.0

* feat(livekit): add support for SIP trunking
* feat(mediasoup): pipe mediasoup logs to the application logger
* refactor(mediasoup): review log levels and metadata

### v2.15.0

* feat: add restartIce support for video/screenshare modules
* refactor: rename ICE restart flag to `restartIce`, true by default
* build: pino@9.3.2
* build: config@3.3.12
* build: ws@8.18.0
* build: bufferutil@4.0.8
* build: mcs-js@0.0.20
* build: uuid@10.0.0
* build: mediasoup-client@3.7.16
* build: mediasoup@3.14.14
* build: SIP.js@v0.7.5.14

### v2.14.2

* refactor(audio): set FLOWING logs to INFO level
* build(mediasoup): v3.14.11

### v2.14.1

* fix(screenshare): presenter/viewer stop logs on all scenarios
* refactor(screenshare): add presenter data to viewer logs
* refactor(video): add video negotiation and flowing logs
* build(mediasoup): 3.14.9

### v2.14.0

* feat(mediasoup): add least-loaded worker balancing strategy
* feat(mediasoup): worker transposition (off by default)
* feat(audio): dynamic global audio bridge mechanism
* feat: livekit module, initial implementation
* feat(audio): add signaling support for passive-sendrecv role
* feat(freeswitch): overridable UA string
* feat(audio): muteOnStart detection for conditional dialplans
* feat(audio): mute passive-sendrecv clients on start
* feat(audio): support for mute-and-hold on start
* fix(audio): ignore TLO-incapable clients in hold/unhold metrics
* fix(audio): mute/unmute stuck due to inconsistent hold status
* fix(audio): hold/unhold loop when there are multiple sessions per user
* fix(audio): muteOnStart sessions incorrectly muted on breakout transfers
* fix(audio): header-provided userName incorrectly decoded
* fix(audio): stuck unmute due to borked callerIdNum
* fix(audio): correctly decode user name space chars
* !build(npm): set min Node.js version to >=18.0.0
* build: nodemon@3.1.3
* build: ws@8.17.1
* build(mediasoup): 3.14.8

### v2.13.3

* fix(audio): user is deafened when transferring to breakout rooms
* build(mediasoup): 3.13.24

### v2.13.2

* feat: add incrementBy util to prometheus-agent
* feat(core): add event callback and dispatch metrics
* fix: another edge case where subprocesses fail to recover

### v2.13.1

* fix: subprocesses fail to recover from multiple crashes

### v2.13.0

* feat: add inbound queue size and job failure metrics
* feat: add dry-run recording mode
* feat: add time_to_mute/unmute metrics
* feat: add warn logs for when hold/mute actions exceed max bucket time
* feat(mediasoup): add mediasoup_ice_transport_protocol metric
* feat(mediasoup): per-worker resource metrics
* feat(mediasoup): add worker label to transport/router/prod/cons metrics
* fix(audio): log and track metrics for hold/unhold timeouts
* fix(bbb-webrtc-recorder): exception when removing nullish recording callbacks
* fix(mediasoup): check for null producers
* fix(screenshare): resolve subscriberAnswer job
* fix(audio): prevent false positives in TLO toggle metrics
* fix(test): wait for recorder to boot in stress test script
* fix: set appropriate initial bitrates
* fix(mediasoup): max bitrate for consumer-only transports not effective
* fix(mediasoup): missing rtcp-fb and header exts in consumer-only offers
* fix(audio): stricter adherence to router.mediaCodecs settings
* fix(video): exception when destructuring null camera source
* fix(mediasoup): only call consumer.changeProducer when appropriate
* fix(mediasoup): capture icestatechange == disconnected
* fix(mediasoup): invalid RTP header exts in default config
* refactor: replace logger lib, Winston -> Pino
* chore(mediasoup): expose webRtcTransport's iceConsentTimeout config
* build: mediasoup-client@3.7.4
* build: mediasoup@3.13.23
* build: bump Docker and nvmrc to Node.js 20 (LTS)
