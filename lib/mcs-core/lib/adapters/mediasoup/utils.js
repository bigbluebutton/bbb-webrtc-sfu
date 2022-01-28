const { MEDIA_TYPE, MEDIA_PROFILE } = require('../../constants/constants');
const { MS_KINDS } = require('./constants.js');
const { extractCodecsListFromSDP } = require('./sdp-translator.js');
const Logger = require('../../utils/logger');
const { LOG_PREFIX } = require('./configs.js');

const getMappedTransportType = (mcsCoreType) => {
  switch (mcsCoreType) {
    case MEDIA_TYPE.WEBRTC:
      return 'WebRtcTransport';
    case MEDIA_TYPE.RTP:
      return 'PlainTransport';
    default:
      return 'UnknownTransport';
  }
}

const getCodecFromMimeType = (mimeType) => {
  return mimeType.substring((mimeType.lastIndexOf("/") + 1), mimeType.length);
}

const enrichCodecsArrayWithPreferredPT = (codecs) => {
  return codecs.map(codec => {
    if (codec.preferredPayloadType == null && codec.payloadType) {
      codec.preferredPayloadType = codec.payloadType
    }

    return codec;
  });
}

// TODO Soft duplicate of the version in BaseMediasoupElement; that one should
// be removed
const getMappedMType = (apiProfileOrMType) => {
  switch (apiProfileOrMType) {
    case MS_KINDS.VIDEO:
      return MS_KINDS.VIDEO;
    case MEDIA_PROFILE.AUDIO:
      return MS_KINDS.AUDIO;
    case MEDIA_PROFILE.CONTENT:
      return MS_KINDS.VIDEO;
    default:
      return;
  }
}

const mapMTypesOrProfilesToKind = (mTypesOrProfiles) => {
  const actualMediaTypes = [];
  for (const [mediaType, mediaTypeDir] of Object.entries(mTypesOrProfiles)) {
    if (mediaTypeDir) actualMediaTypes.push(getMappedMType(mediaType));
  }

  return actualMediaTypes;
}

const filterValidMediaTypes = (mediaTypes) => {
  const filteredMediaTypes = {}

  Object.keys(mediaTypes).forEach(type=> {
    if (mediaTypes[type]) filteredMediaTypes[type] = mediaTypes[type];
  })

  return filteredMediaTypes;
}


const mapMTypesOrProfilesToKindDirection = (mTypesOrProfiles) => {
  const kindDirectionArray = [];
  for (const [mediaType, direction] of Object.entries(mTypesOrProfiles)) {
    if (direction) kindDirectionArray.push({
      kind: getMappedMType(mediaType),
      direction,
    });
  }

  return kindDirectionArray;
};

const mapConnectionTypeToKind = (connectionType) => {
  switch (connectionType) {
    case 'AUDIO':
      return [MS_KINDS.AUDIO];
    case 'VIDEO':
      return [MS_KINDS.VIDEO];
    case 'ALL':
      return [MS_KINDS.AUDIO, MS_KINDS.VIDEO];
  }
}

const replaceRouterCodecsWithSdpCodecs = (settings, sdp) => {
  try {
    const codecs = extractCodecsListFromSDP(sdp);
    settings.mediaCodecs = codecs;
  } catch (error) {
    Logger.warn(LOG_PREFIX, 'Failed to replace router mediaCodecs, fallback', {
      errorMessage: error.message,
    });
  }

  return settings;
}

module.exports = {
  getMappedTransportType,
  getCodecFromMimeType,
  enrichCodecsArrayWithPreferredPT,
  getMappedMType,
  mapMTypesOrProfilesToKind,
  mapMTypesOrProfilesToKindDirection,
  filterValidMediaTypes,
  mapConnectionTypeToKind,
  replaceRouterCodecsWithSdpCodecs,
}
