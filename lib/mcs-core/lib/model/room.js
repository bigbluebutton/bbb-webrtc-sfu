/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const C = require('../constants/constants');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const Logger = require('../utils/logger');
const LOG_PREFIX = "[mcs-room]";

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
  }

  getUser (id) {
    return this._users[id];
  }

  getUsers () {
    return Object.keys(this._users).map(uk => this._users[uk].getUserInfo());
  }

  setUser (user) {
    this._users[user.id] = user;
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_JOINED, { roomId: this.id, user: user.getUserInfo() });
  }

  getConferenceFloor () {
    const conferenceFloorInfo = {
      floor: this._conferenceFloor? this._conferenceFloor.getMediaInfo() : undefined,
      previousFloor: this._previousConferenceFloors[0]? this._previousConferenceFloors[0].getMediaInfo() : undefined,
    };

    return conferenceFloorInfo;
  }

  getContentFloor () {
    const contentFloorInfo = {
      floor: this._contentFloor? this._contentFloor.getMediaInfo() : undefined,
      previousFloor: this._previousContentFloors[0]? this._previousContentFloors[0].getMediaInfo() : undefined,
    };

    return contentFloorInfo;
  }

  _setPreviousConferenceFloor () {
    this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== this._conferenceFloor.id);
    this._previousConferenceFloors.unshift(this._conferenceFloor);
  }

  setConferenceFloor (media) {
    if (this._conferenceFloor && this._previousConferenceFloor[0] && this._previousConferenceFloor[0].id !== this._conferenceFloor.id) {
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
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_LEFT, { roomId: this.id,  userId });
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
  }
}
