/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const Media = require('./media');
const Balancer = require('../media/balancer');
const Logger = require('../utils/logger');
const { isIP } = require('net');
const { getMappedIP } = require('../utils/ip-mapper.js');

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
    this.negotiationRole = '';

    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }

    if (localDescriptor) {
      this.localDescriptor = localDescriptor;
    }

    Logger.info("SDP media: created", this.getMediaInfo());
  }

  set remoteDescriptor (remoteDescriptor) {
    if (remoteDescriptor) {
      if (this.remoteDescriptor) {
        this._shouldRenegotiate = true;
      }

      if (this.localDescriptor == null && !this.negotiationRole) {
        this.negotiationRole = C.NEGOTIATION_ROLE.ANSWERER;
      }

      const wrapperOptions = {};

      if (this.localDescriptor && this.localDescriptor.localConnectionData) {
        const remoteIP = this.localDescriptor.localConnectionData.ip;
        wrapperOptions.remoteConnectionData = { version: isIP(remoteIP), ip: remoteIP }
      }

      this._remoteDescriptor = new SdpWrapper(remoteDescriptor, this.mediaSpecs, this.mediaProfile, wrapperOptions);
      this.fillMediaTypes(this.remoteDescriptor);

      if (this.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        this.mediaSpecs = SdpWrapper.updateSpecWithChosenCodecs(this.remoteDescriptor);
      }
    }
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      const wrapperOptions = {};
      // Manual NAT traversal for when the media server is behind NAT
      if (this.type !== C.MEDIA_TYPE.WEBRTC) {
        let ip, remoteConnectionData;

        if (this.remoteDescriptor == null || this.remoteDescriptor.remoteConnectionData == null) {
          ip = this.host.ipClassMappings.public;
        } else {
          const remoteIP = this.remoteDescriptor.localConnectionData.ip;
          ip = getMappedIP(
            remoteIP,
            this.host.ipClassMappings
          );

          remoteConnectionData = { version: isIP(remoteIP), ip: remoteIP };
        }

        wrapperOptions.localConnectionData =  { version: isIP(ip), ip };
        wrapperOptions.remoteConnectionData = remoteConnectionData;
      }

      this._localDescriptor = new SdpWrapper(localDescriptor, this.mediaSpecs, this.mediaProfile, wrapperOptions);

      // TODO review this Freeswitch check. It's no good.
      if (this.remoteDescriptor
        && this.remoteDescriptor.remoteConnectionData
        && this.adapter.name === 'Freeswitch') {
        this._localDescriptor.duplicateCandidatesFromMappings(this.host.ipClassMappings, 'host');
      }

      // We're acting as offerer. Set the media types firsthand to do proper processing.
      // The remote mediaTypes will be re-set once the remote offer comes through
      if (this.remoteDescriptor == null) {
        this.fillMediaTypes(this.localDescriptor);
        if (!this.negotiationRole) {
          this.negotiationRole = C.NEGOTIATION_ROLE.OFFERER;
        }
      }

      this._updateHostLoad();

      if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
        this.mediaSpecs = SdpWrapper.updateSpecWithChosenCodecs(this.localDescriptor);
      }
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  _getVideoDirection (descriptor) {
    if (descriptor.hasAvailableVideoCodec()) {
      if (this.profiles
        && this.profiles.video
        && typeof this.profiles.video === 'string') {
        return this.profiles.video;
      }

      return descriptor.getDirection('video');
    }

    return false;
  }

  _getContentDirection (descriptor) {
    if (descriptor.hasAvailableVideoCodec()) {
      if (this.profiles
        && this.profiles.content
        && typeof this.profiles.content === 'string') {
        return this.profiles.content;
      }

      return descriptor.getDirection('video');
    }

    return false;
  }

  _getAudioDirection (descriptor) {
    if (descriptor.hasAvailableAudioCodec()) {
      if (this.profiles
        && this.profiles.audio
        && typeof this.profiles.audio === 'string') {
        return this.profiles.audio;
      }

      return descriptor.getDirection('audio');
    }

    return false;
  }

  fillMediaTypes (descriptor) {
    const videoDirection = this._getVideoDirection(descriptor);
    // Check whether we're dealing with a main or content media by either the
    // mediaProfile identifier or content:slides in the SDP
    const hasContent = descriptor.hasContent() || this.mediaProfile === C.MEDIA_PROFILE.CONTENT;

    if (hasContent) {
      this.mediaTypes.content = this._getContentDirection(descriptor);
    } else {
      this.mediaTypes.video = videoDirection;
    }

    this.mediaTypes.audio = this._getAudioDirection(descriptor);

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

  async addIceCandidate (candidate) {
    try {
      await this.adapter.addIceCandidate(this.adapterElementId, candidate);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  _updateHostLoad () {
    if (this.mediaTypes.video && !this.hasVideo) {
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.MAIN);
      this.hasVideo = true;
    }

    if (this.mediaTypes.audio && !this.hasAudio) {
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.AUDIO);
      this.hasAudio = true;
    }

    if (this.mediaTypes.content && !this.hasContent) {
      Balancer.incrementHostStreams(this.host.id, C.MEDIA_PROFILE.CONTENT);
      this.hasContent= true;
    }
  }
}
