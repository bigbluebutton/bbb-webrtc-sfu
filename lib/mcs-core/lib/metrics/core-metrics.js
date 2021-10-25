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
 * TODO:
 *  - request duration: histogram
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
