FROM node:14

RUN apt-get update && apt-get install git
RUN apt-get install make python g++

ADD . app

WORKDIR app

ENV NODE_ENV development

RUN cp config/default.example.yml config/default.yml \
 && npm install --unsafe-perm \
 && npm cache clear --force

EXPOSE 3008

CMD [ "npm", "start" ]
