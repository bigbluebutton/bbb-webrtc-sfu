'use strict'

const config = require('config');
const {
  workers: NOF_WORKERS,
  workerMode: WORKER_MODE,
  worker: WORKER_SETTINGS,
  router: ROUTER_SETTINGS,
  webrtc: WEBRTC_TRANSPORT_SETTINGS,
  plainRtp: RTP_TRANSPORT_SETTINGS,
  debug: DEBUG,
  webRtcHeaderExts: WEBRTC_HEADER_EXTS,
} = config.get('mediasoup');

module.exports = {
  LOG_PREFIX: '[mediasoup-adp]',
  NOF_WORKERS,
  WORKER_MODE,
  WORKER_SETTINGS,
  ROUTER_SETTINGS,
  WEBRTC_TRANSPORT_SETTINGS,
  RTP_TRANSPORT_SETTINGS,
  DEBUG,
  WEBRTC_HEADER_EXTS,
}
