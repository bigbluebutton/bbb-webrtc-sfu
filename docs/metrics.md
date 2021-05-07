 # Prometheus metrics

bbb-webrtc-sfu provides direct Prometheus instrumentation to one of its 5 modules/processes: **mcs-core**.

**mcs-core** core is the central module where all the media control plane logic eventually ends up into, so it makes sense that the instrumentation was implemented there first.


## Exposed metrics

The default Node.js application metrics come from https://github.com/siimon/prom-client.

The current custom metric set exposed by _mcs-core_ is:

```
# HELP mcs_rooms Number of active rooms in mcs-core
# TYPE mcs_rooms gauge
mcs_rooms 0

# HELP mcs_users Number of active users in mcs-core
# TYPE mcs_users gauge
mcs_users 0

# HELP mcs_media_sessions Number of active media sessions in mcs-core
# TYPE mcs_media_sessions gauge
mcs_media_sessions 0

# HELP mcs_media_units Number of active media units in mcs-core
# TYPE mcs_media_units gauge
mcs_media_units{media_type="main|audio|content",unit_type="WebRtcEndpoint|RtpEndpoint|RecorderEndpoint",direction="sendrecv|sendonly|recvonly"}

# HELP mcs_requests_total Total number of requests receive by mcs-core
# TYPE mcs_requests_total counter
mcs_requests_total{method="<method_name>"}

# HELP mcs_request_errors_total Total number of requests failures in mcs-core
# TYPE mcs_request_errors_total counter
mcs_request_errors_total{method="<method_name>"=errorCode:"<error_code>"}

```

An example scrape result (_with default metrics disabled_) looks like this:

```
# HELP mcs_rooms Number of active rooms in mcs-core
# TYPE mcs_rooms gauge
mcs_rooms 1

# HELP mcs_users Number of active users in mcs-core
# TYPE mcs_users gauge
mcs_users 4

# HELP mcs_media_sessions Number of active media sessions in mcs-core
# TYPE mcs_media_sessions gauge
mcs_media_sessions 3

# HELP mcs_media_units Number of active media units in mcs-core
# TYPE mcs_media_units gauge
mcs_media_units{media_type="main",unit_type="WebRtcEndpoint",direction="sendonly"} 1
mcs_media_units{media_type="main",unit_type="RecorderEndpoint",direction="sendrecv"} 1
mcs_media_units{media_type="main",unit_type="WebRtcEndpoint",direction="recvonly"} 1

# HELP mcs_requests_total Total number of requests receive by mcs-core
# TYPE mcs_requests_total counter
mcs_requests_total{method="onEvent"} 2528
mcs_requests_total{method="getRooms"} 2
mcs_requests_total{method="join"} 783
mcs_requests_total{method="getUsers"} 1793
mcs_requests_total{method="publish"} 54
mcs_requests_total{method="addIceCandidate"} 8075
mcs_requests_total{method="startRecording"} 36
mcs_requests_total{method="subscribe"} 734
mcs_requests_total{method="setContentFloor"} 13
mcs_requests_total{method="unsubscribe"} 729
mcs_requests_total{method="stopRecording"} 33
mcs_requests_total{method="getContentFloor"} 12
mcs_requests_total{method="releaseContentFloor"} 12
mcs_requests_total{method="unpublish"} 45
mcs_requests_total{method="leave"} 3

# HELP mcs_request_errors_total Total number of requests failures in mcs-core
# TYPE mcs_request_errors_total counter
mcs_request_errors_total{method="publish",errorCode="2003"} 2
```

## Enabling instrumentation

Prometheus instrumentation is **disabled by default**. There are two ways one can enable it: via a configuration file or via environment variables.

### Configuration file

In a regular BigBlueButton installation, an override config file can be used in `/etc/bigbluebutton/bbb-webrtc-sfu/production.yml`. There, one can alter the [default configuration](https://github.com/bigbluebutton/bbb-webrtc-sfu/blob/5e5b91a9f77be8971069fe661570d9cb423a2bb5/config/default.example.yml#L216-L227) as they wish.

For example: exposing metrics on HTTP endpoint `http://localhost:3014/metrics` (with Node.js metrics disabled) would look like this:

```
# Direct Prometheus instrumentation. Currently operating only over mcs-core.
# EXPERIMENTAL, so disabled by default.
prometheus:
  # Whether to enabled the metrics endpoint
  enabled: true
  # Scrape route host
  host: localhost
  # Scrape route port
  port: 3014
  # Metrics endpoint path
  path: '/metrics'
  # Whether default metrics for Node.js processes should be exported
  collectDefaultMetrics: false
```

Notice that the example has the default Node.js application metrics disabled by default (`collectDefaultMetrics: false`). That's because the performance footprint of that specific metric hasn't been assessed yet. For that reason,   **collectDefaultMetrics should only be used in controlled environments**.

### Environment variables

The configuration file parameters shown in the previous session all have equivalent environment variables that can be passed to the application. They are:

```
prometheus:
  enabled: MCS_PROM_ENABLED
  host: MCS_PROM_HOST
  port: MCS_PROM_PORT
  path: MCS_PROM_PATH
  collectDefaultMetrics: MCS_PROM_DEFAULT_MTS
``` 
