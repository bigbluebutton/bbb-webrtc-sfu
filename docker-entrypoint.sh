#!/bin/bash -e

if [ ! -z "$KURENTO_NAME" ]; then
    export KURENTO_IP=$(getent hosts $KURENTO_NAME | awk '{ print $1 }')
fi

exec "$@"
