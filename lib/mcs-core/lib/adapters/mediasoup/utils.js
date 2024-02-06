const { MEDIA_TYPE, MEDIA_PROFILE } = require('../../constants/constants');
const { MS_KINDS } = require('./constants.js');
const { extractCodecsListFromSDP } = require('./sdp-translator.js');
const Logger = require('../../utils/logger');
const { setProcessPriority } = require('../../../../common/utils.js');
const config = require('config');

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

const enrichCodecsWithRtcpFb = (codecs, extraCodecs) => {
  return codecs.map(codec => {
    // For each codec entry, find the matching mimeType entry in extraCodecs
    // and merge their rtcpFeedback entries (prioritizing the ones in the extraCodecs)
    const matchingExtraRtpParams = extraCodecs.find(extraRtpParam => extraRtpParam.mimeType === codec.mimeType);
    if (matchingExtraRtpParams) {
      if (!codec.rtcpFeedback == null || codec.rtcpFeedback.length == 0) {
        codec.rtcpFeedback = matchingExtraRtpParams.rtcpFeedback;
      } else {
        matchingExtraRtpParams.rtcpFeedback.forEach(rtcpFeedback => {
          if (!codec.rtcpFeedback.some(codecRtcpFeedback => codecRtcpFeedback.type === rtcpFeedback.type)) {
            codec.rtcpFeedback.push(rtcpFeedback);
          }
        });
      }
    }

    return codec;
  });
}

const enrichRtpParamsWithHdrExt = (rtpParameters, hdrExtMbFrozen) => {
  if (hdrExtMbFrozen == null || hdrExtMbFrozen.length == 0) return rtpParameters;

  const hdrExt = (Object.isExtensible(hdrExtMbFrozen) && Object.isExtensible(hdrExtMbFrozen[0]))
    ? hdrExtMbFrozen
    : config.util.cloneDeep(hdrExtMbFrozen);
  if (rtpParameters.headerExtensions == null || rtpParameters.headerExtensions.length == 0) {
    rtpParameters.headerExtensions = hdrExt;
  } else {
    hdrExt.forEach(headerExtension => {
      // Merge the extra headerExtensions into the rtpParameters ones
      // (prioritizing the ones in the extraCodecs and removing duplicates)
      if (!rtpParameters.headerExtensions.some(rtpHeaderExtension => rtpHeaderExtension.uri === headerExtension.uri)) {
        rtpParameters.headerExtensions.push(headerExtension);
      }
    });
  }

  return rtpParameters;
};

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
      mediaType,
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
    default:
      return [MS_KINDS.AUDIO, MS_KINDS.VIDEO];
  }
}

const replaceRouterCodecsWithSdpCodecs = (settings, sdp) => {
  try {
    const codecs = extractCodecsListFromSDP(sdp);
    settings.mediaCodecs = codecs;
  } catch (error) {
    Logger.warn('mediasoup: Failed to replace router mediaCodecs, fallback', {
      errorMessage: error.message,
    });
  }

  return settings;
}

const getSpecEntryFromMimeType = (mediaSpecs, mimeType) => {
  const [kind, codec] = mimeType.split('/');

  if (typeof codec === 'string') return mediaSpecs[codec.toUpperCase()];

  if (kind === MS_KINDS.VIDEO) return;

  if (kind === MS_KINDS.AUDIO) return;

  throw TypeError('InvalidMimeType');
};

module.exports = {
  getMappedTransportType,
  getCodecFromMimeType,
  getSpecEntryFromMimeType,
  enrichCodecsArrayWithPreferredPT,
  enrichCodecsWithRtcpFb,
  enrichRtpParamsWithHdrExt,
  getMappedMType,
  mapMTypesOrProfilesToKind,
  mapMTypesOrProfilesToKindDirection,
  filterValidMediaTypes,
  mapConnectionTypeToKind,
  replaceRouterCodecsWithSdpCodecs,
  setProcessPriority,
}
