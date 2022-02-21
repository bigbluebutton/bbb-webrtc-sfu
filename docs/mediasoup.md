# mediasoup configurations

## Using mediasoup in BigBlueButton 2.5

1. If your server is behind NAT or the public IPs are in a network interface other than the default (**otherwise skip to step 2**):
   * Let $SERVER_IPv4 be your server's **public IPv4**
   * `yq w -i /etc/bigbluebutton/bbb-webrtc-sfu/production.yml mediasoup.webrtc.listenIps[0].ip "0.0.0.0"`
   * `yq w -i /etc/bigbluebutton/bbb-webrtc-sfu/production.yml mediasoup.webrtc.listenIps[0].announcedIp $SERVER_IPv4`
   * `yq w -i /etc/bigbluebutton/bbb-webrtc-sfu/production.yml mediasoup.plainRtp.listenIp.ip "0.0.0.0"`
   * `yq w -i /etc/bigbluebutton/bbb-webrtc-sfu/production.yml mediasoup.plainRtp.listenIp.announcedIp $SERVER_IPv4`
2. If you wish to enable IPv6 in mediasoup (**otherwise you're done**):
   * Let $SERVER_IPv6 be your server's IPv6
   * `yq w -i /etc/bigbluebutton/bbb-webrtc-sfu/production.yml mediasoup.webrtc.listenIps[1].ip $SERVER_IPv6`

## Controlling the number of mediasoup workers

### mediasoup.workers (default.example.yml, default.yml, production.yml)

This configuration controls the number of mediasoup workers intended for general use (media type agnostic, shared pool).

Accepted values are:
   * `"auto"`: creates `ceil((min(nproc,32) * 0.8) + (max(0, nproc - 32) / 2))` workers;
   * `"cores"`: creates workers up to the host's core count (as provided by os.cpus().length);
   * \<Number\>: overrides the number of workers with a fixed value;
   * The default and fallback values are `auto`.

As always, this configuration should be set via the override file in `/etc/bigbluebutton/bbb-webrtc-sfu/production.yml`. For example:
   * To set the number of workers to `cores`: `yq w -i /etc/bigbluebutton/bbb-webrtc-sfu/production.yml mediasoup.workers "cores"`

### mediasoup.dedicatedMediaTypeWorkers (default.example.yml, default.yml, production.yml)

This configuration controls the number of mediasoup workers to be used by specific media types.
If a dedicated pool is set, streams of its media type will always land on it. Otherwise, they will use the shared pool.

The configuration is an object of the following format:
```
mediasoup.dedicatedMediaTypeWorkers:
   audio: "auto"|"cores"|<Number>
   main: "auto"|"cores"|<Number>
   content: "auto"|"cores"|<Number>
```

The semantics of `auto`, `cores` and `Number` are the same as in the `mediasoup.workers` configuration. Default values for all media types are `0` (no dedicated workers).

The media types semantics are:
   * `audio`: audio (listen only, microphone) streams;
   * `main`: webcam video streams;
   * `content`: screen sharing streams (audio and video).

As always, this configuration should be set via the override file in `/etc/bigbluebutton/bbb-webrtc-sfu/production.yml`. For example:
   * To set the number of dedicated audio workers to `auto`: `yq w -i /etc/bigbluebutton/bbb-webrtc-sfu/production.yml mediasoup.dedicatedMediaTypeWorkers.audio "auto"`

