/**
 * @classdesc
 * Utils class for manipulating SDP
 */

'use strict'

const config = require('config');
const transform = require('sdp-transform');

module.exports = class SdpWrapper {
  constructor(sdp, mediaSpecs, type = 'main') {
    this._plainSdp = sdp;
    this._jsonSdp = transform.parse(sdp);
    this._mediaLines = {};
    this._mediaCapabilities = {};
    this._profileThreshold = "ffffff";
    this.mediaSpecs = mediaSpecs;
    this.type = type;
    this.processSdp();
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

  static nonPureReplaceServerIpv4(sdp, ipv4) {
    return sdp.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + ipv4);

  }

  replaceServerIpv4 (ipv4) {
    return this._plainSdp.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + ipv4);
  }

  static nonPureReplaceServerIpv4 (sdp, ipv4) {
    return sdp.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + ipv4);
  }

  static getAudioSDP (sdp) {
    const asdp =  SdpWrapper.getAudioDescription(sdp);
    return asdp;
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

  removeSessionDescription (sdp) {
    return sdp.match(/(?=[\s\S]+?)(m=audio[\s\S]+|m=video[\s\S]+)/i)[1];
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

  /**
   * Given a SDP, return its Content Description
   * @param  {string} sdp The Session Descriptor
   * @return {string}     Content Description (SDP after first media description)
   */
  getContentDescription (sdp) {
    var res = transform.parse(sdp);
    res.media = res.media.filter((ml) => {
      const hasContentSlides = ml.invalid? ml.invalid[0].value.includes('slides') : false;
      return ml.type === "video" && hasContentSlides;
    });

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
    res.media = res.media.filter(function (ml) { return ml.type == "audio" });

    // Everything has been filtered and no audio was found
    if (res.media.length <= 0) {
      return;
    }

    // Hack: Some devices (Snom, Pexip) send crypto with RTP/AVP
    // That is forbidden according to RFC3711 and FreeSWITCH rebukes it
    res = SdpWrapper.removeTransformCrypto(res);
    var mangledSdp = transform.write(res);
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
  getMainDescription () {
    var res = transform.parse(this._plainSdp);
    // Filter should also carry && ml.invalid[0].value != 'content:slides';
    // when content is enabled
    res.media = res.media.filter(function (ml) { return ml.type === "video" }); // && ml.invalid[0].value != 'content:slides'});

    // Everything has been filtered and no audio was found
    if (res.media.length <= 0) {
      return;
    }

    var mangledSdp = transform.write(res);
    if (typeof mangledSdp != undefined && mangledSdp && mangledSdp != "") {
      return mangledSdp;
    }
    else {
      return sdp;
    }
  }

  /**
   * Given a SDP, return all video descriptors
   * @param  {string} sdp The Session Descriptor
   * @return {Array.String} Video content descriptors
   */
  static getPartialDescriptions (descriptor) {
    let res = transform.parse(descriptor);
    let descriptorsList = []
    res.media = res.media.filter((ml) => { return ml.type == "video" || ml.type === 'audio'}); //&& ml.invalid[0].value != 'content:slides'});
    res.media.forEach(media => {
      let partialSDP = Object.assign({}, res);
      partialSDP.media = [media];
      const stringifiedPartialSDP = transform.write(partialSDP);
      if (stringifiedPartialSDP && stringifiedPartialSDP !== '') {
        descriptorsList .push(stringifiedPartialSDP);
      }
    });
    return descriptorsList;
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
      case 'content':
        return { tias: spec[codec].tias_content, as: spec[codec].as_content };
        break;
      case 'main':
      default:
        return { tias: spec[codec].tias_main, as: spec[codec].as_main };
    }
  }

  _fetchSpecCodecs (spec, type) {
    let videoCodec, audioCodec;
    switch (type) {
      case 'content':
        videoCodec = spec.codec_video_content.toUpperCase();
        break;
      case 'main':
      default:
        videoCodec = spec.codec_video_main.toUpperCase();
        audioCodec = spec.codec_audio.toUpperCase();
    }

    return { videoCodec, audioCodec };
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

  submitToSpec (sdp, spec, type) {
    let res = transform.parse(sdp);
    let { videoCodec, audioCodec } = this._fetchSpecCodecs(spec, type);
    let pt = 0;
    let idx = 0;

    res = SdpWrapper.filterByVideoCodec(res, videoCodec);

    if (videoCodec === 'ANY') {
      // We use the VP8 SDP specifiers if a preferred video codec wasn't defined in config
      videoCodec = 'VP8';
    }

    if (audioCodec === 'ANY') {
      // We use the OPUS SDP specifiers if a preferred audio codec wasn't defined in config
      audioCodec = 'OPUS';
    }

    res.media.forEach(ml => {
      if (ml.type == 'video') {
        ml.fmtp.forEach(fmtp => {
          let fmtpConfig = transform.parseParams(fmtp.config);
          let profileId = fmtpConfig['profile-level-id'];
          // Reconfiguring the FMTP to coerce endpoints to obey to our will
          if (videoCodec === 'H264') {
            let configProfile = "profile-level-id=" + spec[videoCodec].profile_level_id;
            configProfile += this._fetchH264ProfileParams(spec[videoCodec], type);

            if (spec[videoCodec].packetization_mode) {
              configProfile += `; packetization-mode=${spec[videoCodec].packetization_mode}`;
            }

            if (spec[videoCodec].level_asymmetry_allowed) {
              configProfile += `; level-asymmetry-allowed=${spec[videoCodec].level_asymmetry_allowed}`;
            }

            fmtp.config = configProfile;
          }
          idx++;
        });
      }

      if (ml.type === 'audio') {
        ml.rtp.forEach(rtp => {
          if (rtp.codec.toUpperCase().includes('OPUS')) {
            let fmtps = ml.fmtp.filter(f => f.payload === rtp.payload);
            fmtps.forEach(fmtp => {
              let fmtpConfig = transform.parseParams(fmtp.config);
              // Reconfiguring the FMTP to coerce endpoints to obey to audio
              let configProfile = this._fetchOPUSProfileParams(spec[audioCodec]);
              fmtp.config = configProfile;
              idx++;
            });
          }
        });
      }
    });

    res = this.addBandwidth(res, 'video', this._fetchSpec_TI_AS(spec, videoCodec, type));

    return transform.write(res);
  }

  addBandwidth (sdp, type, bw) {
    let res = typeof sdp === 'string'? transform.parse(sdp) : sdp;
    if (bw == null) {
      return res;
    }
    let pt = 0;
    let idx = 0;
    const { tias, as } = bw;

    // Bandwidth format
    // { type: 'TIAS or AS', limit: 2048000 }
    res.media.forEach(ml => {
      if(ml.type === type ) {
        ml['bandwidth'] = [];
        if (tias > 0) {
          ml.bandwidth.push({ type: 'TIAS', limit: tias })
        }
        if (as > 0) {
          ml.bandwidth.push({ type: 'AS', limit: as });
        }
      }
    });

    return res;
  }

  addActiveDirection (sdp) {
    sdp = sdp.replace(/(m=.*\r\n)/g, (str, mediaLine)  => {
      return mediaLine + 'a=direction:active\r\n';
    });

    return sdp;
  }

  processSdp () {
    let description = this._plainSdp = this.submitToSpec(this._plainSdp, this.mediaSpecs, this.type)
    this._jsonSdp = transform.parse(this._plainSdp);

    description = description.toString().replace(/telephone-event/, "TELEPHONE-EVENT");

    this._mediaCapabilities.hasVideo = this._hasVideo();
    this._mediaCapabilities.hasAudio = this._hasAudio();
    this._mediaCapabilities.hasAvailableVideoCodec = this._hasAvailableVideoCodec();
    this._mediaCapabilities.hasAvailableAudioCodec = this._hasAvailableAudioCodec();
    this.sessionDescriptionHeader = SdpWrapper.getSessionDescription(description);
    this.audioSdp =  SdpWrapper.getAudioDescription(description);
    this.mainVideoSdp = this.getMainDescription(description);
    this.partialDescriptors = SdpWrapper.getPartialDescriptions(description);
    this.contentVideoSdp = this.getContentDescription(description);
    this._mediaCapabilities.hasContent = this.contentVideoSdp? true : false;

    return;
  }

  /* DEVELOPMENT METHODS */
  _disableMedia  (sdp) {
    return sdp.replace(/(m=application\s)\d*/g, "$10");
  };

  /**
   * Given a SDP, add Floor Control response
   * @param  {string} sdp The Session Descriptor
   * @return {string}     A new Session Descriptor with Floor Control
   */
  _addFloorControl (sdp) {
    return sdp.replace(/a=inactive/i, 'a=sendrecv\r\na=floorctrl:c-only\r\na=setup:active\r\na=connection:new');
  }

  /**
   * Given a SDP, add Floor Control response to reinvite
   * @param  {string} sdp The Session Descriptor
   * @return {string}     A new Session Descriptor with Floor Control Id
   */
  _addFloorId (sdp) {
    sdp = sdp.replace(/(a=floorctrl:c-only)/i, '$1\r\na=floorid:1 m-stream:3');
    return sdp.replace(/(m=video.*)([\s\S]*?m=video.*)([\s\S]*)/i, '$1\r\na=content:main\r\na=label:1$2\r\na=content:slides\r\na=label:3$3');
  }

  /**
   * Given the string representation of a Session Descriptor, remove it's video
   * @param  {string} sdp The Session Descriptor
   * @return {string}     A new Session Descriptor without the video
   */
  _removeVideoSdp  (sdp) {
    return sdp.replace(/(m=video[\s\S]+)/g,'');
  };

  static filterByVideoCodec (sdp, codec) {
    let res = typeof sdp === 'string'? transform.parse(sdp) : sdp;
    let validPayloads;

    res.media.forEach((ml, index) => {
      if (ml.type === 'video' && codec !== 'ANY') {
        // Video: filter by @codec
        ml.rtp = ml.rtp.filter((elem) => {
          return elem.codec.toUpperCase() === codec;
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

  static convertToString (jsonSdp) {
    return transform.write(jsonSdp);
  }
};
