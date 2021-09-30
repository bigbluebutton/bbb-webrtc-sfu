 # Prometheus metrics

bbb-webrtc-sfu provides direct Prometheus instrumentation to one of its 5 modules/processes: **mcs-core**.

The underlying mechanisms of a Prometheus client as well as the default Node.js metrics come from https://github.com/siimon/prom-client.

## Enabling instrumentation

Prometheus instrumentation is **disabled by default**. There are two ways to enable it: via a configuration file or via environment variables.

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

## Exposed metrics: mcs-core

### General metrics

The current custom metric set exposed by _mcs-core_ itself, independent of media server adapters, is:

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

### Adapter: mediasoup

The mediasoup adapter exposes a few metrics on its own. Their format is shown here:

```
# HELP mcs_mediasoup_workers Active mediasoup workers
# TYPE mcs_mediasoup_workers gauge
mcs_mediasoup_workers 0

# HELP mcs_mediasoup_routers Active mediasoup routers
# TYPE mcs_mediasoup_routers gauge
mcs_mediasoup_routers 0

# HELP mcs_mediasoup_transports Number of active mediasoup transports
# TYPE mcs_mediasoup_transports gauge
mcs_mediasoup_transports{type="PlainTransport|WebRtcTransport|PipeTransport|DirectTransport"} 0

# HELP mcs_mediasoup_producers Number of active mediasoup producers
# TYPE mcs_mediasoup_producers gauge
mcs_mediasoup_producers{type="simple|simulcast|svc",kind="audio|video",transport_type="PlainTransport|WebRtcTransport|PipeTransport|DirectTransport"} 0

# HELP mcs_mediasoup_consumers Number of active mediasoup consumers
# TYPE mcs_mediasoup_consumers gauge
mcs_mediasoup_consumers{type="simple|simulcast|svc",kind="audio|video",transport_type="PlainTransport|WebRtcTransport|PipeTransport|DirectTransport"} 0

```
