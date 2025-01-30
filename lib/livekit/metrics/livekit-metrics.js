const { Counter } = require('prom-client');
const { injectMetrics, LiveKitPrometheusAgent } = require('./index.js');

const SFULK_NAMES = {
  API_ERRORS: 'sfu_livekit_errors_total',
  EGRESS_ERRORS: 'sfu_livekit_egress_errors_total',
}

let LIVEKIT_METRICS;
const buildDefaultMetrics = () => {
  if (LIVEKIT_METRICS == null) {
    LIVEKIT_METRICS = {
      [SFULK_NAMES.API_ERRORS]: new Counter({
        name: SFULK_NAMES.API_ERRORS,
        help: 'Total number of LiveKIT API call failures',
        labelNames: ['errorMessage'],
      }),

      [SFULK_NAMES.EGRESS_ERRORS]: new Counter({
        name: SFULK_NAMES.EGRESS_ERRORS,
        help: 'Total number of egress API errors',
        labelNames: ['errorMessage'],
      }),
    }
  }

  return LIVEKIT_METRICS;
};

injectMetrics(buildDefaultMetrics());

module.exports = {
  SFULK_NAMES,
  LIVEKIT_METRICS,
  PrometheusAgent: LiveKitPrometheusAgent,
};
