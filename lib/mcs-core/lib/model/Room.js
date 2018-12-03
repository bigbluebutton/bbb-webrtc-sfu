/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const C = require('../constants/Constants');

module.exports = class Room {
  constructor(id, emitter) {
    this.id = id;
    this._users = {};
    this._emitter = emitter;
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

  setConferenceFloor(mediaId) {
    this._conferenceFloor = mediaId
  }

  setContentFloor(mediaId) {
    this._contentFloor = mediaId
  }

  releaseConferenceFloor(mediaId) {
    this._conferenceFloor = null
  }

  releaseContentFloor(mediaId) {
    this._contentFloor = null
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
