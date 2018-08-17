/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const C = require('../constants/Constants');

module.exports = class Room {
  constructor(id, emitter) {
    this._id = id;
    this._users = {};
    this._mcuUsers = {};
    this._emitter = emitter;
  }

  getUser (id) {
    return this._users[id];
  }

  setUser (user) {
    this._users[user.id] = user;
    this._emitter.emit(C.EVENT.USER_JOINED, { roomId: this._id, user: user.getUserInfo() });
  }

  destroyUser(userId) {
    this._emitter.emit(C.EVENT.USER_LEFT, { roomId: this._id,  userId });
    this._users[userId] = null;
  }
}
