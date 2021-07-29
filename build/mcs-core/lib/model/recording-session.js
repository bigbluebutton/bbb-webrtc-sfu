/**
 * @classdesc
 * Model class for Recording
 */
'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const config = require('config');
const MediaSession = require('./media-session');
const { Logger } = require('../utils/logger');
const C = require('../constants/constants');
const LOG_PREFIX = "[mcs-recording-session]";
module.exports = class RecordingSession extends MediaSession {
    constructor(room, user, recordingPath, options) {
        const uri = recordingPath;
        const recordingOptions = Object.assign({ recordingProfile: config.get('recordingMediaProfile'), uri: uri, stopOnEndOfStream: true }, options);
        super(room, user, C.MEDIA_TYPE.RECORDING, recordingOptions);
        this.filename = uri;
        this.sourceMedia = this._options.sourceMedia;
        this.fillMediaTypes();
        Logger.info(LOG_PREFIX, "New session created", JSON.stringify(this.getMediaInfo()));
    }
    process() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { videoAdapter, } = this._adapters;
                const { uri } = this._options;
                this.medias = yield videoAdapter.negotiate(this.roomId, this.userId, this.id, uri, this.type, this._options);
                // Get media types from the head media (recording medias aren't supposed
                // to be multi-media based)
                this.mediaTypes = this.medias[0] ? this.medias[0].mediaTypes : this.mediaTypes;
                yield this.sourceMedia.connect(this);
                Logger.debug(LOG_PREFIX, `Started recording for ${this.id}`, { mediaInfo: this.getMediaInfo() });
                return this.id;
            }
            catch (error) {
                Logger.error(LOG_PREFIX, `Error on RecordingSession process for ${this.id}`, { mediaInfo: this.getMediaInfo(), error });
                throw (this._handleError(error));
            }
        });
    }
    fillMediaTypes() {
        if (this.sourceMedia) {
            const { video, audio, content } = this.sourceMedia.mediaTypes;
            this.mediaTypes.video = video;
            this.mediaTypes.audio = audio;
            this.mediaTypes.content = content;
        }
    }
};
