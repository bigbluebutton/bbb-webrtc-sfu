const C = require('../constants/constants.js');
const crypto = require('crypto');
const { v4: uuidv4 }= require('uuid');

const _getRandomU32 = () => {
  return new Promise((resolve, reject) => {
    // 32-bit id
    crypto.randomBytes(4, (error, buffer) => {
      if (error) return reject(error);
      try {
        const rId = buffer.readUInt32BE(0);
        return resolve(rId);
      } catch (error) {
        return reject(error);
      }
    });
  });
}

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

  appendContentTypeIfNeeded: (descriptor, mediaType) => {
    // Check if we need to add :main or :slides
    switch (mediaType) {
      case C.MEDIA_PROFILE.MAIN:
        return descriptor + "a=content:main\r\n";
        break;
      case C.MEDIA_PROFILE.CONTENT:
        return descriptor + "a=content:slides\r\n";
        break;
      default:
        return descriptor;
        break;
    }
  },

  getNewSsrcId: () => {
    return _getRandomU32();
  },

  getNewCNAME: () => {
    return uuidv4().substr(0, 8);
  },
};
