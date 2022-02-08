const config = require('config');
const PrometheusAgent = require('../../common/prometheus-agent.js');

const {
  enabled: METRICS_ENABLED,
  main: MAIN_METRICS_CONFIG,
} = config.has('prometheus') ? config.get('prometheus') : { enabled: false, main: {} };
const {
  host: METRICS_HOST = 'localhost',
  port: METRICS_PORT = '3016',
  path: METRICS_PATH = '/metrics',
  collectDefaultMetrics: COLLECT_DEFAULT_METRICS,
} = MAIN_METRICS_CONFIG;

const MainPrometheusAgent = new PrometheusAgent(METRICS_HOST, METRICS_PORT, {
  path: METRICS_PATH,
  prefix: 'sfu_',
  collectDefaultMetrics: COLLECT_DEFAULT_METRICS,
});


const injectMetrics = (metricsDictionary) => {
  if (METRICS_ENABLED) {
    MainPrometheusAgent.injectMetrics(metricsDictionary);
    return true;
  }

  return false;
}

MainPrometheusAgent.start();

module.exports = {
  PrometheusAgent,
  MainPrometheusAgent,
  injectMetrics,
};
