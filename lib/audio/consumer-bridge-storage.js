const Logger = require('../common/logger.js');
const LOG_PREFIX = '[fs-bridge-storage]';

const CONSUMER_BRIDGE_STORAGE = new Map();
const getConsumerBridge = (voiceBridge) => CONSUMER_BRIDGE_STORAGE.get(voiceBridge);
const hasConsumerBridge = (voiceBridge) => CONSUMER_BRIDGE_STORAGE.has(voiceBridge);
const deleteConsumerBridge = (voiceBridge) => CONSUMER_BRIDGE_STORAGE.delete(voiceBridge);
const storeConsumerBridge = (bridge, id) => {
  if (!bridge) return false;

  if (hasConsumerBridge(id)) {
    Logger.warn(LOG_PREFIX, 'Collision on FS consumer bridge storage', { id });
    return false;
  }

  CONSUMER_BRIDGE_STORAGE.set(id, bridge);

  return true;
}

module.exports = {
  getConsumerBridge,
  hasConsumerBridge,
  deleteConsumerBridge,
  storeConsumerBridge,
};
