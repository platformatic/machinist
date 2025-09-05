FROM node:22.19.0-alpine

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
