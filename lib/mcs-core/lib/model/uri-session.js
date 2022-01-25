/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const { v4: uuidv4 } = require('uuid');
const MediaSession = require('./media-session');

module.exports = class UriSession extends MediaSession {
  constructor(uri = null) {
    super();
    this.id = uuidv4();
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
