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

module.exports = class RecordingMedia extends Media {
  constructor(
    room,
    user,
    mediaSessionId,
    offer,
    answer,
    type,
    adapter,
    adapterElementId,
    host,
    options
  ) {
    super(room, user, mediaSessionId, type, adapter, adapterElementId, host, options);
    Logger.info("[mcs-sdp-media] New session with options", type);
    // {SdpWrapper} SdpWrapper
    if (answer) {
      this.setAnswer(answer);
    }

    this.sourceMedia = options.sourceMedia? options.sourceMedia : null;

    this._updateHostLoad();
  }

  setOffer (offer) {
    if (offer) {
      this.offer = offer;
    }
  }

  setAnswer (answer) {
    if (answer) {
      this.answer = answer;
      this.mediaTypes.video = this.sourceMedia.hasAvailableVideoCodec();
      this.mediaTypes.audio = this.sourceMedia.hasAvailableAudioCodec();
    }
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
