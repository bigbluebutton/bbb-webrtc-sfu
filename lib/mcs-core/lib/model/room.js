/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const C = require('../constants/constants');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');

module.exports = class Room {
  constructor(id) {
    this.id = id;
    this._users = {};
    this._emitter = GLOBAL_EVENT_EMITTER;
    this._conferenceFloor;
    this._contentFloor;
  }

  getUser (id) {
    return this._users[id];
  }

  getUsers () {
    return Object.keys(this._users).map(uk => this._users[uk].getUserInfo());
  }

  getConferenceFloor() {
    return this._conferenceFloor
  }

  getContentFloor() {
    return this._contentFloor
  }

  setUser (user) {
    this._users[user.id] = user;
    this._emitter.emit(C.EVENT.USER_JOINED, { roomId: this.id, user: user.getUserInfo() });
  }

  setConferenceFloor(media) {
    this._conferenceFloor = media;
    const mediaInfo = media.getMediaInfo();
    this._emitter.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, media: mediaInfo});
    return mediaInfo;
  }

  setContentFloor(media) {
    this._contentFloor = media;
    const mediaInfo = media.getMediaInfo();
    this._emitter.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, media: mediaInfo});
    return mediaInfo;
  }

  releaseConferenceFloor(mediaId) {
    if (this._conferenceFloor.id === mediaId) {
      this._conferenceFloor = null
      this._emitter.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, media: {}});
    }
  }

  releaseContentFloor(mediaId) {
    if (this._contentFloor.id === mediaId) {
      this._contentFloor = null
      this._emitter.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, media: {}}) ;
    }
  }


  destroyUser(userId) {
    this._emitter.emit(C.EVENT.USER_LEFT, { roomId: this.id,  userId });
    if (this._users[userId]) {
      delete this._users[userId];
      if (Object.keys(this._users).length <= 0) {
        this._emitter.emit(C.EVENT.ROOM_EMPTY, this.id);
      }
    }
  }
}
