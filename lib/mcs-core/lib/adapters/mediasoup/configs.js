'use strict'

const config = require('config');
const mediasoup = require('mediasoup');
const os = require('os')
const C = require('../../constants/constants');
const Logger = require('../../utils/logger');

const {
  workers: SHARED_POOL_WORKERS_CONF,
  dedicatedMediaTypeWorkers: DEDICATED_MEDIA_TYPE_WORKERS_CONF = {
    [C.MEDIA_PROFILE.MAIN]: 0,
    [C.MEDIA_PROFILE.CONTENT]: 0,
    [C.MEDIA_PROFILE.AUDIO]: 0,
  },
  workerPriorities: WORKER_PRIORITIES = {},
  workerBalancing: WORKER_BALANCING = { strategy: 'round-robin' },
  promExportWorkerResourceUsage: WORKER_EXPORT_RESOURCE_USAGE,
  promExportRtpScores: EXPORT_RTP_SCORES,
  worker: WORKER_SETTINGS,
  router: DEFAULT_ROUTER_SETTINGS = { mediaCodecs: mediasoup.getSupportedRtpCapabilities().codecs },
  webrtc: WEBRTC_TRANSPORT_SETTINGS,
  plainRtp: RTP_TRANSPORT_SETTINGS,
  debug: DEBUG,
  webRtcHeaderExts: WEBRTC_HEADER_EXTS,
  recorder: RECORDER,
  bitrate: BITRATE = {
    defaultMaxIncomingBitrate: 1500000,
    defaultMaxOutgoingBitrate: 0,
    defaultInitialAvailableOutgoingBitrate: 600000,
  },
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
const ROUTER_SETTINGS = config.util.cloneDeep(DEFAULT_ROUTER_SETTINGS);
const CONFERENCE_MEDIA_SPECS = config.has('conference-media-specs')
  ? config.get('conference-media-specs')
  : {};

// Override relevant parameters in the router settings with the conference media specs
if (CONFERENCE_MEDIA_SPECS) {
  Object.entries(CONFERENCE_MEDIA_SPECS).forEach(([codec, specs]) => {
    try {
      if (typeof specs !== 'object') return;

      const codecSettings = ROUTER_SETTINGS
        .mediaCodecs
        .find(c => c.mimeType.toLowerCase().split('/')[1] === codec.toLowerCase());

      if (!codecSettings) return;

      codecSettings.parameters = codecSettings.parameters || {};
      Object.entries(specs).forEach(([key, value]) => {
        codecSettings.parameters[key.replace('_', '-')] = value;
      });
    } catch (error) {
      Logger.warn('Error while overriding router settings with conference media specs', error);
    }
  });
}

Object.freeze(ROUTER_SETTINGS);

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
    }

    return parsedConf;
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
  SHARED_POOL_WORKERS,
  DEDICATED_MEDIA_TYPE_WORKERS,
  WORKER_PRIORITIES,
  WORKER_BALANCING,
  WORKER_SETTINGS,
  WORKER_EXPORT_RESOURCE_USAGE,
  EXPORT_RTP_SCORES,
  ROUTER_SETTINGS,
  WEBRTC_TRANSPORT_SETTINGS,
  RTP_TRANSPORT_SETTINGS,
  DEBUG,
  WEBRTC_HEADER_EXTS,
  RECORDER,
  RECORDER_FFMPEG: RECORDER.ffmpeg,
  DEFAULT_MAX_IN_BW: BITRATE.defaultMaxIncomingBitrate,
  DEFAULT_MAX_OUT_BW: BITRATE.defaultMaxOutgoingBitrate,
  DEFAULT_INITIAL_IN_BW: BITRATE.defaultInitialAvailableOutgoingBitrate,
}
