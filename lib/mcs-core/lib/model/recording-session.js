/**
 * @classdesc
 * Model class for Recording
 */

'use strict'

const config = require('config');
const MediaSession = require('./media-session');
const Logger = require('../utils/logger');
const C = require('../constants/constants');

module.exports = class RecordingSession extends MediaSession {
  constructor(room, user, recordingPath, options) {
    const uri = recordingPath;
    const recordingOptions = {
      ... options,
      mediaProfile: config.get('recordingMediaProfile'),
      uri: uri,
      stopOnEndOfStream: true
    };

    super(room, user, C.MEDIA_TYPE.RECORDING, recordingOptions);
    this.filename = uri;
    this.sourceMedia = this._options.sourceMedia;
  }

  process () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
        } = this._adapters;

        const { uri } = this._options;

        this.medias = await videoAdapter.negotiate(this.roomId, this.userId, this.id, uri, this._type, this._options);
        await this.sourceMedia.connect(this);

        Logger.debug("[mcs-recording-session] Started recording", this.id, "at", this.filename);
        return resolve(this.id);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }
}
