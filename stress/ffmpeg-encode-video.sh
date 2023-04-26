#!/bin/bash

VIDEO_FILE=$1
RTP_PORT=$2
RTCP_PORT=$3

ffmpeg -re \
  -v info \
  -stream_loop -1 \
  -i ${VIDEO_FILE} \
  -pix_fmt yuv420p -an -c:v libvpx -b:v 100k -deadline realtime -cpu-used 1 -threads 1 \
  -f rtp -ssrc 12345678 -cname ff@mpeg rtp://127.0.0.1:${RTP_PORT}?pkt_size=1200?rtcpport=${RTCP_PORT}
