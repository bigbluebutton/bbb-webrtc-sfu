# CHANGELOG

All notable changes (from 2.13.0 onwards) will be documented in this file.
For previous changes, see the [release notes](https://github.com/bigbluebutton/bbb-webrtc-sfu/releases).

### UNRELEASED

* feat(mediasoup): add least-loaded worker balancing strategy
* feat(mediasoup): worker transposition (off by default)
* feat(audio): dynamic global audio bridge mechanism
* fix(audio): ignore TLO-incapable clients in hold/unhold metrics

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
