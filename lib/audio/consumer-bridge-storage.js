const Logger = require('../common/logger.js');

const CONSUMER_BRIDGE_STORAGE = new Map();
const getConsumerBridge = (id) => CONSUMER_BRIDGE_STORAGE.get(id);
const hasConsumerBridge = (id) => CONSUMER_BRIDGE_STORAGE.has(id);
const deleteConsumerBridge = (id) => CONSUMER_BRIDGE_STORAGE.delete(id);
const storeConsumerBridge = (bridge, id) => {
  if (!bridge) return false;

  if (hasConsumerBridge(id)) {
    Logger.warn('Collision on FS consumer bridge storage', { id });
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
