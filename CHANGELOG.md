# CHANGELOG

All notable changes (from 2.13.0 onwards) will be documented in this file.
Intermediate pre-release changes will only be registered *separately* in their respective tag's CHANGELOG.
Final releases will consolidate all intermediate changes in chronological order.

For previous changes, see the [release notes](https://github.com/bigbluebutton/bbb-webrtc-sfu/releases).

### v2.16.1

* fix(core): onEvent is not a transaction, treat is as such
* build: mcs-js@0.0.21

### v2.16.0

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
