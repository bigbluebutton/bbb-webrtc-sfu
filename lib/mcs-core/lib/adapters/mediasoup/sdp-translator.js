'use strict';

const SoupRTPU = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SoupORTCU = require("mediasoup-client/lib/ortc");
const RemoteSdp = require("mediasoup-client/lib/handlers/sdp/RemoteSdp");
const transform = require('sdp-transform');

const extractPlainRtpParameters = (jsonSdp, kind, rtcpMux) => {
  const mediaSections = jsonSdp.media || [];
  // Presuming kinds are unitary...
  const mediaLine = mediaSections.find((m) => m.type === kind);
  // media line IP or top level IP
  const connectionData = mediaLine.connection || jsonSdp.connection;

  return {
    ip: connectionData.ip,
    ipVersion: connectionData.version,
    port: mediaLine.port,
    rtcpPort: (!rtcpMux && mediaLine.rtcp) ? mediaLine.rtcp.port : undefined,
  };
}

const getRtcpParameters = (jsonSdp, kind) => {
  let cname, reducedSize;
  const mediaSections = jsonSdp.media || [];
  // Presuming kinds are unitary...
  const mediaLine = mediaSections.find((m) => m.type === kind);
  if (mediaLine) {
    if (mediaLine.ssrcs) {
      const ssrcCname = mediaLine.ssrcs.find(s => s.attribute && s.attribute === "cname");
      if (ssrcCname && ssrcCname.value) {
        cname = ssrcCname.value;
      }
    }
    reducedSize = mediaLine.rtcpRsize === 'rtcp-rsize';
  }

  return { cname, reducedSize };
}

const extractSendRtpParams = (kind, caps) => {
  return SoupORTCU.getSendingRtpParameters(kind, caps);
};

const extractRecvRTPParams = (extCaps) => {
  return SoupORTCU.getRecvRtpCapabilities(extCaps);
}

const extractRTPParamsForProducer = (jsonSdp, kind, msExtendedRtpCaps) => {
  const params = extractSendRtpParams(kind, msExtendedRtpCaps);
  const encodings = SoupRTPU.getRtpEncodings({
    sdpObject: jsonSdp,
    kind,
  });
  params.encodings = encodings;
  params.rtcp = getRtcpParameters(jsonSdp, kind);

  return params;
}

const extractRTPParamsForConsumer = (jsonSdp, kind, msExtendedRtpCaps) => {
  const params = extractRecvRTPParams(msExtendedRtpCaps);
  params.rtcp = getRtcpParameters(jsonSdp, kind);

  return params;
}

const extractRTPParams = (baseRTPCaps, jsonSdp, kind, mode) => {
  const caps = SoupSDPU.extractRtpCapabilities({
    sdpObject: jsonSdp,
  });

  const msExtendedRtpCaps = SoupORTCU.getExtendedRtpCapabilities(
    baseRTPCaps,
    caps
  );

  switch (mode) {
    case 'consumer':
      return extractRTPParamsForConsumer(jsonSdp, kind, msExtendedRtpCaps);
    case 'producer':
      return extractRTPParamsForProducer(jsonSdp, kind, msExtendedRtpCaps);
    case 'transceiver':
    default:
      throw new TypeError('Invalid mode');
  }
}

const extractCodecsListFromSDP = (jsonSdp) => {
  if (typeof jsonSdp !== 'object') throw new TypeError('Invalid SDP');

  const caps = SoupSDPU.extractRtpCapabilities({
    sdpObject: jsonSdp,
  });

  return caps.codecs || [];
}

// FIXME remove this once the bidirectionaly work + mediaTypes|profiles stuff
// is refactored and working properly
const _stripSsrcs = (targetMediaSection, { offerRtpParameters }) => {
  if (offerRtpParameters.encodings) {
    // Hack: manually delete ssrcs entry if we're talking about a sendonly
    // stream. Our answer doesn't need to have a ssrc if it's unidirectional.
    targetMediaSection._mediaObject.ssrcs = targetMediaSection._mediaObject.ssrcs.filter(({ ssrc }) => {
      !offerRtpParameters.encodings.some(({ targetSsrc }) => targetSsrc === ssrc);
    });
  }
  return targetMediaSection;
}

const _processHackFlags = (targetMediaSection, adapterOptions, parameters = {}) => {
  if (adapterOptions.msHackRTPAVPtoRTPAVPF) {
    if (targetMediaSection && targetMediaSection._mediaObject) {
      if (targetMediaSection._mediaObject.protocol !== 'RTP/AVPF') {
        targetMediaSection._mediaObject.protocol = targetMediaSection._mediaObject
          .protocol.replace(/RTP\/AVP/ig, 'RTP/AVPF');
      }
    }
  }

  if (adapterOptions.msHackStripSsrcs) {
    _stripSsrcs(targetMediaSection, parameters);
  }

  if (adapterOptions.overrideDirection && typeof adapterOptions.overrideDirection === 'string') {
    if (targetMediaSection && targetMediaSection._mediaObject) {
      targetMediaSection._mediaObject.direction = adapterOptions.overrideDirection;
    }
  }
}

