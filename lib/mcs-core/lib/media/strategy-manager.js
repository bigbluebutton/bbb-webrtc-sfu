'use strict';

const config = require('config');
const Logger = require('../utils/logger.js');
const C = require('../constants/constants.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter.js');

const CONFIGURED_STRATEGIES = config.has('strategies')? config.get('strategies') : [];
const VALID_STRATEGIES = [C.STRATEGIES.FREEWILL, ...CONFIGURED_STRATEGIES.map(st => st.name)]
const LOG_PREFIX = "[mcs-strategy-manager]";

let ControllerStorage;
let instance = null;

class StrategyManager {
  constructor () {
    if (instance == null) {
      this.strategyHandlers = [];
      this._registeredEvents = [];

      CONFIGURED_STRATEGIES.forEach(a => {
        try {
          const { path, name } = a;
          const strategyHandler = require(path);
          this.strategyHandlers.push({ strategyHandler, name });
        } catch (e) {
          Logger.error(LOG_PREFIX, 'Could not add configured strategy handler', a, e);
        }
      });

      instance = this;
      Logger.info(LOG_PREFIX, "Configured strategy handlers:", this.strategyHandlers);
    }
    return instance;
  }

  start () {
    Logger.info(LOG_PREFIX, "Strategy manager started.");
    this._trackEvents();
  }

  _trackEvents () {
    // Remove old members from any strategy handlers they were bound to
    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_DESTROYED, this.removeFromHandler.bind(this));
    this._registerEvent(C.EVENT.ROOM_DESTROYED, this.removeFromHandler.bind(this));
    GLOBAL_EVENT_EMITTER.on(C.EVENT.USER_LEFT, this.removeFromHandler.bind(this));
    this._registerEvent(C.EVENT.USER_LEFT, this.removeFromHandler.bind(this));
    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, this.removeFromHandler.bind(this));
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, this.removeFromHandler.bind(this));

    // Handle strategy changes
    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_CONNECTED, this.handleMediaConnected.bind(this));
    this._registerEvent(C.EVENT.MEDIA_CONNECTED, this.handleMediaConnected.bind(this));
    GLOBAL_EVENT_EMITTER.on(C.EVENT.STRATEGY_CHANGED, this.handleStrategyChanged.bind(this));
    this._registerEvent(C.EVENT.ROOM_DESTROYED, this.handleStrategyChanged.bind(this));
  }

  _registerEvent (event, callback) {
    this._registeredEvents.push({ event, callback });
  }

  static isValidStrategy (strategy) {
    return VALID_STRATEGIES.some(st => st === strategy);
  }

  addToHandler (memberInfo) {
    const { id, strategy, type } = memberInfo;
    const handler = this.strategyHandlers.find(st => st.strategyName === strategy);

    if (handler == null) {
      return;
    }

    Logger.info(LOG_PREFIX, "Adding member", id, "to strategy handler", strategy);
    handler.addMember(memberInfo);
  }

  removeFromHandler (memberInfo) {
    const { id, strategy } = memberInfo;
    const handler = this.strategyHandlers.find(st => st.strategyName === strategy);

    if (handler == null) {
      return;
    }

    Logger.info(LOG_PREFIX, "Removing member", id, "from strategy handler", strategy);
    handler.removeMember(id);
  }

  handleMediaConnected (mediaInfo) {
    const memberInfo = {
      type: mediaInfo.type,
      id: mediaInfo.mediaId,
      strategy: mediaInfo.strategy,
    }

    this.addToHandler(memberInfo);
  }

  handleStrategyChanged (member) {
    this.removeFromHandler(member);
    this.addToHandler(member);
  }

  stop () {
    this._registeredEvents.forEach(({ event, callback }) => {
      GLOBAL_EVENT_EMITTER.removeListener(event, callback);
    });

    this._registeredEvents = [];
  }
}

module.exports = StrategyManager;
