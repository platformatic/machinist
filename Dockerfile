FROM node:22.13.1-alpine

ARG COMMIT_HASH
ARG BUILD_TIME

ENV PNPM_HOME=/home/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN mkdir $PNPM_HOME
RUN npm i pnpm@9 --location=global

ENV PLT_DEV_MODE="false"

WORKDIR /opt/app

COPY . .

RUN pnpm i

EXPOSE 3042

CMD ["pnpm", "start"]

LABEL org.opencontainers.image.authors=Platformatic
LABEL org.opencontainers.image.created=$BUILD_TIME
LABEL org.opencontainers.image.revision=$COMMIT_HASH
LABEL org.opencontainers.image.licenses=Apache-2.0
LABEL org.opencontainers.image.source=https://github.com/platformatic/machinist
LABEL org.opencontainers.image.title=Machinist
LABEL org.opencontainers.image.description=Minimal interface to Kubernetes for use by Platformatic Intelligent Command Center
