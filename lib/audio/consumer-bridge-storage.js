const Logger = require('../common/logger.js');
const C = require('../bbb/messages/Constants');
const { PrometheusAgent, SFUA_NAMES } = require('./metrics/audio-metrics.js');

const CONSUMER_BRIDGE_STORAGE = new Map();
const getConsumerBridge = (id) => CONSUMER_BRIDGE_STORAGE.get(id);
const hasConsumerBridge = (id) => CONSUMER_BRIDGE_STORAGE.has(id);
const deleteConsumerBridge = (id) => {
  const bridge = getConsumerBridge(id);

  if (bridge) {
    bridge.finalDetachEventListeners();
    PrometheusAgent.set(SFUA_NAMES.GLOBAL_AUDIO_SESSIONS, CONSUMER_BRIDGE_STORAGE.size);
    return CONSUMER_BRIDGE_STORAGE.delete(id);
  }

  return false;
};

const storeConsumerBridge = (bridge, id) => {
  if (!bridge) return false;

  if (hasConsumerBridge(id)) {
    Logger.warn('Collision on FS consumer bridge storage', { id });
    return false;
  }

  bridge.on(C.MEDIA_SERVER_OFFLINE, () => {
    deleteConsumerBridge(id);
    bridge.stop();
    PrometheusAgent.increment(SFUA_NAMES.GLOBAL_AUDIO_CRASHES, { errorCode: C.MEDIA_SERVER_OFFLINE });
  });

  CONSUMER_BRIDGE_STORAGE.set(id, bridge);
  PrometheusAgent.set(SFUA_NAMES.GLOBAL_AUDIO_SESSIONS, CONSUMER_BRIDGE_STORAGE.size);

  return true;
};

module.exports = {
  getConsumerBridge,
  hasConsumerBridge,
  deleteConsumerBridge,
  storeConsumerBridge,
};
