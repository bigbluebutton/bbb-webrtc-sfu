/**
 * @classdesc
 * Model class for Recording
 */

'use strict'

const config = require('config');
const MediaSession = require('./media-session');
const Logger = require('../utils/logger');
const C = require('../constants/constants');
const LOG_PREFIX = "[mcs-recording-session]";


module.exports = class RecordingSession extends MediaSession {
  constructor(room, user, recordingPath, options) {
    const uri = recordingPath;
    const recordingOptions = {
      ... options,
      recordingProfile: config.get('recordingMediaProfile'),
      uri: uri,
      stopOnEndOfStream: true
    };

    super(room, user, C.MEDIA_TYPE.RECORDING, recordingOptions);
    this.filename = uri;
    this.sourceMedia = this._options.sourceMedia;
    this.fillMediaTypes();
    Logger.info(LOG_PREFIX,  "New session created", JSON.stringify(this.getMediaInfo()));
  }

  process () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
        } = this._adapters;

        const { uri } = this._options;

        this.medias = await videoAdapter.negotiate(this.roomId, this.userId, this.id, uri, this.type, this._options);

        // Get media types from the head media (recording medias aren't supposed
        // to be multi-media based)
        this.mediaTypes = this.medias[0]? this.medias[0].mediaTypes : this.mediaTypes;

        await this.sourceMedia.connect(this);

        Logger.debug(LOG_PREFIX, "Started recording", JSON.stringify({ mediaSessionId: this.id, filename: this.filename }));
        return resolve(this.id);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }

  fillMediaTypes () {
    if (this.sourceMedia) {
      const { video, audio, content } = this.sourceMedia.mediaTypes;
      this.mediaTypes.video = video;
      this.mediaTypes.audio = audio;
      this.mediaTypes.content = content;
    }
  }
}
