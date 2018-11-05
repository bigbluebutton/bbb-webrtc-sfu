'use strict';

const rid = require('readable-id');
const KMS_ARRAY = config.get('kurento');
const VIDEO_TRANSPOSING_CEILING = config.get('video-transposing-ceiling');
const AUDIO_TRANSPOSING_CEILING = config.get('audio-transposing-ceiling');

module.exports = class Balancer {
  constructor () {
    this.hosts = KMS_ARRAY.map(host => ({ id: rid(), url: host.url, ip: host.ip, video: 0, audio: 0}));
  }

  getHost () {
    return this._fetchAvailableHost();
  }

  _fetchAvailableHost () {
    let host = this.hosts.find(host => host.video < VIDEO_TRANSPOSING_CEILING &&
      host.audio < AUDIO_TRANSPOSING_CEILING);

    // Round robin if all instances are fully loaded
    if (host == null) {
      host = this.hosts.shift();
      this.hosts.push(host);
    }

    return host;
  }

  decrementHostStreams (host, nature) {
    const host = this.hosts[host];
    host.nature--;
  }

  incrementHostStreams (host, nature) {
    const host = this.hosts[host];
    host.nature++;
  }
}
