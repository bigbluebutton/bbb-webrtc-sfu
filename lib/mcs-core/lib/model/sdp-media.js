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
const LOG_PREFIX = "[mcs-sdp-media]";

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
    // {SdpWrapper} SdpWrapper
    this._remoteDescriptor;
    this._localDescriptor;

    if (localDescriptor) {
      this.localDescriptor = localDescriptor;
    }

    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }

    Logger.info(LOG_PREFIX,  "New media created", JSON.stringify(this.getMediaInfo()));
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
      // We're acting as offerer. Set the media types firsthand to do proper processing.
      // The remote mediaTypes will be re-set once the remote offer comes through
      if (this.remoteDescriptor == null) {
        this.fillMediaTypes(this.localDescriptor);
      }
      this._updateHostLoad();
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  fillMediaTypes (descriptor) {
    const videoDirection = descriptor.hasAvailableVideoCodec() ? descriptor.getDirection('video') : false;
    // Check whether we're dealing with a main or content media by either the
    // mediaProfile identifier or content:slides in the SDP
    this.hasContent = descriptor.hasContent() || this.mediaProfile === C.MEDIA_PROFILE.CONTENT;
    if (this.hasContent) {
      this.mediaTypes.content = videoDirection;
    } else {
      this.mediaTypes.video = videoDirection;
    }
    this.mediaTypes.audio = descriptor.hasAvailableAudioCodec() ? descriptor.getDirection('audio') : false;

    // Automatically set based on mediaTypes
    if (!this.mediaProfile) {
      if (this.mediaTypes.video) {
        this.mediaProfile === C.MEDIA_PROFILE.MAIN;
      } else if (this.mediaTypes.audio) {
        this.mediaProfile === C.MEDIA_PROFILE.AUDIO;
      } else if (this.mediaTypes.content) {
        this.mediaProfile === C.MEDIA_PROFILE.CONTENT;
      }
    }
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
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.MAIN);
      this.hasVideo = true;
    }

    if (this.localDescriptor.hasAvailableAudioCodec()) {
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.AUDIO);
      this.hasAudio = true;
    }

    if (this.mediaTypes.content) {
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.CONTENT);
      this.hasContent= true;
    }
  }
}
