/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const rid = require('readable-id');
const User = require('./User');
const C = require('../constants/Constants.js');
const Logger = require('../../../utils/Logger');
const { handleError } = require('../utils/util');
const LOG_PREFIX = "[mcs-user]";

module.exports = class User {
  constructor(roomId, type, emitter, name = 'default') {
    this.id = rid();
    this.roomId = roomId;
    this.type = type;
    this.name = name;
    this.emitter = emitter;
    this._mediaSessions = {}
  }

  getUserInfo () {
    const mediasList = Object.keys(this._mediaSessions).map(key => {
      this._mediaSessions[key].getMediaInfo();
    });

    return {
      userId: this.id,
      name: this.name,
      type: this.type,
      roomId: this.roomId,
      mediasList,
    };
  }

  getUserMedias () {
    return this._mediaSessions.map(m => m.getMediaInfo());
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
