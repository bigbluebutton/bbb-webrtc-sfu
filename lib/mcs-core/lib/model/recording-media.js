/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const rid = require('readable-id');
const Media = require('./media');
const Balancer = require('../media/balancer');
const config = require('config');
const Logger = require('../utils/logger');
const LOG_PREFIX = "[mcs-recording-media]";

module.exports = class RecordingMedia extends Media {
  constructor(
    room,
    user,
    mediaSessionId,
    remoteDescriptor,
    localDescriptor,
    type,
    adapter,
    adapterElementId,
    host,
    options
  ) {
    super(room, user, mediaSessionId, type, adapter, adapterElementId, host, options);
    this.sourceMedia = options.sourceMedia || undefined;
    if (localDescriptor) {
      this.localDescriptor = localDescriptor;
    }
    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }
    this._updateHostLoad();

    Logger.info(LOG_PREFIX,  "New session created", JSON.stringify(this.getMediaInfo()));
  }

  set remoteDescriptor (remoteDescriptor) {
    if (remoteDescriptor) {
      this._remoteDescriptor= remoteDescriptor;
      if (this.sourceMedia) {
        this.mediaTypes.video = !!this.sourceMedia.mediaTypes.video;
        this.mediaTypes.audio = !!this.sourceMedia.mediaTypes.audio;
        this.mediaTypes.content = !!this.sourceMedia.mediaTypes.content;
      }
    }
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      this._localDescriptor = localDescriptor;
      if (this.sourceMedia) {
        this.mediaTypes.video = !!this.sourceMedia.mediaTypes.video;
        this.mediaTypes.audio = !!this.sourceMedia.mediaTypes.audio;
        this.mediaTypes.content = !!this.sourceMedia.mediaTypes.content;
      }
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  _updateHostLoad () {
    if (this.mediaTypes.video) {
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.MAIN);
      this.hasVideo = true;
    }

    if (this.mediaTypes.audio) {
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.AUDIO);
      this.hasAudio = true;
    }
  }
}
