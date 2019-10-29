/**
 * @classdesc
 * Utils class for manipulating SDP
 */

'use strict'

const config = require('config');
const transform = require('sdp-transform');
const C = require('../constants/constants.js');

module.exports = class SdpWrapper {
  constructor(sdp, mediaSpecs, type, params = {}) {
    this._plainSdp = sdp;
    this._jsonSdp = transform.parse(sdp);
    this._mediaLines = {};
    this._mediaCapabilities = {};
    this._profileThreshold = "ffffff";
    this.mediaSpecs = mediaSpecs;
    this.mediaProfile = type;
    this.preProcess = params.preProcess || true;
    if (this.preProcess) {
      this.supportedCodecs = SdpWrapper.getSupportedCodecsFromSpec(mediaSpecs);
      this.processSdp();
    }
  }

  get plainSdp() {
    return this._plainSdp;
  }

  get jsonSdp() {
    return this._jsonSdp;
  }

  removeFmtp () {
    return this._plainSdp.replace(/(a=fmtp:).*/g, '');
  }

  replaceServerIpv4 (ipv4) {
    return this._plainSdp.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + ipv4);
  }

  static convertToString (jsonSdp) {
    return transform.write(jsonSdp);
  }

  static nonPureReplaceServerIpv4 (sdp, ipv4) {
    return sdp.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + ipv4);
  }

  static getAudioSDP (sdp) {
    const asdp =  SdpWrapper.getAudioDescription(sdp);
    return asdp;
  }

  static getVideoSDP (sdp) {
    const vsdp =  SdpWrapper.getMainDescription(sdp);
    return vsdp;
  }

  static getContentSDP (sdp) {
    const csdp =  SdpWrapper.getContentDescription(sdp);
    return csdp;
  }

  static getSupportedCodecsFromSpec (spec) {
    return Object.keys(spec).filter(entry => {
      return entry !== 'codec_video_content'
        && entry !== 'codec_video_main'
        && entry !== 'codec_audio';
    });
  }

  generateInactiveDescriptor () {
    const newSDP = { ...this._jsonSdp };
    newSDP.media.forEach(ml => {
      ml.port = 0;
      ml.direction = 'inactive';
    });
    return transform.write(newSDP);
  }

  hasAudio () {
    return this._mediaCapabilities.hasAudio;
  }

  hasVideo () {
    return this._mediaCapabilities.hasVideo;
  }

  hasContent () {
    return this._mediaCapabilities.hasContent;
  }

  hasMultipleVideo () {
    return this._mediaCapabilities.hasMultipleVideo;
  }

  hasAvailableVideoCodec () {
    return this._mediaCapabilities.hasAvailableVideoCodec;
  }

  hasAvailableAudioCodec () {
    return this._mediaCapabilities.hasAvailableAudioCodec;
  }

  /**
   * Given a SDP, test if there is an audio description in it
   * @return {boolean}    true if there is more than one video description, else false
   */
  _hasAudio () {
    return /(m=audio)/i.test(this._plainSdp);
  }

  /**
   * Given a SDP, test if there is a video description in it
   * @return {boolean}    true if there is a video description, else false
   */
  _hasVideo () {
    return /(m=video)/i.test(this._plainSdp);
  }

  /**
   * Given a SDP, test if there is more than on video description
   * @return {boolean}    true if there is more than one video description, else false
   */
  _hasMultipleVideo () {
    return /(m=video)([\s\S]*\1){1,}/i.test(this._plainSdp);
  }

  /**
   * Tests if the current SDP has an available and valid video codec
   * @return {boolean} true if there is an RTP video session specified and active
   */
  _hasAvailableVideoCodec () {
    return this._jsonSdp.media.some((ml) => {
      let  { type, rtp, port } = ml;
      return type === 'video' && rtp && rtp.length > 0 && port !== 0;
    });
  }

  /**
   * Tests if the current SDP has an available and valid audio codec
   * @return {boolean} true if there is an RTP audio session specified and active
   */
  _hasAvailableAudioCodec () {
    return this._jsonSdp.media.some((ml) => {
      let  { type, rtp, port } = ml;
      return type === 'audio' && rtp && rtp.length > 0 && port !== 0;
    });
  }

  getDirection (type) {
    let direction, media;
    const fetchDirection = (m) => {
      if (m == null || m.direction == null) {
        return 'sendrecv';
      } else  {
        return media.direction;
      }
    }

    // If we're fetching the content direciton, we go for the video direction
    // because it's the only media type currently supported for content
    if (type === 'content') {
      if (this.contentVideoSdp) {
        const parsedContentSDP = transform.parse(this.contentVideoSdp);
        media = parsedContentSDP.media.find(m => m.type === 'video');
        return fetchDirection(media);
      }
      return false;
    }

    media = this._jsonSdp.media.find(m => m.type === type);
    return fetchDirection(media);
  }

  /**
   * Given a SDP, return its Session Description
   * @param  {string} sdp The Session Descriptor
   * @return {string}     Session description (SDP until the first media line)
   */
  static getSessionDescription (sdp) {
    return sdp.match(/[\s\S]+?(?=m=audio|m=video)/i);
  }

  /**
   * Given a SDP, strip the session description header from it and return the rest
   * (or undefined if theres no m=* lines on it);
   * @param  {String} sdp The Session Descriptor
   * @return {String} a SDP stripped of its header (m=* lines only)
   */
  static removeSessionDescription (sdp) {
    const sd = sdp.match(/(?=[\s\S]+?)(m=audio[\s\S]+|m=video[\s\S]+|m=application[\s\S]+)/i);
    return sd? sd[1] : undefined;
  }

  static strHasContentType (sdp, type) {
    return sdp.indexOf(`a=content:${type}`) !== -1;
  }

  getVideoParameters (sdp) {
    var res = transform.parse(sdp);
    var params = {};
    params.fmtp = "";
    params.codecId = 96;
    var pt = 0;
    for(var ml of res.media) {
      if(ml.type == 'video') {
        if (typeof ml.fmtp[0] != 'undefined' && ml.fmtp) {
          params.codecId = ml.fmtp[0].payload;
          params.fmtp = ml.fmtp[0].config;
          return params;
        }
      }
    }
    return params;
  }

  static isAudio (mediaLine) {
    return mediaLine.type == "audio";
  }

  static isVideo (mediaLine) {
    return mediaLine.type === "video" && !SdpWrapper.isContentSlides(mediaLine);
  }

  static isContentSlides (mediaLine) {
    const hasContentSlides = !!mediaLine.content && mediaLine.content === 'slides';
    return mediaLine.type === "video" && hasContentSlides;
  }

  static isApplication (mediaLine) {
    return mediaLine.type == "application";
  }

  static annotatedDescriptorEntry () {
    return {
      mediaLines: [],
      indexes: [],
      descriptor: '',
    };
  }

  static annotatedDescriptorsDictionary () {
    return {
      numberOfMediaLines: 0,
      annotatedDescriptors: {
        [C.MEDIA_PROFILE.AUDIO]: SdpWrapper.annotatedDescriptorEntry(),
        [C.MEDIA_PROFILE.MAIN]:  SdpWrapper.annotatedDescriptorEntry(),
        [C.MEDIA_PROFILE.CONTENT]: SdpWrapper.annotatedDescriptorEntry(),
        [C.MEDIA_PROFILE.APPLICATION]: SdpWrapper.annotatedDescriptorEntry(),
        [C.MEDIA_PROFILE.UNSUPPORTED]: SdpWrapper.annotatedDescriptorEntry(),
      }
    };
  }

  static getMediaLineType (mediaLine) {
    if (SdpWrapper.isAudio(mediaLine)) {
      return C.MEDIA_PROFILE.AUDIO;
    } else if (SdpWrapper.isVideo(mediaLine)) {
      return C.MEDIA_PROFILE.MAIN;
    } else if (SdpWrapper.isContentSlides(mediaLine)) {
      return C.MEDIA_PROFILE.CONTENT;
    } else if (SdpWrapper.isApplication(mediaLine)) {
      return C.MEDIA_PROFILE.APPLICATION;
    } else {
      return C.MEDIA_PROFILE.UNSUPPORTED;
    }
  }

  /**
   * Given a SDP, return its Content Description
   * @param  {string} sdp The Session Descriptor
   * @return {string}     Content Description (SDP after first media description)
   */
  static getContentDescription (sdp) {
    var res = transform.parse(sdp);
    res.media = res.media.filter(SdpWrapper.isContentSlides);
    // No content:slides media in this one
    if (res.media.length <= 0) {
      return;
    }

    var mangledSdp = transform.write(res);
    if(typeof mangledSdp != undefined && mangledSdp && mangledSdp != "") {
      return mangledSdp;
    }
    else
      return sdp;
  }

  /**
   * Given a SDP, return its first Media Description
   * @param  {string} sdp The Session Descriptor
   * @return {string}     Content Description (SDP after first media description)
   */
  static getAudioDescription (sdp) {
    var res = transform.parse(sdp);
    res.media = res.media.filter(SdpWrapper.isAudio);

    // Everything has been filtered and no audio was found
    if (res.media.length <= 0) {
      return;
    }

    // Hack: Some devices (Snom, Pexip) send crypto with RTP/AVP
    // That is forbidden according to RFC3711 and FreeSWITCH rebukes it
    res = SdpWrapper.removeTransformCrypto(res);
    const mangledSdp = transform.write(res);
    if(typeof mangledSdp != undefined && mangledSdp && mangledSdp != "") {
      return mangledSdp;
    }
    else {
      return sdp;
    }
  }

  /**
   * Given a SDP, return its first Media Description
   * @param  {string} sdp The Session Descriptor
   * @return {string}     Content Description (SDP after first media description)
   */
  static getMainDescription (description) {
    const res = transform.parse(description);
    res.media = res.media.filter(SdpWrapper.isVideo);

    // Everything has been filtered and no video/main was found
    if (res.media.length <= 0) {
      return;
    }

    const mangledSdp = transform.write(res);
    if (typeof mangledSdp != undefined && mangledSdp && mangledSdp != "") {
      return mangledSdp;
    }
    else {
      return sdp;
    }
  }

  /**
   * Given a sdp-transform parsed SDP jsonSDP and an Array of JSON media lines mediaLines,
   * returns a new SDP composed of jsonSDP's header and mediaLines
   * @param  {Object} jsonSDP A sdp-transform parsed JSON SDP
   * @params {Array} mediaLines An array of sdp-transform parsed JSON media lines
   * @return {String} A SDP composed of jsonSDP's header and mediaLines
   */
  static reassembleSDPFromMediaLines (jsonSDP, mediaLines) {
    if (!mediaLines || mediaLines.length <= 0) return '';
    let partialSDP = Object.assign({}, jsonSDP);
    partialSDP.media = mediaLines;
    const stringifiedPartialSDP = transform.write(partialSDP) || '';
    return stringifiedPartialSDP;
  };

  /**
   * Given a SDP, return all partial descriptors of either m=video or m=audio variety.
   * A partial descriptor is a single m=* line descriptor with a shared SDP header.
   * @param  {string} sdp The Session Descriptor
   * @return {Array.String} Array of partial descriptors
   */
  static getPartialDescriptions (descriptor) {
    if (!descriptor) {
      return [descriptor];
    }

    let res = transform.parse(descriptor);
    let descriptorsList = []
    res.media.forEach(media => {
      const stringifiedPartialSDP = SdpWrapper.reassembleSDPFromMediaLines(res, [media]);
      if (stringifiedPartialSDP && stringifiedPartialSDP !== '') {
        descriptorsList.push(stringifiedPartialSDP);
      }
    });
    return descriptorsList;
  }

  /**
   * Given a SDP, return an annotatedDescriptorsDictionary of the following format
   * {
   *   numberOfMediaLines: Intenger
   *   annotatedDescriptors: Array<annotatedDescriptorEntry>
   * }
   * Where annotatedDescriptorEntry is an Object of the following format:
   *   <type: String>: {
   *     mediaLines: Array<Objects> An array of JSON media lines of type <type>
   *     descriptor: String The aggregated SDP generated from mediaLines
   *     indexes: Array<Integer> The indexes in the original SDP for each of the media lines
   *   }
   *
   * The dictionary keys <type> are Strings defined in C.MEDIA_PROFILE
   * @param  {string} sdp The SDP
   * @return {Object} An Object aggregating all partial SDPs aggregated by type,
   * with their types annotated and original SDP ordering preserver
   */
  static getAnnotatedPartialDescriptors (sdp = '') {
    const annotatedDescriptorsDictionary = SdpWrapper.annotatedDescriptorsDictionary();
    if (!sdp) {
      return annotatedDescriptorsDictionary;
    }
    let jsonSDP = transform.parse(sdp);
    const { annotatedDescriptors } = annotatedDescriptorsDictionary;
    annotatedDescriptorsDictionary.numberOfMediaLines = jsonSDP.media.length || 0;
    jsonSDP.media.forEach((mediaLine, index) => {
      const type = SdpWrapper.getMediaLineType(mediaLine);
      const entry = annotatedDescriptors[type];
      entry.mediaLines.push(mediaLine);
      entry.indexes.push(index);
    });

    Object.keys(annotatedDescriptors).forEach(type => {
      const entry = annotatedDescriptors[type];
      entry.descriptor = SdpWrapper.reassembleSDPFromMediaLines(jsonSDP, entry.mediaLines);
    });

    return annotatedDescriptorsDictionary || {};
  }

  /**
   * Given a JSON SDP, remove associated crypto 'a=' lines from media lines
   * WARNING: HACK MADE FOR FreeSWITCH ~1.4 COMPATIBILITY
   * @param  {Object} sdp The Session Descriptor JSON
   * @return {Object}     JSON SDP without crypto lines
   */
  static removeTransformCrypto (sdp) {
    for(var ml of sdp.media) {
      delete ml['crypto'];
    }
    return sdp;
  }

  _fetchSpec_TI_AS (spec, codec, type) {
    if (spec[codec] == null) {
      return null;
    }

    switch (type) {
      case C.MEDIA_PROFILE.CONTENT:
        return { tias: spec[codec].tias_content, as: spec[codec].as_content };
        break;
      case C.MEDIA_PROFILE.MAIN:
      default:
        return { tias: spec[codec].tias_main, as: spec[codec].as_main };
    }
  }

  _fetchSpecCodecs (spec, type) {
    let videoCodec, audioCodec, contentCodec;
    contentCodec = spec.codec_video_content.toUpperCase();
    videoCodec = spec.codec_video_main.toUpperCase();
    audioCodec = spec.codec_audio.toUpperCase();

    return { contentCodec, videoCodec, audioCodec };
  }

  _fetchH264ProfileParams (spec, type) {
    let profileParams = '';
    switch (type) {
      case 'content':
        const { max_mbps_content, max_fs_content, max_br_content } = spec;
        if (max_mbps_content && max_mbps_content > 0) {
          profileParams += `; max-mbps=${max_mbps_content}`;
        }
        if (max_fs_content && max_fs_content > 0) {
          profileParams += `; max-fs=${max_fs_content}`;
        }
        if (max_br_content && max_br_content > 0) {
          profileParams += `; max-mbps=${max_br_content}`;
        }
        return profileParams;
        break;
      case 'main':
      default:
        const { max_mbps_main, max_fs_main, max_br_main} = spec;
        if (max_mbps_main && max_mbps_main > 0) {
          profileParams += `; max-mbps=${max_mbps_main}`;
        }
        if (max_fs_main && max_fs_main > 0) {
          profileParams += `; max-fs=${max_fs_main}`;
        }
        if (max_br_main && max_br_main > 0) {
          profileParams += `; max-mbps=${max_br_main}`;
        }
        return profileParams;
    }
  }

  _fetchOPUSProfileParams (spec) {
    let profileParams = '';

    Object.keys(spec).forEach(p => {
      if (profileParams !== '') {
        profileParams += `; ${p}=${spec[p]}`;
      } else {
        profileParams += `${p}=${spec[p]}`;
      }
    });

    return profileParams;
  }

  submitToSpec (sdp, spec) {
    let res = transform.parse(sdp);
    let { videoCodec, contentCodec, audioCodec } = this._fetchSpecCodecs(spec);
    let pt = 0;

    res = SdpWrapper.filterByVideoCodec(res, videoCodec, contentCodec, this.mediaProfile);

    if (videoCodec === 'ANY') {
      // We use the VP8 SDP specifiers if a preferred video codec wasn't defined in config
      videoCodec = 'VP8';
    }

    if (contentCodec === 'ANY') {
      // We use the VP8 SDP specifiers if a preferred content codec wasn't defined in config
      contentCodec = 'VP8';
    }

    if (audioCodec === 'ANY') {
      // We use the OPUS SDP specifiers if a preferred audio codec wasn't defined in config
      audioCodec = 'OPUS';
    }

    res.media.forEach(ml => {
      if (ml.type == 'video') {
        let codecToFilter, actualMediaProfile;
        if (this.mediaProfile === C.MEDIA_PROFILE.MAIN) {
          codecToFilter = videoCodec;
          actualMediaProfile = this.mediaProfile;
        } else if (this.mediaProfile === C.MEDIA_PROFILE.CONTENT) {
          codecToFilter = contentCodec;
          actualMediaProfile = this.mediaProfile;
        } else {
          const hasContentSlides = SdpWrapper.isContentSlides(ml);
          codecToFilter = hasContentSlides? contentCodec : videoCodec;
          actualMediaProfile = hasContentSlides? C.MEDIA_PROFILE.CONTENT : C.MEDIA_PROFILE.MAIN
        }

        this._addBandwidth(ml, 'video', this._fetchSpec_TI_AS(spec, codecToFilter, actualMediaProfile));

        // No FMTP. Shouldn't happen, so we forcibly pre-start a FMTP line
        // and post-process it on the next forEach
        if (ml.fmtp == null || ml.fmtp.length <= 0) {
          ml.ftmp = [];
          ml.rtp.forEach(({ payload }) => {
            ml.fmtp.push({ payload, config: '' });
          });
        }

        ml.fmtp.forEach(fmtp => {
          let fmtpConfig = transform.parseParams(fmtp.config);
          let profileId = fmtpConfig['profile-level-id'];
          // Reconfiguring the FMTP to coerce endpoints to obey to our will
          if (codecToFilter === 'H264') {
            let configProfile = "profile-level-id=" + spec[codecToFilter].profile_level_id;
            configProfile += this._fetchH264ProfileParams(spec[codecToFilter], actualMediaProfile);

            if (spec[codecToFilter].packetization_mode) {
              configProfile += `; packetization-mode=${spec[codecToFilter].packetization_mode}`;
            }

            if (spec[codecToFilter].level_asymmetry_allowed) {
              configProfile += `; level-asymmetry-allowed=${spec[codecToFilter].level_asymmetry_allowed}`;
            }

            fmtp.config = configProfile;
          }
        });
      }

      if (ml.type === 'audio') {
        ml.rtp.forEach(rtp => {
          if (rtp.codec.toUpperCase().includes('OPUS')) {
            let fmtps = ml.fmtp.filter(f => f.payload === rtp.payload);
            fmtps.forEach(fmtp => {
              let fmtpConfig = transform.parseParams(fmtp.config);
              // Reconfiguring the FMTP to coerce endpoints to obey to audio spec
              // IF audioCodec was defined in the spec
              if (spec[audioCodec]) {
                let configProfile = this._fetchOPUSProfileParams(spec[audioCodec]);
                fmtp.config = configProfile;
              }
            });
          }
        });
      }
    });


    return transform.write(res);
  }

  _addBandwidth (ml, type, bw) {
    if (bw == null) {
      return ml;
    }
    let pt = 0;
    const { tias, as } = bw;

    // Bandwidth format
    // { type: 'TIAS or AS', limit: 2048000 }
    if(ml.type === type ) {
      ml['bandwidth'] = [];
      if (tias > 0) {
        ml.bandwidth.push({ type: 'TIAS', limit: tias })
      }
      if (as > 0) {
        ml.bandwidth.push({ type: 'AS', limit: as });
      }
    }

    return ml;
  }

  addActiveDirection (sdp) {
    sdp = sdp.replace(/(m=.*\r\n)/g, (str, mediaLine)  => {
      return mediaLine + 'a=direction:active\r\n';
    });

    return sdp;
  }

  processSdp () {
    let description = this._plainSdp = this.submitToSpec(this._plainSdp, this.mediaSpecs, this.mediaProfile);
    this._jsonSdp = transform.parse(this._plainSdp);
    description = description.toString().replace(/telephone-event/, "TELEPHONE-EVENT");
    this._mediaCapabilities.hasVideo = this._hasVideo();
    this._mediaCapabilities.hasAudio = this._hasAudio();
    this._mediaCapabilities.hasAvailableVideoCodec = this._hasAvailableVideoCodec();
    this._mediaCapabilities.hasAvailableAudioCodec = this._hasAvailableAudioCodec();
    this.sessionDescriptionHeader = SdpWrapper.getSessionDescription(description);
    this.audioSdp =  SdpWrapper.getAudioDescription(description);
    this.mainVideoSdp = SdpWrapper.getMainDescription(description);
    this.contentVideoSdp = SdpWrapper.getContentDescription(description);
    this._mediaCapabilities.hasContent = this.contentVideoSdp? true : false;
  }

  static filterByVideoCodec (sdp, videoCodec, contentCodec, mediaProfile) {
    let res = typeof sdp === 'string'? transform.parse(sdp) : sdp;
    let validPayloads;

    res.media.forEach((ml, index) => {
      let codecToFilter;
      if (mediaProfile === C.MEDIA_PROFILE.MAIN) {
        codecToFilter = videoCodec;
      } else if (mediaProfile === C.MEDIA_PROFILE.CONTENT) {
        codecToFilter = contentCodec;
      } else {
        const hasContentSlides = SdpWrapper.isContentSlides(ml);
        codecToFilter = hasContentSlides? contentCodec : videoCodec;
      }

      if (ml.type === 'video' && codecToFilter !== 'ANY') {
        // Video: filter by @codec
        ml.rtp = ml.rtp.filter((elem) => {
          return elem.codec.toUpperCase() === codecToFilter;
        });

        validPayloads = ml.rtp.map((elem) => {
          return elem.payload;
        });

        if (ml.fmtp) {
          ml.fmtp = ml.fmtp.filter((elem) => {
            return validPayloads.indexOf(elem.payload) >= 0;
          });
        }

        if (ml.rtcpFb) {
          ml.rtcpFb = ml.rtcpFb.filter((elem) => {
            return elem.payload === '*' || validPayloads.indexOf(elem.payload) >= 0;
          });
        }

        ml.payloads = validPayloads.join(' ');

        // Check is the media line has no available codec and strip it off
        if (!ml.rtp || ml.rtp.length <= 0 || ml.payloads === '') {
          res.media.splice(index, 1);
        }
      } else {
        // passthrough filtering
        validPayloads = ml.rtp.map((elem) => {
          return elem.payload;
        });

        if (ml.fmtp) {
          ml.fmtp = ml.fmtp.filter((elem) => {
            return validPayloads.indexOf(elem.payload) >= 0;
          });
        }

        ml.payloads = validPayloads.join(' ');
      }
    });

    return res;
  };

  // updatedWrapper is a SDPWrapper instance which can be operated upon
  // TODO update the subparameters of the spec as well (.H264, .VP8, .OPUS)
  static updateSpecWithChosenCodecs (updatedWrapper) {
    const res = updatedWrapper._jsonSdp;
    const codecMap = {
      codec_video_main: null,
      codec_video_content: null,
      codec_audio: null,
    }

    res.media.forEach(ml => {
      if (ml.type == 'video') {
        const hasContentSlides = SdpWrapper.isContentSlides(ml);
        if (updatedWrapper.mediaProfile === C.MEDIA_PROFILE.MAIN || !hasContentSlides) {
          if (!codecMap.codec_video_main) {
            ml.rtp.some(rtp => {
              if (!codecMap.codec_video_main) {
                codecMap.codec_video_main = rtp.codec.toUpperCase();
                return true;
              }
            });
          }
        } else if (updatedWrapper.mediaProfile === C.MEDIA_PROFILE.CONTENT || hasContentSlides) {
          if (!codecMap.codec_video_content) {
            ml.rtp.some(rtp => {
              if (!codecMap.codec_video_content) {
                codecMap.codec_video_content = rtp.codec.toUpperCase();
                return true;
              }
            });
          }
        }
      }

      if (!codecMap.codec_audio) {
        if (ml.type === 'audio') {
          ml.rtp.some(rtp => {
            if (!codecMap.codec_audio) {
              codecMap.codec_audio= rtp.codec.toUpperCase();
              return true;
            }
          });
        }
      }
    });

    const { codec_video_main, codec_video_content, codec_audio } = codecMap;
    updatedWrapper.mediaSpecs.codec_video_main = codec_video_main? codec_video_main : updatedWrapper.mediaSpecs.codec_video_main;
    updatedWrapper.mediaSpecs.codec_video_content = codec_video_content? codec_video_content: updatedWrapper.mediaSpecs.codec_video_content;
    updatedWrapper.mediaSpecs.codec_audio = codec_audio? codec_audio : updatedWrapper.mediaSpecs.codec_audio;
    return updatedWrapper.mediaSpecs;
  }
};
