/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const C = require('../constants/constants');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const Logger = require('../utils/logger');
const StrategyManager = require('../media/strategy-manager.js');

const LOG_PREFIX = "[mcs-room]";
const MAX_PREVIOUS_FLOORS = 10;

module.exports = class Room {
  constructor (id) {
    this.id = id;
    this._users = {};
    this._conferenceFloor;
    this._previousConferenceFloors = [];
    this._contentFloor;
    this._previousContentFloors = [];
    this._registeredEvents = [];
    this._trackContentMediaDisconnection();
    this._trackConferenceMediaDisconnection();
    this._strategy = C.STRATEGIES.FREEWILL;
  }

  set strategy (strategy) {
    if (!StrategyManager.isValidStrategy(strategy)) {
      throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    this._strategy = strategy;

    GLOBAL_EVENT_EMITTER.emit(C.EVENT.STRATEGY_CHANGED, {
      type: C.MEMBERS.ROOM,
      id: this.id,
      strategy: this.strategy,
    });
  }

  get strategy () {
    return this._strategy;
  }

  getUser (id) {
    return this._users[id];
  }

  getUsers () {
    return Object.keys(this._users).map(uk => this._users[uk].getUserInfo());
  }

  setUser (user) {
    const found = user.id in this._users;
    if (!found) {
      this._users[user.id] = user;
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_JOINED, { roomId: this.id, user: user.getUserInfo() });
    }
  }

  getConferenceFloor () {
    const floor = this._conferenceFloor? this._conferenceFloor.getMediaInfo() : undefined;
    const previousFloor = this._previousConferenceFloors.length <= 0
      ? undefined
      : this._previousConferenceFloors.slice(0, MAX_PREVIOUS_FLOORS).map(m => m.getMediaInfo());


    const conferenceFloorInfo = {
      floor,
      previousFloor
    };

    return conferenceFloorInfo;
  }

  getContentFloor () {
    const floor = this._contentFloor ? this._contentFloor.getMediaInfo() : undefined;
    const previousFloor = this._previousContentFloors.length <= 0
      ? undefined
      : this._previousContentFloors.slice(0, MAX_PREVIOUS_FLOORS).map(m => m.getMediaInfo());


    const contentFloorInfo = {
      floor,
      previousFloor
    };

    return contentFloorInfo;
  }

  _setPreviousConferenceFloor () {
    this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== this._conferenceFloor.id);
    this._previousConferenceFloors.unshift(this._conferenceFloor);
  }

  setConferenceFloor (media) {
    if (this._conferenceFloor && this._previousConferenceFloors[0] && this._previousConferenceFloor[0].id !== this._conferenceFloor.id) {
      this._setPreviousConferenceFloor();
    }

    this._conferenceFloor = media;
    const conferenceFloorInfo = this.getConferenceFloor();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, ...conferenceFloorInfo });
    return conferenceFloorInfo;
  }

  _setPreviousContentFloor () {
    this._previousContentFloors = this._previousContentFloors.filter(pcf => pcf.id !== this._contentFloor.id);
    this._previousContentFloors.unshift(this._contentFloor);
  }

  setContentFloor (media) {
    if (this._contentFloor && this._previousContentFloors[0] && this._previousContentFloors[0].id !== this._contentFloor.id) {
      this._setPreviousContentFloor();
    }

    this._contentFloor = media.getContentMedia();
    const contentFloorInfo = this.getContentFloor();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, ...contentFloorInfo });
    return contentFloorInfo;
  }

  releaseConferenceFloor () {
    if (this._conferenceFloor) {
      this._setPreviousConferenceFloor();
      this._conferenceFloor = null
      const conferenceFloorInfo = this.getConferenceFloor();
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, ...conferenceFloorInfo});
    }

    return this._previousConferenceFloors[0];
  }

  releaseContentFloor () {
    if (this._contentFloor) {
      this._setPreviousContentFloor();
      this._contentFloor = null;
      const contentFloorInfo = this.getContentFloor();
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, ...contentFloorInfo }) ;
    }

    return this._previousContentFloors[0];
  }

  _registerEvent (event, callback) {
    this._registeredEvents.push({ event, callback });
  }

  _trackContentMediaDisconnection () {
    // Listen for media disconnections and clear the content floor state when needed
    // Used when devices ungracefully disconnect from the system
    const clearContentFloor = (event) => {
      const { mediaId, roomId, mediaSessionId } = event;
      if (roomId === this.id) {
        const { floor } = this.getContentFloor();
        if (floor && (mediaId === floor.mediaId || mediaSessionId === floor.mediaId)) {
          this.releaseContentFloor();
        }

        this._previousContentFloors = this._previousContentFloors.filter(pcf => pcf.id !== mediaId);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, clearContentFloor);
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, clearContentFloor);
  }

  _trackConferenceMediaDisconnection () {
    // Listen for media disconnections and clear the conference floor state when needed
    // Used when devices ungracefully disconnect from the system
    const clearConferenceFloor = (event) => {
      const { mediaId, roomId, mediaSessionId } = event;
      if (roomId === this.id) {
        const { floor } = this.getContentFloor();

        if (floor && (mediaId === floor.mediaId || mediaSessionId === floor.mediaId)) {
          this.releaseConferenceFloor();
        }

        this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== mediaId);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, clearConferenceFloor);
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, clearConferenceFloor);
  }

  destroyUser(userId) {
    if (this._users[userId]) {
      delete this._users[userId];
      if (Object.keys(this._users).length <= 0) {
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.ROOM_EMPTY, this.id);
      }
    }
  }

  destroy () {
    Logger.debug(LOG_PREFIX, "Destroying room", this.id);

    this._registeredEvents.forEach(({ event, callback }) => {
      GLOBAL_EVENT_EMITTER.removeListener(event, callback);
    });
    this._registeredEvents = [];
  }
}
