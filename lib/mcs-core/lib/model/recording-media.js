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

    Logger.info(LOG_PREFIX, "New session with options", type);

    if (localDescriptor) {
      this.localDescriptor = localDescriptor;
    }

    if (localDescriptor) {
      this.localDescriptor = localDescriptor;
    }

    this.sourceMedia = options.sourceMedia? options.sourceMedia : null;

    this._updateHostLoad();
  }

  set remoteDescriptor (remoteDescriptor) {
    if (remoteDescriptor) {
      this._remoteDescriptor = remoteDescriptor;
    }
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      this._localDescriptor = localDescriptor;
      this.mediaTypes.video = this.sourceMedia.hasAvailableVideoCodec();
      this.mediaTypes.audio = this.sourceMedia.hasAvailableAudioCodec();
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  _updateHostLoad () {
    if (this.mediaTypes.video) {
      Balancer.incrementHostStreams(this.host.id, 'video');
      this.hasVideo = true;
    }

    if (this.mediaTypes.audio) {
      Balancer.incrementHostStreams(this.host.id, 'audio');
      this.hasAudio = true;
    }
  }
}
