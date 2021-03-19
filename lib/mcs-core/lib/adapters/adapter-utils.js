const C = require('../constants/constants.js');

module.exports = {
  shouldSendCandidate: (candidate, acl = []) => {
    if (acl.length <= 0) {
      return true;
    }

    return acl.some(ip => candidate.includes(ip));
  },

  ismDNSCandidate: (candidate) => {
    const mDNSRegex = /([\d\w-]*)(.local)/ig
    if (candidate.match(/.local/ig)) {
      return true;
    }
    return false;
  },

  parseMediaType: (options) => {
    // FIXME I'm not a fan of the mediaProfile vs mediaType boogaloo
    const { mediaProfile, mediaTypes }  = options;

    if (mediaProfile) {
      return mediaProfile;
    }

    if (mediaTypes) {
      const { video, audio, content } = mediaTypes;
      if (video) {
        return C.MEDIA_PROFILE.MAIN;
      } else if (audio) {
        return C.MEDIA_PROFILE.AUDIO;
      } else if (content) {
        return C.MEDIA_PROFILE.CONTENT;
      }
    }

    return C.MEDIA_PROFILE.ALL;
  },
};
