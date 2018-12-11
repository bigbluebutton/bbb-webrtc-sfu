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

  async _createMainMediaElement () {
    let mediaElement, host;
    const {
      videoAdapter,
    } = this._adapters;

    ({ mediaElement, host } = await videoAdapter.createMediaElement(this.roomId, this._type, this._options));

    this.videoMediaElement = mediaElement;
    this.videoHost = host;

    return { mediaElement, host };
  }


  process () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
        } = this._adapters;

        await this._createMainMediaElement();
        Logger.debug("[mcs-recording-session] Started recording", this.id, "at", this.filename);
        await videoAdapter.startRecording(this.videoMediaElement);
        return resolve(this.id);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }
}
