const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const Media = require('./media');
const Logger = require('../utils/logger');

module.exports = class InternalUnsupportedMedia extends Media {
  constructor(
    room,
    user,
    mediaSessionId,
    remoteDescriptor,
    type
  ) {
    super(room, user, mediaSessionId, type, null, null, null, {});
    // {SdpWrapper} SdpWrapper
    this._remoteDescriptor;
    this._localDescriptor;

    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }

    Logger.info("Unsupported media: created", this.getMediaInfo());
  }

  set remoteDescriptor (remoteDescriptor) {
    if (remoteDescriptor) {
      this._remoteDescriptor = new SdpWrapper(
        remoteDescriptor,
        C.DEFAULT_MEDIA_SPECS,
        C.MEDIA_PROFILE.INTERNAL_UNSUPPORTED,
        { preProcess: false }
      );
      this.localDescriptor = this.remoteDescriptor.generateInactiveDescriptor();
    }
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      this._localDescriptor = new SdpWrapper(
        localDescriptor,
        C.DEFAULT_MEDIA_SPECS,
        C.MEDIA_PROFILE.INTERNAL_UNSUPPORTED,
        { preProcess: false }
      );
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }
}
