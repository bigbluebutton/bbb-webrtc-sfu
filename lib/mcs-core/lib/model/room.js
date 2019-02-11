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
    this._contentFloor;
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

  getConferenceFloor () {
    return this._conferenceFloor? this._conferenceFloor.id : null;
  }

  getContentFloor () {
    return this._contentFloor? this._contentFloor.id : null;
  }

  setUser (user) {
    this._users[user.id] = user;
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_JOINED, { roomId: this.id, user: user.getUserInfo() });
  }

  setConferenceFloor (media) {
    this._conferenceFloor = media;
    const mediaInfo = media.getMediaInfo();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, media: mediaInfo});
    return mediaInfo;
  }

  setContentFloor (media) {
    this._contentFloor = media.getApplicationMedia();
    const mediaInfo = this._contentFloor.getMediaInfo();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, media: mediaInfo});
    return mediaInfo;
  }

  releaseConferenceFloor () {
    if (this.getConferenceFloor()) {
      this._conferenceFloor = null
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, media: {}});
    }
  }

  releaseContentFloor () {
    if (this.getContentFloor()) {
      this._contentFloor = null;
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, media: {}}) ;
    }
  }

  _registerEvent (event, callback) {
    this._registeredEvents.push({ event, callback });
  }

  _trackContentMediaDisconnection () {
    // Listen for media disconnections and clear the content floor state when needed
    // Used when devices ungracefully disconnect from the system
    const clearContentFloor = (event) => {
      const { mediaId, roomId, mediaSessionId } = event;
      const contentFloorId = this.getContentFloor();

      if (roomId === this.id && (mediaId === contentFloorId || mediaSessionId === contentFloorId)) {
        this.releaseContentFloor(contentFloorId);
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
      const conferenceFloorId = this.getConferenceFloor();

      if (roomId === this.id && (mediaId === conferenceFloorId || mediaSessionId === conferenceFloorId)) {
        this.releaseConferenceFloor(conferenceFloorId);
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
