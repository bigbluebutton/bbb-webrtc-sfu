'use strict';

const config = require('config');
const Logger = require('../utils/logger.js');
const C = require('../constants/constants.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter.js');

const CONFIGURED_STRATEGIES = config.has('strategies')? config.get('strategies') || [] : [];
const VALID_STRATEGIES = [C.STRATEGIES.FREEWILL, ...CONFIGURED_STRATEGIES.map(st => st.name)]
const LOG_PREFIX = "[mcs-strategy-manager]";

let instance = null;

class StrategyManager {
  constructor () {
    if (instance == null) {
      this.strategyBuilders = [];
      this.strategyHandlers = {};
      this._registeredEvents = [];

      CONFIGURED_STRATEGIES.forEach(a => {
        try {
          const { path, name } = a;
          const strategyBuilder = require(path);
          this.strategyBuilders.push({ strategyBuilder, name });
          Logger.info(LOG_PREFIX, "Loaded strategy", name);
        } catch (e) {
          Logger.error(LOG_PREFIX, 'Could not add configured strategy handler', a.name, e);
        }
      });

      this.addToHandler = this.addToHandler.bind(this);
      this.removeFromHandler = this.removeFromHandler.bind(this);
      this.buildHandlers = this.buildHandlers.bind(this);
      this.handleStrategyChanged = this.handleStrategyChanged.bind(this);

      instance = this;
    }
    return instance;
  }

  start () {
    Logger.info(LOG_PREFIX, "Strategy manager started.");
    this._trackEvents();
  }

  _trackEvents () {
    // Build handlers on room creation
    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_CREATED, this.buildHandlers);
    this._registerEvent(C.EVENT.ROOM_CREATED, this.buildHandlers);

    // Remove old members from any strategy handlers they were bound to
    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_DESTROYED, this.removeFromHandler);
    this._registerEvent(C.EVENT.ROOM_DESTROYED, this.removeFromHandler);
    GLOBAL_EVENT_EMITTER.on(C.EVENT.USER_LEFT, this.removeFromHandler);
    this._registerEvent(C.EVENT.USER_LEFT, this.removeFromHandler);
    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, this.removeFromHandler);
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, this.removeFromHandler);

    // Handle strategy changes
    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_CONNECTED, this.addToHandler);
    this._registerEvent(C.EVENT.MEDIA_CONNECTED, this.addToHandler);
    GLOBAL_EVENT_EMITTER.on(C.EVENT.STRATEGY_CHANGED, this.handleStrategyChanged);
    this._registerEvent(C.EVENT.STRATEGY_CHANGED, this.handleStrategyChanged);
  }

  _registerEvent (event, callback) {
    this._registeredEvents.push({ event, callback });
  }

  _parseMemberInfo (memberInfo) {
    let id;
    const { memberType } = memberInfo;

    switch (memberType) {
      case C.MEMBERS.MEDIA:
        id = memberInfo.mediaId;
        break;
      case C.MEMBERS.MEDIA_SESSION:
        id = memberInfo.mediaSessionId;
        break;
      case C.MEMBERS.USER:
        id = memberInfo.userId;
        break;
      case C.MEMBERS.ROOM:
        id = memberInfo.roomId;
        break;
      default:
        throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    return { id, ...memberInfo };
  }

  static isValidStrategy (strategy) {
    return VALID_STRATEGIES.some(st => st === strategy);
  }

  buildHandlers (room) {
    const { id } = room;

    if (this.strategyHandlers[id] == null) {
      this.strategyHandlers[id] = [];
    }

    this.strategyBuilders.forEach(({ strategyBuilder, name }) => {
      const strategyHandler = new strategyBuilder(room, name);
      strategyHandler.start();
      this.strategyHandlers[id].push(strategyHandler);
    });
  }

  destroyHandlers (roomId) {
    const handlers = this.strategyHandlers[roomId];

    if (handlers == null) {
      return;
    }

    handlers.forEach(handler => {
      handler.stop();
    });

    delete this.strategyHandlers[roomId];
  }

  getHandler (roomId, strategy) {
    const roomHandlers = this.strategyHandlers[roomId];

    if (roomHandlers == null) {
      return null;
    }

    const handler = roomHandlers.find(sh => sh.strategyName === strategy);

    return handler || null;
  }

  addToHandler (memberInfo) {
    const { roomId, strategy } = memberInfo;
    let member;

    try {
      member = this._parseMemberInfo(memberInfo);
    } catch (e) {
      Logger.warn(LOG_PREFIX, "Ignoring strategy member with error", e);
      return;
    }

    const handler = this.getHandler(roomId, strategy);

    if (handler == null ) {
      return;
    }

    Logger.info(LOG_PREFIX, "Adding member", member.id, "to strategy handler", strategy, "for room", roomId);

    handler.addMember(member);
  }

  removeFromHandler (memberInfo) {
    let member;
    const { roomId, strategy } = memberInfo;
    const handler = this.getHandler(roomId, strategy);

    if (handler == null ) {
      return;
    }

    try {
      member = this._parseMemberInfo(memberInfo);
    } catch (e) {
      Logger.warn(LOG_PREFIX, "Ignoring strategy member with error", e);
      return;
    }

    Logger.info(LOG_PREFIX, "Removing member", member.id, "from strategy handler", strategy);
    handler.removeMember(member.id);
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
