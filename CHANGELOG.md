# CHANGELOG

All notable changes (from 2.13.0 onwards) will be documented in this file.
Intermediate pre-release changes will only be registered *separately* in their respective tag's CHANGELOG.
Final releases will consolidate all intermediate changes in chronological order.

For previous changes, see the [release notes](https://github.com/bigbluebutton/bbb-webrtc-sfu/releases).

### UNRELEASED

* feat(livekit): add support for recordFullDurationMedia=false

### v2.17.0-beta.3

* feat(livekit): add egress retry routines and Prometheus metrics
* fix(livekit): retry egress regardless of error type
* fix(livekit): handle egress shutdowns and assorted fixes

### v2.17.0-beta.2

* feat(livekit): handle camera ejections
* fix(livekit): unhandled exception when recordFullDurationMedia=false

### v2.17.0-beta.1

* fix(livekit): ignore participants other than STANDARD and SIP
* fix(livekit): do not send audio events to BBB if bridge is unused
* fix(livekit): clean up rooms on meeting end
* fix(livekit): add error handling to ParticipantLeft callback

### v2.17.0-beta.0

* refactor: remove unused MuteUserCmdMsg processor in bbb-gw
* fix(livekit): various adjustments to egress handling
* build: livekit-server-sdk@v2.9.3 (up from v2.6.2)
* build: @livekit/rtc-node@0.12.1 (up from 0.9.2)
* build: express@4.21.2 (up from 4.21.1)

### v2.17.0-alpha.5

* feat(livekit): add server domain to metadata

### v2.17.0-alpha.4

* fix(livekit): muteOnStart state inconsistency

### v2.17.0-alpha.3

* fix(livekit): treat screen share audio as separate tracks

### v2.17.0-alpha.2

* feat(livekit): sync screen share state with BBB
* fix(livekit): improve state sync and external user handling
* feat: add state sync and recording RPCs for LiveKit
* fix(core): onEvent is not a transaction, treat is as such
* fix: reorganize module forking to work around FIFO sched issues
* refactor(livekit): reorganize configs, add env var mappings
* refactor(livekit): handle mute requests server-side
* build: express@4.21.1
* build: mcs-js@0.0.21
* build: bump cross-spawn from 7.0.3 to 7.0.6 (transitive)

### v2.17.0-alpha.1

* feat: add `enabled` flag to SFU modules, default to true
* fix(livekit): do not sync stale egress instances
* build(livekit): add LiveKit submodule to base configuration

### v2.17.0-alpha.0

* feat(livekit): add track egress support
* feat(livekit): webhooks module
* feat(livekit): server side BBB <-> LiveKit event sync
* refactor(livekit): rename GenerateWebRtcToken* to GenerateLiveKitToken*
* feat: base-manager may opt out of connecting to mcs-core
* build(livekit-server-sdk): v2.6.2

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