const _getMappedDirectionFromMType = (mTDirection, mediaObject, taintedMediaObject) => {
  let tentativeDirection;
  const currentDirection = mediaObject.direction;

  switch (mTDirection) {
    case 'recvonly':
      tentativeDirection = 'sendonly';
      break;
    case 'sendonly':
      tentativeDirection = 'recvonly'
      break;
    case 'sendrecv':
      return 'sendrecv';
    default:
      tentativeDirection = 'inactive';
  }

  if (!taintedMediaObject) return tentativeDirection;

  if (tentativeDirection === 'sendonly') {
    if (currentDirection === 'recvonly' || currentDirection === 'sendrecv') {
      return 'sendrecv'
    }

    return 'sendonly';
  }

  if (tentativeDirection === 'recvonly') {
    if (currentDirection === 'sendonly' || currentDirection === 'sendrecv') {
      return 'sendrecv';
    }

    return 'recvonly';
  }

  if (tentativeDirection === 'inactive') {
    if (currentDirection !== 'inactive') return currentDirection;
    return 'inactive';
  }
};

const kMapTokMidMap = (kMap) => {
  const kMidMap = {};
  return kMap.reduce((pkMidMap, { kind }, i) => {
    if (typeof pkMidMap[kind] === 'string') return pkMidMap;
    return {
      ...pkMidMap,
      [kind]: i.toString(),
    };
  }, kMidMap);
};

// This obviously only works for single stream SDPs right now.
// But then again: when we reach the point where we want to do proper bundling
// and use less transports, we won't use SDP. So who cares? -- prlanzarin
const assembleSDP = (kindParametersMap, {
  transportOptions,
  adapterOptions = {},
}) => {
  let taintedMediaObject = false;
  const reassembledSDP = new RemoteSdp.RemoteSdp({
    ...transportOptions,
  });

  const kMidMap = kMapTokMidMap(kindParametersMap);
  kindParametersMap.forEach((kMap) => {
    const targetMid = kMidMap[kMap.kind];

    reassembledSDP.receive({
      mid: targetMid,
      kind: kMap.kind,
      offerRtpParameters: kMap.offerRtpParameters,
      streamId: kMap.streamId,
      trackId: kMap.trackId,
    });

    const targetMediaSection = reassembledSDP._mediaSections.find(
      ms => ms._mediaObject.mid == targetMid
    );

    if (targetMediaSection) {
      targetMediaSection._mediaObject.direction = _getMappedDirectionFromMType(
        kMap.direction,
        targetMediaSection._mediaObject,
        taintedMediaObject
      );
      taintedMediaObject = true;

      if (kMap.setup) {
        targetMediaSection._mediaObject.setup = kMap.setup;
      }

      // Hack: manually delete ssrcs entry if we're talking about a sendonly
      // stream. Our answer doesn't need to have a ssrc if it's unidirectional.
      if (kMap.direction === 'sendonly' && kMap.offerRtpParameters.encodings) {
        targetMediaSection._mediaObject.ssrcs = targetMediaSection._mediaObject.ssrcs.filter(({ ssrc }) => {
          !kMap.offerRtpParameters.encodings.some(({ targetSsrc }) => targetSsrc === ssrc);
        });
      }

      // If rtcpPort is specified, it means no rtcp-mux and we are implying
      // no rsize as well
      if (transportOptions.plainRtpParameters && transportOptions.plainRtpParameters.rtcpPort) {
        if (targetMediaSection._mediaObject.rtcpMux) {
          targetMediaSection._mediaObject.rtcpMux = null;
        }

        if (targetMediaSection._mediaObject.rtcpRsize) {
          targetMediaSection._mediaObject.rtcpRsize = null;
        }

        if (targetMediaSection._mediaObject.rtcp == null) {
          targetMediaSection._mediaObject.rtcp = {};
        }

        targetMediaSection._mediaObject.rtcp.port = transportOptions.plainRtpParameters.rtcpPort;
      }

      _processHackFlags(targetMediaSection, adapterOptions, {
          offerRtpParameters: kMap.offerRtpParameters,
      });
    }
  });

  return reassembledSDP.getSdp();
};

const reassembleSDPObjectFromMediaLines = (jsonSdp, mediaLines) => {
  if (!mediaLines || mediaLines.length <= 0) return;
  const partialSDP = Object.assign({}, jsonSdp);
  partialSDP.media = mediaLines;
  return partialSDP;
};

const generateOneSDPObjectPerMediaType = (jsonSdp) => {
  const descriptorsWithMType = []

  if (jsonSdp && jsonSdp.media) {
    jsonSdp.media.forEach(media => {
      const partialSDPObject = reassembleSDPObjectFromMediaLines(jsonSdp, [media]);
      if (partialSDPObject) {
        descriptorsWithMType.push({ mediaType: media.type, descriptor: partialSDPObject });
      }
    });
  }

  return descriptorsWithMType;
}

const mergeSameSourceSDPs = (stringSdpArray) => {
  if (stringSdpArray == null || stringSdpArray.length === 0) return;
  if (stringSdpArray.length === 1) return stringSdpArray[1];

  const targetSDP = transform.parse(stringSdpArray.shift());

  stringSdpArray.forEach(sdp => {
    const sdpObject = transform.parse(sdp);
    if (sdpObject.media) {
      sdpObject.media.forEach(ml => {
        targetSDP.media.push(ml);
      })
    }
  });

  return transform.write(targetSDP);
}

const stringifySDP = (sdpObject) => {
  return transform.write(sdpObject);
}

module.exports = {
  assembleSDP,
  getRtcpParameters,
  extractRTPParams,
  extractPlainRtpParameters,
  extractSendRtpParams,
  extractCodecsListFromSDP,
  generateOneSDPObjectPerMediaType,
  mergeSameSourceSDPs,
  stringifySDP,
};
