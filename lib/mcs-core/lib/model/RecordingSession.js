/**
 * @classdesc
 * Model class for Recording
 */

'use strict'

const config = require('config');
const MediaSession = require('./MediaSession');

module.exports = class RecordingSession extends MediaSession {
  constructor(emitter, room, user, recordingPath) {
    const uri = recordingPath;
    const options = {
      mediaProfile: config.get('recordingMediaProfile'),
      uri: uri,
      stopOnEndOfStream: true
    };

    super(emitter, room, user, 'RecorderEndpoint', options);
    this.filename = uri;
  }

  process () {
    return new Promise(async (resolve, reject) => {
      try {
        await this._videoAdapter.startRecording(this.videoMediaElement);
        return resolve(this.id);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }
}
