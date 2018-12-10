/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const rid = require('readable-id');
const EventEmitter = require('events').EventEmitter;
const MediaSession = require('./media-session');
const Logger = require('../utils/logger');

module.exports = class UriSession extends MediaSession {
  constructor(uri = null) {
    super();
    this.id = rid();
    this._status = C.STATUS.STOPPED;
    this._uri;
    if (uri) {
      this.setUri(uri);
    }
  }

  setUri (uri) {
    this._uri = uri;
  }
}
