'use strict'

const config = require('config');
const mediasoup = require('mediasoup');
const {
  workers: NOF_WORKERS,
  workerMode: WORKER_MODE,
  worker: WORKER_SETTINGS,
  router: ROUTER_SETTINGS = { mediaCodecs: mediasoup.getSupportedRtpCapabilities().codecs },
  webrtc: WEBRTC_TRANSPORT_SETTINGS,
  plainRtp: RTP_TRANSPORT_SETTINGS,
  debug: DEBUG,
  webRtcHeaderExts: WEBRTC_HEADER_EXTS,
  recorder: RECORDER,
} = config.get('mediasoup');

module.exports = {
  LOG_PREFIX: '[mediasoup-adp]',
  DEFAULT_NOF_WORKERS: 8,
  DEFAULT_MAX_BW: 0,
  NOF_WORKERS,
  WORKER_MODE,
  WORKER_SETTINGS,
  ROUTER_SETTINGS,
  WEBRTC_TRANSPORT_SETTINGS,
  RTP_TRANSPORT_SETTINGS,
  DEBUG,
  WEBRTC_HEADER_EXTS,
  RECORDER,
  RECORDER_FFMPEG: RECORDER.ffmpeg,
}
