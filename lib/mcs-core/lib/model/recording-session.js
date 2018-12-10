/**
 * @classdesc
 * Model class for Recording
 */

'use strict'

const config = require('config');
const MediaSession = require('./media-session');
const Logger = require('../utils/logger');

module.exports = class RecordingSession extends MediaSession {
  constructor(room, user, recordingPath) {
    const uri = recordingPath;
    const options = {
      mediaProfile: config.get('recordingMediaProfile'),
      uri: uri,
      stopOnEndOfStream: true
    };

    super(room, user, C.MEDIA_TYPE.RECORDING, options);
    this.filename = uri;
  }

  process () {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.debug("[mcs-recording-session] Started recording", this.id, "at", this.filename);
        await this._videoAdapter.startRecording(this.videoMediaElement);
        return resolve(this.id);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }
}
