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
      let mi = this._mediaSessions[key].getMediaInfo();
      return mi;
    });

    const userInfo = {
      userId: this.id,
      name: this.name,
      type: this.type,
      roomId: this.roomId,
      mediasList,
    };

    return userInfo;
  }

  getUserMedias () {
    const userMedias = Object.keys(this._mediaSessions).map(mk => this._mediaSessions[mk].getMediaInfo());
    console.log(userMedias);
    return userMedias;
  }

  _trackMediaDisconnection(media) {
    media.emitter.once(C.EVENT.MEDIA_DISCONNECTED, (mediaId) => {
      if (mediaId === media.id) {
        Logger.info("[mcs-user] Media stopped.");
        delete this._mediaSessions[mediaId] ;
      }
    });
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
