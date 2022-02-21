'use strict'

const config = require('config');
const mediasoup = require('mediasoup');
const os = require('os')
const C = require('../../constants/constants');

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
const WORKER_MODE_CORES = 'cores';
const WORKER_MODE_AUTO = 'auto';
const CORE_COUNT = os.cpus().length;
const CORE_THRESHOLD = 32;
const VALID_MEDIA_TYPES = [
  C.MEDIA_PROFILE.MAIN,
  C.MEDIA_PROFILE.AUDIO,
  C.MEDIA_PROFILE.CONTENT
];

const _getNumberOfWorkersWithCoreThreshold = (coreCount, coreThreshold) => {
  return Math.ceil(
    (Math.min(coreCount, coreThreshold) * 0.8)
    + (Math.max(0, (coreCount - coreThreshold)) / 2)
  );
};

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

const _parseNumberOfWorkers = (confVal) => {
  if (typeof confVal === 'string') {
    switch (confVal) {
      case WORKER_MODE_CORES:
        return CORE_COUNT;
      case WORKER_MODE_AUTO:
      default:
        return _getNumberOfWorkersWithCoreThreshold(CORE_COUNT, CORE_THRESHOLD);
    }
  } else if (typeof confVal === 'number') {
    return Math.max(confVal, 0);
  }

  return _getNumberOfWorkersWithCoreThreshold(CORE_COUNT, CORE_THRESHOLD);
};

const SHARED_POOL_WORKERS = _parseNumberOfWorkers(SHARED_POOL_WORKERS_CONF);
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
