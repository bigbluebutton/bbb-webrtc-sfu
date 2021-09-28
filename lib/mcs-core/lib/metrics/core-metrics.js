/*
 * Baseline metrics:
 *  - rooms, gauge
 *  - users, gauge
 *  - mediaSessions, gauge
 *  - mediaUnits
 *    * media_type: 'main'|'content'|'audio'|'application'|'message'|'invalid'
 *    * unit_type: 'WebRtcEndpoint', 'RtpEndpoint', 'RecorderEndpoint', 'RtspEndpoint', 'invalid'
 * Additional metrics
 *  - requests: counter
 *  - request errors: counter
 *  - request duration: histogram
 * Adapter specific:
 *  - mediasoup:
 *    mediasoup_workers: gauge
 *    mediasoup_routers: gauge
 *    mediasoup_transports: gauge
 *    mediasoup_producers: gauge
 *    mediasoup_consumers: gauge
 */

const {
  Gauge,
  Counter,
} = require('prom-client');

const METRICS_PREFIX = 'mcs_'
const METRIC_NAMES = {
  ROOMS: 'mcsRooms',
  USERS: 'mcsUsers',
  MEDIA_SESSIONS: 'mcsMediaSessions',
  MEDIA_UNITS: 'mcsMediaUnits',
  REQUESTS_TOTAL: 'mcsRequestsTotal',
  REQUEST_ERRORS_TOTAL: 'mcsRequestErrorsTotal',
  MEDIASOUP_WORKERS: 'mediasoupWorkers',
  MEDIASOUP_ROUTERS: 'mediasoupRouters',
  MEDIASOUP_TRANSPORTS: 'mediasoupTransports',
  MEDIASOUP_PRODUCERS: 'mediasoupProducers',
  MEDIASOUP_CONSUMERS: 'mediasoupConsumers',
}

let METRICS;
const buildMetrics = () => {
  if (METRICS == null) {
    METRICS = {
      [METRIC_NAMES.ROOMS]: new Gauge({
        name: `${METRICS_PREFIX}rooms`,
        help: 'Number of active rooms in mcs-core',
      }),

      [METRIC_NAMES.USERS]: new Gauge({
        name: `${METRICS_PREFIX}users`,
        help: 'Number of active users in mcs-core',
      }),

      [METRIC_NAMES.MEDIA_SESSIONS]: new Gauge({
        name: `${METRICS_PREFIX}media_sessions`,
        help: 'Number of active media sessions in mcs-core',
      }),

      [METRIC_NAMES.MEDIA_UNITS]: new Gauge({
        name: `${METRICS_PREFIX}media_units`,
        help: 'Number of active media units in mcs-core',
        labelNames: ['media_type', 'unit_type', 'direction'],
      }),

      [METRIC_NAMES.REQUESTS_TOTAL]: new Counter({
        name: `${METRICS_PREFIX}requests_total`,
        help: 'Total number of requests receive by mcs-core',
        labelNames: ['method'],
      }),

      [METRIC_NAMES.REQUEST_ERRORS_TOTAL]: new Counter({
        name: `${METRICS_PREFIX}request_errors_total`,
        help: 'Total number of requests failures in mcs-core',
        labelNames: ['method', 'errorCode'],
      }),

      [METRIC_NAMES.MEDIASOUP_WORKERS]: new Gauge({
        name: `${METRICS_PREFIX}mediasoup_workers`,
        help: 'Active mediasoup workers',
      }),

      [METRIC_NAMES.MEDIASOUP_ROUTERS]: new Gauge({
        name: `${METRICS_PREFIX}mediasoup_routers`,
        help: 'Active mediasoup routers',
      }),

      [METRIC_NAMES.MEDIASOUP_TRANSPORTS]: new Gauge({
        name: `${METRICS_PREFIX}mediasoup_transports`,
        help: 'Number of active mediasoup transports',
        labelNames: ['type'],
      }),

      [METRIC_NAMES.MEDIASOUP_PRODUCERS]: new Gauge({
        name: `${METRICS_PREFIX}mediasoup_producers`,
        help: 'Number of active mediasoup producers',
        labelNames: ['type', 'kind', 'transport_type'],
      }),

      [METRIC_NAMES.MEDIASOUP_CONSUMERS]: new Gauge({
        name: `${METRICS_PREFIX}mediasoup_consumers`,
        help: 'Number of active mediasoup consumers',
        labelNames: ['type', 'kind', 'transport_type'],
      }),
    }
  }

  return METRICS;
};

module.exports = {
  METRICS_PREFIX,
  METRIC_NAMES,
  METRICS,
  buildMetrics,
};
