/*
 *  sfu_websockets: gauge
 *  sfu_websocket_requests: counter
 *  sfu_websocket_errors: counter
 *  sfu_module_crashes: counter
 *  sfu_module_status: gauge
 */

const { Gauge, Counter, } = require('prom-client');
const { injectMetrics, MainPrometheusAgent } = require('./index.js');

const SFUM_NAMES = {
  WEBSOCKETS: 'sfu_websockets',
  WEBSOCKET_IN_MSGS: 'sfu_websocket_in_messages',
  WEBSOCKET_OUT_MSGS: 'sfu_websocket_out_messages',
  WEBSOCKET_ERRORS: 'sfu_websocket_errors',
  MODULE_STATUS: 'sfu_module_status',
  MODULE_CRASHES: 'sfu_module_crashes',
}

let SFU_METRICS;
const buildDefaultMetrics = () => {
  if (SFU_METRICS == null) {
    SFU_METRICS = {
      [SFUM_NAMES.WEBSOCKETS]: new Gauge({
        name: SFUM_NAMES.WEBSOCKETS,
        help: 'Number of active WebSocket connections',
      }),

      [SFUM_NAMES.WEBSOCKET_IN_MSGS]: new Counter({
        name: SFUM_NAMES.WEBSOCKET_IN_MSGS,
        help: 'Total inbound WebSocket requisitions',
      }),

      [SFUM_NAMES.WEBSOCKET_OUT_MSGS]: new Counter({
        name: SFUM_NAMES.WEBSOCKET_OUT_MSGS,
        help: 'Total outbound WebSocket requisitions',
      }),

      [SFUM_NAMES.WEBSOCKET_ERRORS]: new Counter({
        name: SFUM_NAMES.WEBSOCKET_ERRORS,
        help: 'Total WebSocket failures',
        labelNames: ['reason'],
      }),

      [SFUM_NAMES.MODULE_STATUS]: new Gauge({
        name: SFUM_NAMES.MODULE_STATUS,
        help: 'SFU module status',
        labelNames: ['module'],
      }),

      [SFUM_NAMES.MODULE_CRASHES]: new Gauge({
        name: SFUM_NAMES.MODULE_CRASHES,
        help: 'Total SFU module crashes',
        labelNames: ['module', 'signal'],
      }),
    }
  }

  return SFU_METRICS;
};

injectMetrics(buildDefaultMetrics());

module.exports = {
  SFUM_NAMES,
  SFU_METRICS,
  PrometheusAgent: MainPrometheusAgent,
};
