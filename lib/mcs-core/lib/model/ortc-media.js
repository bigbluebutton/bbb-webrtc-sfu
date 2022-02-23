/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const Media = require('./media');
const Logger = require('../utils/logger');
const LOG_PREFIX = "[mcs-ortc-media]";

module.exports = class ORTCMedia extends Media {
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
    // ORTC objects
    this._remoteDescriptor;
    this._localDescriptor;
    this.negotiationRole = '';

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

      if (this.localDescriptor == null && !this.negotiationRole) {
        this.negotiationRole = C.NEGOTIATION_ROLE.ANSWERER;
      }

      this._remoteDescriptor = remoteDescriptor;
      this.fillMediaTypes(this.remoteDescriptor);

      if (this.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        // TODO spec enforcement
      }
    }
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      this._localDescriptor = localDescriptor;
      // We're acting as offerer. Set the media types firsthand to do proper processing.
      // The remote mediaTypes will be re-set once the remote offer comes through
      if (this.remoteDescriptor == null) {
        this.fillMediaTypes(this.localDescriptor);
        if (!this.negotiationRole) {
          this.negotiationRole = C.NEGOTIATION_ROLE.OFFERER;
        }
      }

      if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
        // TODO spec enforcement
      }
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  _getVideoDirection (descriptor) {
    // TODO should inspect descriptor
    if (this.profiles
      && this.profiles.video
      && typeof this.profiles.video === 'string') {
      return this.profiles.video;
    }

    return false;
  }

  _getContentDirection (descriptor) {
    // TODO should inspect descriptor
    if (this.profiles
      && this.profiles.content
      && typeof this.profiles.content === 'string') {
      return this.profiles.content;
    }

    return false;
  }

  _getAudioDirection (descriptor) {
    // TODO should inspect descriptor
    if (this.profiles
      && this.profiles.audio
      && typeof this.profiles.audio === 'string') {
      return this.profiles.audio;
    }

    return false;
  }

  fillMediaTypes (descriptor) {
    const videoDirection = this._getVideoDirection(descriptor);
    // Check whether we're dealing with a main or content media the mediaProfile identifier
    const hasContent = this.mediaProfile === C.MEDIA_PROFILE.CONTENT;
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
}
