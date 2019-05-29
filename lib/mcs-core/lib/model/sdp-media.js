/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const rid = require('readable-id');
const Media = require('./media');
const Balancer = require('../media/balancer');
const config = require('config');
const Logger = require('../utils/logger');

module.exports = class SDPMedia extends Media {
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
    Logger.info("[mcs-sdp-media] New session with options", type);
    // {SdpWrapper} SdpWrapper
    this._remoteDescriptor;
    this._localDescriptor;

    if (localDescriptor) {
      this.localDescriptor = localDescriptor;
    }

    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }

    this._updateHostLoad();
  }

  set remoteDescriptor (remoteDescriptor) {
    if (remoteDescriptor) {
      if (this.remoteDescriptor) {
        this._shouldRenegotiate = true;
      }

      this._remoteDescriptor = new SdpWrapper(remoteDescriptor, this.mediaSpecs, this.mediaProfile);
      this.fillMediaTypes(this.remoteDescriptor);
    }
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      // Manual NAT traversal for when the media server is behind NAT
      if (this.type !== C.MEDIA_TYPE.WEBRTC) {
        localDescriptor = SdpWrapper.nonPureReplaceServerIpv4(localDescriptor, this.host.ip);
      }

      this._localDescriptor = new SdpWrapper(localDescriptor, this.mediaSpecs, this.mediaProfile);
      this.fillMediaTypes(this.localDescriptor);
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  fillMediaTypes (descriptor) {
    this.mediaTypes.video = descriptor.hasAvailableVideoCodec() ? descriptor.getDirection('video') : false;
    this.mediaTypes.audio = descriptor.hasAvailableAudioCodec() ? descriptor.getDirection('audio') : false;
    this.mediaTypes.content = descriptor.hasContent() ? descriptor.getDirection('content') : false;
  }

  addIceCandidate (candidate) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.adapter.addIceCandidate(this.adapterElementId, candidate);
        resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  _updateHostLoad () {
    if (this.localDescriptor.hasAvailableVideoCodec()) {
      Balancer.incrementHostStreams(this.host.id, 'video');
      this.hasVideo = true;
    }

    if (this.localDescriptor.hasAvailableAudioCodec()) {
      Balancer.incrementHostStreams(this.host.id, 'audio');
      this.hasAudio = true;
    }
  }
}
