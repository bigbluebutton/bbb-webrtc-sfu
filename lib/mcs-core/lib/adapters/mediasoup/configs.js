'use strict'

const config = require('config');
const mediasoup = require('mediasoup');
const os = require('os')
const C = require('../../constants/constants');

const _parseMediaTypeWorkers = (dictionary) => {
  return Object.keys(dictionary).reduce((parsedConf, mediaType) => {
    if (VALID_MEDIA_TYPES.some(mt => mt === mediaType)) {
      const numberOfWorkers = _parseNumberOfWorkers(dictionary[mediaType], 0);

      if (typeof numberOfWorkers === 'number' && numberOfWorkers > 0) {
        parsedConf[mediaType] = numberOfWorkers
      }

      return parsedConf;
    }
  }, {});
}

const _parseNumberOfWorkers = (confVal, fallbackVal = DEFAULT_NOF_WORKERS) => {
  if (typeof confVal === 'string' && confVal === 'auto') {
    return CORE_COUNT;
  } else if (typeof confVal === 'number') {
    return confVal;
  }

  return fallbackVal;
};

const {
  workers: SHARED_POOL_WORKERS_CONF,
  dedicatedMediaTypeWorkers: DEDICATED_MEDIA_TYPE_WORKERS_CONF = {
    [C.MEDIA_PROFILE.MAIN]: 0,
    [C.MEDIA_PROFILE.CONTENT]: 0,
    [C.MEDIA_PROFILE.AUDIO]: 0,
  },
  promExportWorkerResourceUsage: WORKER_EXPORT_RESOURCE_USAGE,
  worker: WORKER_SETTINGS,
  router: ROUTER_SETTINGS = { mediaCodecs: mediasoup.getSupportedRtpCapabilities().codecs },
  webrtc: WEBRTC_TRANSPORT_SETTINGS,
  plainRtp: RTP_TRANSPORT_SETTINGS,
  debug: DEBUG,
  webRtcHeaderExts: WEBRTC_HEADER_EXTS,
  recorder: RECORDER,
} = config.get('mediasoup');

const VALID_MEDIA_TYPES = [ C.MEDIA_PROFILE.MAIN, C.MEDIA_PROFILE.AUDIO, C.MEDIA_PROFILE.CONTENT ];
const CORE_COUNT = os.cpus().length
const DEFAULT_NOF_WORKERS = 8;
const SHARED_POOL_WORKERS = _parseNumberOfWorkers(SHARED_POOL_WORKERS_CONF, DEFAULT_NOF_WORKERS);
const DEDICATED_MEDIA_TYPE_WORKERS = _parseMediaTypeWorkers(DEDICATED_MEDIA_TYPE_WORKERS_CONF);

module.exports = {
  LOG_PREFIX: '[mediasoup-adp]',
  DEFAULT_MAX_BW: 0,
  SHARED_POOL_WORKERS,
  DEDICATED_MEDIA_TYPE_WORKERS,
  WORKER_SETTINGS,
  WORKER_EXPORT_RESOURCE_USAGE,
  ROUTER_SETTINGS,
  WEBRTC_TRANSPORT_SETTINGS,
  RTP_TRANSPORT_SETTINGS,
  DEBUG,
  WEBRTC_HEADER_EXTS,
  RECORDER,
  RECORDER_FFMPEG: RECORDER.ffmpeg,
}
