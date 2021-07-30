FROM node:14-alpine

RUN apk update && apk add git
RUN apk add --no-cache linux-headers make python g++

ADD . app

WORKDIR app

ENV NODE_ENV development

RUN cp config/default.example.yml config/production.yml \
 && npm install --unsafe-perm \
 && npm cache clear --force

EXPOSE 3008

CMD [ "npm", "start" ]
